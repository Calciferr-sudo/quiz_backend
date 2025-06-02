require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const http = require('http'); // Required for Socket.IO
const { Server } = require('socket.io'); // Socket.IO server
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const httpServer = http.createServer(app); // Create HTTP server for Express and Socket.IO
const PORT = process.env.PORT || 3000;

// --- Socket.IO Server Setup ---
const io = new Server(httpServer, {
    cors: {
        origin: "https://daily-quest.pages.dev/", // Allow all origins for development. Restrict in production to your Cloudflare Pages URL.
        methods: ["GET", "POST"]
    }
});

// --- Middleware ---
app.use(cors()); // Allow cross-origin requests from your frontend
app.use(express.json()); // Enable parsing JSON request bodies

// Serve Socket.IO client library from the backend
app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io-client/dist'));


// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in .env file!");
    // In a production environment, you might want to return an error page or just log and not exit immediately
    // but for development, exiting is fine if the key is crucial.
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" });


// --- In-memory Game State (for simplicity, NOT production-ready) ---
// In a real app, you'd use a database like MongoDB, PostgreSQL, or Redis
const rooms = {}; // roomId: { hostId, players: [], status, currentRound, maxRounds, currentQuestionIndex, questions: [], roundStartTime, answersReceived, difficulty }
const users = {}; // userId: { username, socketId } - Keep track of user's current socket ID

// --- Helper Functions ---
function generateUniqueRoomId() {
    let roomId;
    do {
        roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (rooms[roomId]); // Ensure ID is unique
    return roomId;
}

// Emits the current state of a specific room to all connected clients in that room
function emitRoomState(roomId) {
    const room = rooms[roomId];
    if (room) {
        io.to(roomId).emit('roomUpdate', room);
        console.log(`Emitted roomUpdate for room ${roomId}. Current state:`, room);
    }
}

// **FIXED: More robust question generation and parsing**
async function getQuestions(difficulty = 'medium') {
    const prompt = `Generate 5 unique trivia questions about general knowledge. For each question, provide exactly 8 distinct answers.
    The difficulty is ${difficulty}.
    Each question should have one correct answer and 7 incorrect answers.
    The response MUST be a JSON array of objects, with each object having:
    {
        "question": "The trivia question text",
        "correct_answer": "The single correct answer",
        "incorrect_answers": ["incorrect answer 1", "incorrect answer 2", ..., "incorrect answer 7"]
    }
    Example:
    [
        {
            "question": "What is the capital of France?",
            "correct_answer": "Paris",
            "incorrect_answers": ["Berlin", "Rome", "Madrid", "London", "Brussels", "Amsterdam", "Lisbon"]
        }
    ]
    Ensure the JSON is well-formed and nothing else is included in the response.`;

    try {
        const result = await model.generateContent(prompt);
        // It's possible the model wraps the JSON in markdown fences, e.g., ```json...```
        // We need to parse this out before JSON.parse
        const textResponse = result.response.text();
        const jsonString = textResponse.replace(/```json|```/g, '').trim();

        console.log("Raw AI response text:", textResponse); // For debugging
        console.log("Cleaned JSON string:", jsonString); // For debugging

        // Attempt to parse the JSON string
        let questions = JSON.parse(jsonString);

        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error("AI did not return a valid array of questions.");
        }

        // Transform the questions into the desired format for the game (one question with 8 answers)
        return questions.map(q => {
            const allAnswers = [q.correct_answer, ...q.incorrect_answers];
            // Shuffle all answers to randomize position of correct answer
            for (let i = allAnswers.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [allAnswers[i], allAnswers[j]] = [allAnswers[j], allAnswers[i]];
            }

            return {
                question: q.question,
                correctAnswer: q.correct_answer, // Store the correct answer separately for scoring
                answers: allAnswers // This array contains all 8 options (not directly used by textarea frontend, but good for robust structure)
            };
        });

    } catch (error) {
        console.error("Error generating or parsing questions:", error.message);
        // Attempt to log the full response object if available, which might contain more details
        if (error.response && typeof error.response.text === 'function') {
            console.error("Problematic AI response (if available):", error.response.text());
        }
        throw new Error("Failed to generate valid quiz questions from AI. " + error.message);
    }
}


// --- REST API Endpoints (for initial user authentication/username update) ---

// Anonymous login/user registration
app.post('/api/auth/anonymous', (req, res) => {
    let userId = req.headers['x-user-id'];
    const { username } = req.body;

    if (!username || username.trim().length < 3) {
        return res.status(400).json({ message: 'Username is required and must be at least 3 characters long.' });
    }

    if (!userId || !users[userId]) {
        // New user or unrecognized userId
        userId = uuidv4();
        users[userId] = { id: userId, username: username.trim(), socketId: null };
        console.log(`New user registered: ${username} (${userId})`);
    } else {
        // Existing user updating username or re-authenticating
        users[userId].username = username.trim();
        console.log(`User ${userId} updated username to: ${username}`);
    }
    res.json({ userId: userId, username: users[userId].username });
});


// Update existing username
app.post('/api/user/update-username', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { newUsername } = req.body;

    if (!userId || !users[userId]) {
        return res.status(401).json({ message: 'User not authenticated or found.' });
    }
    if (!newUsername || newUsername.trim().length < 3) {
        return res.status(400).json({ message: 'New username is required and must be at least 3 characters long.' });
    }

    users[userId].username = newUsername.trim();
    console.log(`User ${userId} updated username to: ${newUsername}`);
    res.json({ userId: userId, username: users[userId].username });
});


// --- Socket.IO Event Handlers ---

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Register user's socket ID with their userId
    socket.on('registerUserSocket', (userId) => {
        if (users[userId]) {
            users[userId].socketId = socket.id;
            socket.userId = userId; // Attach userId to socket for easy lookup on disconnect
            console.log(`User ${users[userId].username} (${userId}) registered socket: ${socket.id}`);
        } else {
            // If userId isn't recognized, prompt for re-auth
            socket.emit('forceAuth', 'User ID not found or invalid. Please re-authenticate.');
            console.warn(`Attempted to register unregistered userId: ${userId}`);
        }
    });

    // Handle room creation
    socket.on('createRoom', async ({ userId, username, difficulty }) => {
        if (!userId || !username) {
            socket.emit('error', 'Authentication required to create a room.');
            return;
        }
        if (!difficulty) {
            socket.emit('error', 'Difficulty is required to create a room.');
            return;
        }

        const roomId = generateUniqueRoomId();
        console.log(`User ${username} (${userId}) attempting to create room ${roomId} with difficulty ${difficulty}`);

        try {
            const questions = await getQuestions(difficulty);
            if (!questions || questions.length === 0) {
                throw new Error('Failed to generate questions. Please try again.');
            }

            rooms[roomId] = {
                roomId: roomId,
                hostId: userId,
                players: [{ id: userId, username, score: 0, hasAnsweredCurrentRound: false }],
                status: 'waiting', // waiting, playing, finished
                currentRound: 0,
                maxRounds: questions.length, // Number of questions determines max rounds
                currentQuestionIndex: -1, // No question active yet
                questions: questions,
                roundStartTime: null,
                answersReceived: {}, // userId: { answers: [], timestamp }
                difficulty: difficulty
            };

            socket.join(roomId);
            socket.emit('roomCreated', { roomId: roomId }); // Inform creator
            emitRoomState(roomId); // Broadcast initial state

            console.log(`Room ${roomId} created by ${username} with ${questions.length} questions.`);
        } catch (error) {
            console.error(`Error creating room for ${username}:`, error.message);
            socket.emit('error', `Failed to create room: ${error.message}`);
        }
    });

    // Handle joining a room
    socket.on('joinRoom', ({ userId, username, roomId }) => {
        if (!userId || !username) {
            socket.emit('error', 'Authentication required to join a room.');
            return;
        }
        if (!roomId) {
            socket.emit('error', 'Room ID is required to join a room.');
            return;
        }

        roomId = roomId.toUpperCase();
        const room = rooms[roomId];

        if (!room) {
            socket.emit('error', 'Room not found.');
            return;
        }
        if (room.players.some(p => p.id === userId)) {
            // Player already in room, just re-join their socket to the room
            socket.join(roomId);
            emitRoomState(roomId); // Re-send current state
            socket.emit('error', 'You are already in this room.'); // Inform user
            return;
        }
        if (room.players.length >= 2) {
            socket.emit('error', 'Room is full (max 2 players).');
            return;
        }
        if (room.status !== 'waiting') {
            socket.emit('error', 'Cannot join a game that has already started or finished.');
            return;
        }

        // Add new player to room
        room.players.push({ id: userId, username, score: 0, hasAnsweredCurrentRound: false });
        socket.join(roomId);
        emitRoomState(roomId);
        console.log(`User ${username} (${userId}) joined room ${roomId}.`);
    });

    // Handle starting the game
    socket.on('startGame', ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found.');
            return;
        }
        if (room.hostId !== userId) {
            socket.emit('error', 'Only the host can start the game.');
            return;
        }
        if (room.players.length < 2) {
            socket.emit('error', 'Need at least 2 players to start the game.');
            return;
        }
        if (room.status !== 'waiting') {
            socket.emit('error', 'Game has already started or finished.');
            return;
        }

        room.status = 'playing';
        room.currentRound = 1;
        room.currentQuestionIndex = 0;
        room.roundStartTime = Date.now(); // Start timer
        room.answersReceived = {}; // Reset answers for the new round
        room.players.forEach(p => { p.score = 0; p.hasAnsweredCurrentRound = false; }); // Reset scores and status

        emitRoomState(roomId);
        console.log(`Game started in room ${roomId}. First question displayed.`);
    });

    // Handle player submitting answers
    socket.on('submitAnswer', ({ roomId, userId, round, answers }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found.');
            return;
        }
        if (room.status !== 'playing' || room.currentRound !== round) {
            socket.emit('error', 'Cannot submit answers for this round/game state.');
            return;
        }
        const player = room.players.find(p => p.id === userId);
        if (!player) {
            socket.emit('error', 'Player not found in room.');
            return;
        }
        if (player.hasAnsweredCurrentRound) {
            socket.emit('error', 'You have already submitted answers for this round.');
            return;
        }

        // Calculate score
        const currentQuestion = room.questions[room.currentQuestionIndex];
        let scoreEarned = 0;
        const correctAnswersSet = new Set(currentQuestion.correctAnswer.split(/[\n, ]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 0));

        answers.forEach(submittedAnswer => {
            if (correctAnswersSet.has(submittedAnswer.toLowerCase())) {
                scoreEarned++;
            }
        });

        player.score += scoreEarned;
        player.hasAnsweredCurrentRound = true;
        room.answersReceived[userId] = { answers: answers, score: scoreEarned, timestamp: Date.now() };

        socket.emit('answerSubmittedConfirmation', { scoreEarned: scoreEarned });
        emitRoomState(roomId);
        console.log(`Player ${player.username} submitted answers for round ${round}. Earned ${scoreEarned} points.`);

        // Check if all players have answered
        const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
        if (allPlayersAnswered) {
            console.log(`All players in room ${roomId} have answered round ${round}.`);
            // The host or a timer will trigger nextRound
        }
    });

    // Handle moving to the next round (only host or automated timer)
    socket.on('nextRound', ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found.');
            return;
        }
        if (room.hostId !== userId) {
            socket.emit('error', 'Only the host can advance to the next round.');
            return;
        }
        if (room.status !== 'playing') {
            socket.emit('error', 'Game is not in playing state.');
            return;
        }
        // Ensure round ended either by time or all players answered
        const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
        const roundDuration = 15000; // 15 seconds
        const roundEndedByTime = (Date.now() - room.roundStartTime) >= roundDuration;

        if (!allPlayersAnswered && !roundEndedByTime) {
            socket.emit('error', 'Not all players have answered or round time has not ended yet.');
            return;
        }


        const nextQuestionIndex = room.currentQuestionIndex + 1;

        if (nextQuestionIndex < room.questions.length) {
            room.currentQuestionIndex = nextQuestionIndex;
            room.currentRound++; // Increment round number
            room.roundStartTime = Date.now(); // Reset timer for new question
            room.answersReceived = {}; // Reset answers for the new question
            room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for next round
            emitRoomState(roomId);
            console.log(`Room ${roomId} moved to round ${room.currentRound}.`);
        } else {
            // Game over
            room.status = 'finished';
            emitRoomState(roomId);
            console.log(`Game finished in room ${roomId}.`);
            // Optionally, delete room after a delay or move to a results state
            // setTimeout(() => {
            //     delete rooms[roomId];
            //     io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room session ended.' });
            //     console.log(`Room ${roomId} deleted after game finish.`);
            // }, 60000); // Delete room after 1 minute
        }
    });

    // Handle leaving a room
    socket.on('leaveRoom', ({ roomId, userId }) => {
        if (!roomId || !userId) return;

        const room = rooms[roomId];
        if (room) {
            const playerIndex = room.players.findIndex(p => p.id === userId);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                socket.leave(roomId); // Remove socket from room

                if (room.players.length === 0) {
                    delete rooms[roomId];
                    console.log(`Room ${roomId} deleted as all players left.`);
                    // No need to emit roomDeleted to the room if it's empty
                    // but if there were other players, they'd get roomUpdate.
                    // For a full delete, you'd emit to all users who were in it.
                } else {
                    // If host left, assign new host
                    if (room.hostId === userId) {
                        room.hostId = room.players[0] ? room.players[0].id : null;
                        console.log(`Host ${userId} left. New host for room ${roomId}: ${room.hostId}`);
                    }
                    if (room.status === 'playing' && room.players.length < 2) {
                         // If only one player left during game, end the game
                         room.status = 'finished';
                         console.log(`Game in room ${roomId} ended because only one player remained.`);
                    }
                    emitRoomState(roomId); // Broadcast updated room state to remaining players
                }
                console.log(`User ${users[userId]?.username} (${userId}) left room ${roomId}.`);
            }
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const disconnectedUserId = socket.userId; // Retrieve userId attached to socket

        if (disconnectedUserId && users[disconnectedUserId]) {
            // Clear the socketId from the user object
            users[disconnectedUserId].socketId = null;
            console.log(`User ${users[disconnectedUserId].username} (${disconnectedUserId}) disconnected. Removing socket mapping.`);

            // Check if the user was in any room and remove them
            for (const roomId in rooms) {
                const room = rooms[roomId];
                const playerIndex = room.players.findIndex(p => p.id === disconnectedUserId);

                if (playerIndex !== -1) {
                    // For simplicity, if a player disconnects, they are considered to have left the room.
                    console.log(`User ${users[disconnectedUserId]?.username} disconnected from room ${roomId}. Removing.`);
                    room.players.splice(playerIndex, 1); // Remove player

                    if (room.players.length === 0) {
                        delete rooms[roomId];
                        console.log(`Room ${roomId} deleted as all players left on disconnect.`);
                        // It's tricky to emit to a room that's just been deleted.
                        // You could emit to individual sockets who *were* in the room if they're still connected.
                        // For now, rely on frontend redirecting if roomUpdate stops coming.
                    } else {
                        // If host disconnected, assign new host
                        if (room.hostId === disconnectedUserId) {
                            room.hostId = room.players[0] ? room.players[0].id : null;
                            console.log(`Host ${disconnectedUserId} disconnected. New host for room ${roomId}: ${room.hostId}`);
                        }
                        if (room.status === 'playing' && room.players.length < 2) {
                            room.status = 'finished'; // End game if opponent disconnects
                            console.log(`Game in room ${roomId} ended due to player disconnect, only one player remains.`);
                        }
                        emitRoomState(roomId); // Broadcast updated room state to remaining players
                    }
                }
            }
        }
    });
});


// Start the server
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});