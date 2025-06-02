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

// --- Game Configuration ---
const ROUND_DURATION_MS = 10 * 1000; // 10 seconds per question

// --- Socket.IO Server Setup ---
const io = new Server(httpServer, {
    cors: {
        origin: "https://daily-quest.pages.dev", // Frontend URL without trailing slash
        methods: ["GET", "POST"]
    }
});

// --- Middleware ---
app.use(cors({
    origin: "https://daily-quest.pages.dev" // Frontend URL without trailing slash
}));
app.use(express.json()); // Enable parsing JSON request bodies

// Serve Socket.IO client library from the backend (if needed, though frontend usually fetches from CDN)
app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io-client/dist'));


// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in .env file! Please set it to your Gemini API key.");
    process.exit(1); // Exit if API key is missing
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" });

// --- In-memory Game State (for simplicity, NOT production-ready) ---
const rooms = {}; // roomId: { hostId, players: [], status, currentRound, maxRounds, currentQuestionIndex, questions: [], roundStartTime, answersReceived, difficulty, roundTimerId }
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
        // Create a shallow copy to avoid sending internal timer IDs
        const roomStateToSend = { ...room };
        delete roomStateToSend.roundTimerId; // Don't send internal timer ID to frontend
        io.to(roomId).emit('roomState', roomStateToSend);
        console.log(`Emitted roomUpdate for room ${roomId}. Current state:`, roomStateToSend);
    }
}

async function generateQuizQuestions(difficulty = 'easy') {
    // Add a random string to the prompt to encourage more diverse outputs
    const uniqueifier = Math.random().toString(36).substring(2, 7);
    const prompt = `Generate 5 unique trivia questions about general knowledge. For each question, provide exactly 4 distinct answer options (one correct, three incorrect).
    The difficulty is ${difficulty}.
    The response MUST be a JSON array of objects, with each object having:
    {
        "question": "The trivia question text",
        "correctAnswer": "The single correct answer",
        "answers": ["option 1", "option 2", "option 3", "option 4"]
    }
    Example:
    [
      {
        "question": "What is the capital of France?",
        "correctAnswer": "Paris",
        "answers": ["Paris", "London", "Rome", "Berlin"]
      },
      {
        "question": "Which planet is known as the Red Planet?",
        "correctAnswer": "Mars",
        "answers": ["Mars", "Venus", "Jupiter", "Saturn"]
      }
    ]
    Ensure the JSON is well-formed and nothing else is included in the response. (Request ID: ${uniqueifier})`;

    try {
        console.log(`Generating quiz questions with difficulty: ${difficulty}...`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        if (text.startsWith('```json')) {
            text = text.substring(7, text.lastIndexOf('```')).trim();
        }

        const questions = JSON.parse(text);
        console.log('Successfully generated quiz questions:', questions.length);
        return questions;
    } catch (error) {
        console.error('Failed to generate valid quiz questions from AI:', error);
        if (error.response && typeof error.response.text === 'function') {
            console.error("Problematic AI response (if available):", error.response.text());
        }
        // Fallback to default questions if AI generation fails
        return [
            {
                "question": "What is the capital of Japan?",
                "correctAnswer": "Tokyo",
                "answers": ["Tokyo", "Kyoto", "Osaka", "Seoul"]
            },
            {
                "question": "Which animal lays eggs?",
                "correctAnswer": "Chicken",
                "answers": ["Cow", "Chicken", "Dog", "Cat"]
            },
            {
                "question": "How many colors are in a rainbow?",
                "correctAnswer": "Seven",
                "answers": ["Five", "Six", "Seven", "Eight"]
            },
            {
                "question": "What is the largest ocean on Earth?",
                "correctAnswer": "Pacific Ocean",
                "answers": ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean", "Pacific Ocean"]
            },
            {
                "question": "What shape is a stop sign?",
                "correctAnswer": "Octagon",
                "answers": ["Circle", "Square", "Octagon", "Triangle"]
            }
        ];
    }
}

// Function to advance to the next question or end the game
function moveToNextQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Clear any existing timer for this round to prevent double-advancing
    if (room.roundTimerId) {
        clearTimeout(room.roundTimerId);
        room.roundTimerId = null;
    }

    const nextQuestionIndex = room.currentQuestionIndex + 1;

    if (nextQuestionIndex < room.questions.length && room.currentRound < room.maxRounds) {
        room.currentQuestionIndex = nextQuestionIndex;
        room.currentRound++;
        room.roundStartTime = Date.now(); // Reset timer for new question
        room.answersReceived = {}; // Reset answers for the new question
        room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for next round
        console.log(`Moved to question ${room.currentQuestionIndex + 1} in room ${roomId}.`);
        emitRoomState(roomId);

        // Set timer for the next question
        room.roundTimerId = setTimeout(() => {
            moveToNextQuestion(roomId);
        }, ROUND_DURATION_MS);

    } else {
        // Game finished
        room.status = 'finished';
        room.roundStartTime = null; // Clear timer
        console.log(`Game finished in room ${roomId}.`);
        emitRoomState(roomId); // Emit final state
        // Optionally, delete room after a delay
        setTimeout(() => {
            if (rooms[roomId]) { // Check if room still exists before deleting
                delete rooms[roomId];
                console.log(`Room ${roomId} deleted after game finish timeout.`);
                // io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room session ended.' }); // If you want to notify clients that room is gone
            }
        }, 30 * 1000); // Room will be deleted 30 seconds after game ends
    }
}


// --- REST API Endpoints (for initial user authentication/username update) ---

app.post('/api/auth/anonymous', (req, res) => {
    let userId = req.headers['x-user-id'];
    const { username } = req.body;

    if (!username || username.trim().length < 3) {
        return res.status(400).json({ message: 'Username is required and must be at least 3 characters long.' });
    }

    if (!userId || !users[userId]) {
        userId = uuidv4();
        users[userId] = { id: userId, username: username.trim(), socketId: null };
        console.log(`New user registered: ${username} (${userId})`);
    } else {
        users[userId].username = username.trim();
        console.log(`User ${userId} updated username to: ${username}`);
    }
    res.json({ userId: userId, username: users[userId].username });
});


// --- Socket.IO Event Handlers ---

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('registerUserSocket', (userId) => {
        if (users[userId]) {
            users[userId].socketId = socket.id;
            socket.userId = userId; // Attach userId to socket for easy lookup on disconnect
            console.log(`User ${users[userId].username} (${userId}) registered socket: ${socket.id}`);
        } else {
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
            const questions = await generateQuizQuestions(difficulty);
            if (!questions || questions.length === 0) {
                throw new Error('Failed to generate questions. Please try again.');
            }

            rooms[roomId] = {
                roomId: roomId,
                hostId: userId,
                players: [{ id: userId, username, score: 0, hasAnsweredCurrentRound: false, socketId: socket.id }], // Store socketId
                status: 'waiting', // waiting, playing, finished
                currentRound: 0,
                maxRounds: questions.length, // Number of questions determines max rounds
                currentQuestionIndex: -1, // No question active yet
                questions: questions,
                roundStartTime: null,
                answersReceived: {}, // userId: { answers: [], timestamp }
                difficulty: difficulty,
                roundTimerId: null // To store the setTimeout ID for clearing
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
            // Update socketId for existing player if they reconnected
            const existingPlayer = room.players.find(p => p.id === userId);
            if (existingPlayer) existingPlayer.socketId = socket.id;
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
        room.players.push({ id: userId, username, score: 0, hasAnsweredCurrentRound: false, socketId: socket.id });
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
        room.roundStartTime = Date.now(); // Start timer for the first question
        room.answersReceived = {}; // Reset answers for the new round
        room.players.forEach(p => { p.score = 0; p.hasAnsweredCurrentRound = false; }); // Reset scores and status

        emitRoomState(roomId);
        console.log(`Game started in room ${roomId}. First question displayed.`);

        // Set the timer for the first question
        room.roundTimerId = setTimeout(() => {
            moveToNextQuestion(roomId);
        }, ROUND_DURATION_MS);
    });

    // Handle player submitting answers
    socket.on('submitAnswer', ({ roomId, userId, round, answer }) => { // Changed to single 'answer' for simplicity
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
            socket.emit('error', 'You have already submitted an answer for this question.');
            return;
        }

        // Calculate score
        const currentQuestion = room.questions[room.currentQuestionIndex];
        let scoreEarned = 0;
        if (answer === currentQuestion.correctAnswer) {
            scoreEarned = 1; // 1 point for correct answer
        }

        player.score += scoreEarned;
        player.hasAnsweredCurrentRound = true;
        room.answersReceived[userId] = { answer: answer, score: scoreEarned, timestamp: Date.now() };

        socket.emit('answerSubmittedConfirmation', { scoreEarned: scoreEarned });
        emitRoomState(roomId);
        console.log(`Player ${player.username} submitted answer for round ${round}. Earned ${scoreEarned} points.`);

        // Check if all players have answered
        const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
        if (allPlayersAnswered) {
            console.log(`All players in room ${roomId} have answered round ${round}. Moving to next question.`);
            moveToNextQuestion(roomId); // Immediately move to next question if all answered
        }
    });

    // Handle leaving a room (used for both lobby and in-game leave)
    socket.on('leaveRoom', ({ roomId, userId }) => {
        if (!roomId || !userId) return;

        const room = rooms[roomId];
        if (room) {
            const playerIndex = room.players.findIndex(p => p.id === userId);
            if (playerIndex !== -1) {
                const leavingPlayer = room.players[playerIndex];
                room.players.splice(playerIndex, 1);
                socket.leave(roomId); // Remove socket from room

                // Clear any pending round timer if the host leaves or game ends due to leave
                if (room.roundTimerId) {
                    clearTimeout(room.roundTimerId);
                    room.roundTimerId = null;
                    console.log(`Cleared round timer for room ${roomId} due to player leave.`);
                }

                if (room.players.length === 0) {
                    delete rooms[roomId];
                    console.log(`Room ${roomId} deleted as all players left.`);
                    io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room deleted as all players left.' });
                } else {
                    if (room.hostId === userId) {
                        room.hostId = room.players[0] ? room.players[0].id : null;
                        console.log(`Host ${userId} left. New host for room ${roomId}: ${room.hostId}`);
                    }
                    if (room.status === 'playing' && room.players.length < 2) {
                         room.status = 'finished'; // If only one player left during game, end the game
                         console.log(`Game in room ${roomId} ended because only one player remained.`);
                    }
                    emitRoomState(roomId); // Broadcast updated room state to remaining players
                }
                console.log(`User ${leavingPlayer.username} (${userId}) left room ${roomId}.`);
            } else {
                console.log(`User ${userId} tried to leave room ${roomId} but was not found in players.`);
            }
        } else {
            console.log(`User ${userId} tried to leave room ${roomId} but room was not found.`);
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const disconnectedUserId = socket.userId;

        if (disconnectedUserId && users[disconnectedUserId]) {
            users[disconnectedUserId].socketId = null; // Clear the socketId from the user object
            console.log(`User ${users[disconnectedUserId].username} (${disconnectedUserId}) disconnected. Removing socket mapping.`);

            for (const roomId in rooms) {
                const room = rooms[roomId];
                const playerIndex = room.players.findIndex(p => p.id === disconnectedUserId);

                if (playerIndex !== -1) {
                    // For simplicity, if a player disconnects, they are considered to have left the room.
                    console.log(`User ${users[disconnectedUserId]?.username} disconnected from room ${roomId}. Removing.`);
                    room.players.splice(playerIndex, 1);

                    // Clear any pending round timer if the host leaves or game ends due to disconnect
                    if (room.roundTimerId) {
                        clearTimeout(room.roundTimerId);
                        room.roundTimerId = null;
                        console.log(`Cleared round timer for room ${roomId} due to disconnect.`);
                    }

                    if (room.players.length === 0) {
                        delete rooms[roomId];
                        console.log(`Room ${roomId} deleted as all players left on disconnect.`);
                        io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room deleted due to disconnects.' });
                    } else {
                        if (room.hostId === disconnectedUserId) {
                            room.hostId = room.players[0] ? room.players[0].id : null;
                            console.log(`Host ${disconnectedUserId} disconnected. New host for room ${roomId}: ${room.hostId}`);
                        }
                        if (room.status === 'playing' && room.players.length < 2) {
                            room.status = 'finished';
                            console.log(`Game in room ${roomId} ended due to player disconnect, only one player remains.`);
                        }
                        emitRoomState(roomId);
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