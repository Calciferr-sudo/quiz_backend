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
        origin: "*", // Allow all origins for development. Restrict in production.
        methods: ["GET", "POST"]
    }
});

// --- Middleware ---
app.use(cors()); // Allow cross-origin requests from your frontend
app.use(express.json()); // Enable parsing JSON request bodies

// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in .env file!");
    process.exit(1); // Exit if API key is missing
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Ensure you are using the correct model name
const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });


// --- In-memory Game State (for simplicity, NOT production-ready) ---
// In a real app, you'd use a database like MongoDB, PostgreSQL, or Redis
// Rooms: { roomId: { hostId, players: [], status, currentRound, maxRounds, currentQuestionIndex, questions: [], roundStartTime, answersReceived, difficulty } }
const rooms = {};
// Users: { userId: { username, socketId } } (Store socketId to send direct messages if needed)
const users = {};

// --- Helper Functions ---
function generateUniqueRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase(); // 6-character ID
}

async function generateQuizQuestion(difficulty) {
    const prompt = `Generate a "8 items" quiz question based on a specific category. The user will list 8 items belonging to that category.
    
    Difficulty: ${difficulty}
    
    Format the output as a JSON object with two keys:
    "question": "The question asking for 8 items.",
    "answers": ["item1", "item2", "item3", "item4", "item5", "item6", "item7", "item8"] (Case-insensitive matching for answers. Provide the exact 8 answers.)
    
    Example (for a different difficulty):
    {"question": "List 8 US states that border Canada.", "answers": ["Alaska", "Idaho", "Maine", "Michigan", "Minnesota", "Montana", "New York", "North Dakota", "Ohio", "Pennsylvania", "Vermont", "Washington", "Wisconsin"]}

    Your response must ONLY be the JSON object. Do not include any other text or markdown outside the JSON.
    `;

    try {
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        console.log("Gemini Raw Response:", responseText); // Log the raw response

        // Attempt to parse JSON. Gemini sometimes includes markdown, so robust parsing is needed.
        let jsonString = responseText.replace(/```json\s*|```\s*/g, '').trim();
        const parsed = JSON.parse(jsonString);

        if (!parsed.question || !Array.isArray(parsed.answers) || parsed.answers.length !== 8) {
            console.error("Generated question has invalid format:", parsed);
            // Fallback or retry
            return {
                question: "Error generating question. Please try again.",
                answers: []
            };
        }
        // Normalize answers to lowercase for case-insensitive matching
        parsed.answers = parsed.answers.map(a => a.toLowerCase());
        return parsed;

    } catch (error) {
        console.error("Error generating quiz question:", error.response?.text() || error.message);
        return {
            question: "Failed to generate question. Try again or check API key.",
            answers: []
        };
    }
}

// Function to broadcast room state to all players in that room
function emitRoomState(roomId) {
    const room = rooms[roomId];
    if (room) {
        // Create a copy of the room state to send, without sensitive info like exact answers
        const roomStateForClients = {
            roomId: room.roomId,
            hostId: room.hostId,
            status: room.status,
            currentRound: room.currentRound,
            maxRounds: room.maxRounds,
            players: room.players.map(p => ({
                id: p.id,
                username: p.username,
                score: p.score,
                hasAnsweredCurrentRound: p.hasAnsweredCurrentRound // Indicate if player has submitted answer
            })),
            currentQuestion: room.currentQuestion ? { question: room.currentQuestion.question } : null,
            roundStartTime: room.roundStartTime,
            // Do NOT send room.questions[currentQuestionIndex].answers
            // Do NOT send room.answersReceived directly as it contains submitted answers
            // The score is calculated and sent per player in `players` array
        };
        io.to(roomId).emit('roomUpdate', roomStateForClients);
    }
}


// --- API Endpoints (for initial user authentication/username updates) ---

// User authentication/creation
app.post('/api/auth/anonymous', (req, res) => {
    let userId = req.headers['x-user-id'];
    let username = req.headers['x-username'] || req.body.username;

    if (!userId || !users[userId]) {
        // If no user ID or user not found, create a new anonymous user
        userId = uuidv4();
        username = username || `Guest-${Math.floor(Math.random() * 1000)}`;
        users[userId] = { id: userId, username: username, socketId: null }; // socketId will be set on connection
        console.log(`New anonymous user created: ${username} (${userId})`);
    } else if (username && users[userId].username !== username) {
        // Update username if provided and different
        users[userId].username = username;
        console.log(`User ${userId} updated username to ${username}`);
    }

    res.json({ userId: userId, username: users[userId].username });
});

// Update username
app.post('/api/user/update-username', (req, res) => {
    const userId = req.headers['x-user-id'];
    const newUsername = req.body.newUsername;

    if (!userId || !users[userId]) {
        return res.status(404).json({ message: 'User not found.' });
    }
    if (!newUsername || newUsername.trim().length < 3) {
        return res.status(400).json({ message: 'Username must be at least 3 characters long.' });
    }

    users[userId].username = newUsername.trim();
    res.json({ userId: userId, username: users[userId].username });
});


// --- Socket.IO Connection and Game Event Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Register user with their socket ID
    socket.on('registerUserSocket', (userId) => {
        if (users[userId]) {
            users[userId].socketId = socket.id;
            console.log(`Socket ${socket.id} registered for user ${userId} (${users[userId].username})`);
            // If the user was already in a room (e.g., reconnected), rejoin their socket to that room
            for (const roomId in rooms) {
                const room = rooms[roomId];
                if (room.players.some(p => p.id === userId)) {
                    socket.join(roomId);
                    console.log(`User ${users[userId].username} (${userId}) re-joined Socket.IO room ${roomId}`);
                    emitRoomState(roomId); // Emit latest state to reconnected client
                    break;
                }
            }
        } else {
            console.warn(`Attempted to register socket for unknown userId: ${userId}. Client should re-authenticate.`);
            socket.emit('forceAuth'); // Tell client to go back to auth screen
        }
    });

    // Create a new room
    socket.on('createRoom', async (data) => {
        const { userId, username, difficulty } = data;
        if (!userId || !users[userId]) {
            socket.emit('error', 'User not authenticated.');
            return;
        }

        const roomId = generateUniqueRoomId();
        const player = { id: userId, username: username, score: 0, hasAnsweredCurrentRound: false };

        rooms[roomId] = {
            roomId: roomId,
            hostId: userId,
            players: [player],
            status: 'waiting', // waiting, playing, finished
            currentRound: 1,
            maxRounds: 5, // Max 5 rounds
            currentQuestionIndex: 0,
            questions: [], // Will be loaded on game start
            roundStartTime: null,
            answersReceived: {}, // { userId: { round: N, answers: [] }}
            difficulty: difficulty,
        };

        socket.join(roomId); // Host joins the Socket.IO room
        console.log(`User ${username} (${userId}) created and joined room ${roomId}`);
        socket.emit('roomCreated', { roomId: roomId }); // Inform host
        emitRoomState(roomId); // Broadcast initial room state
    });

    // Join an existing room
    socket.on('joinRoom', (data) => {
        const { userId, username, roomId } = data;

        if (!userId || !users[userId]) {
            socket.emit('error', 'User not authenticated.');
            return;
        }

        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found.');
            return;
        }
        if (room.status !== 'waiting') {
            socket.emit('error', 'Cannot join game in progress or finished.');
            return;
        }
        if (room.players.length >= 2) {
            socket.emit('error', 'Room is full (max 2 players).');
            return;
        }
        if (room.players.some(p => p.id === userId)) {
            // User is already in the room
            socket.join(roomId);
            console.log(`User ${username} (${userId}) re-joined room ${roomId}`);
            emitRoomState(roomId);
            return;
        }

        const newPlayer = { id: userId, username: username, score: 0, hasAnsweredCurrentRound: false };
        room.players.push(newPlayer);

        socket.join(roomId); // Player joins the Socket.IO room
        console.log(`User ${username} (${userId}) joined room ${roomId}`);
        emitRoomState(roomId); // Broadcast updated room state
    });

    // Leave a room
    socket.on('leaveRoom', (data) => {
        const { userId, roomId } = data;

        const room = rooms[roomId];
        if (!room) return; // Room already gone or invalid

        room.players = room.players.filter(p => p.id !== userId);
        socket.leave(roomId); // Remove from socket.io room

        if (room.players.length === 0) {
            // If room is empty, delete it
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted as all players left.`);
            io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room deleted.' }); // Inform clients
        } else {
            // If host leaves, assign new host (for simplicity, first player)
            if (room.hostId === userId) {
                room.hostId = room.players[0] ? room.players[0].id : null;
                if (room.hostId) {
                    console.log(`Host ${userId} left. New host for room ${roomId}: ${room.hostId}`);
                }
            }
            console.log(`User ${userId} left room ${roomId}.`);
            emitRoomState(roomId); // Broadcast updated room state
        }
    });

    // Start the game (only host)
    socket.on('startGame', async (data) => {
        const { userId, roomId } = data;
        const room = rooms[roomId];

        if (!room) { socket.emit('error', 'Room not found.'); return; }
        if (room.hostId !== userId) { socket.emit('error', 'Only the host can start the game.'); return; }
        if (room.players.length < 2) { socket.emit('error', 'Need 2 players to start the game.'); return; }
        if (room.status === 'playing') { socket.emit('error', 'Game already in progress.'); return; }

        // Generate all questions upfront
        for (let i = 0; i < room.maxRounds; i++) {
            const questionData = await generateQuizQuestion(room.difficulty);
            room.questions.push(questionData);
        }

        room.status = 'playing';
        room.currentRound = 1;
        room.currentQuestionIndex = 0;
        room.currentQuestion = room.questions[0];
        room.roundStartTime = Date.now();
        room.answersReceived = {}; // Reset answers for the first round
        room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for all players

        console.log(`Game started for room ${roomId}`);
        emitRoomState(roomId); // Broadcast updated room state
    });

    // Submit answer for current round
    socket.on('submitAnswer', (data) => {
        const { userId, roomId, round, answers } = data;
        const room = rooms[roomId];

        if (!room) { socket.emit('error', 'Room not found.'); return; }
        if (room.status !== 'playing') { socket.emit('error', 'Game not in progress.'); return; }
        if (room.currentRound !== round) { socket.emit('error', 'Invalid round number.'); return; }

        const player = room.players.find(p => p.id === userId);
        if (!player) { socket.emit('error', 'Player not found in room.'); return; }
        if (player.hasAnsweredCurrentRound) { socket.emit('error', 'You have already submitted answers for this round.'); return; }

        const correctAnswers = room.currentQuestion.answers; // Already lowercased
        const submittedAnswers = Array.isArray(answers) ? answers.map(a => String(a).toLowerCase().trim()) : [];

        let scoreEarned = 0;
        const matchedAnswers = new Set(); // To prevent duplicate scoring for the same correct answer

        submittedAnswers.forEach(submitted => {
            if (correctAnswers.includes(submitted) && !matchedAnswers.has(submitted)) {
                scoreEarned += 1;
                matchedAnswers.add(submitted);
            }
        });

        // Update player's score
        player.score += scoreEarned;
        player.hasAnsweredCurrentRound = true; // Mark player as answered

        room.answersReceived[userId] = {
            round: room.currentRound,
            answers: submittedAnswers,
            score: scoreEarned
        }; // Store answers and score

        console.log(`User ${player.username} submitted answers for room ${roomId}, round ${round}. Earned ${scoreEarned} points.`);
        emitRoomState(roomId); // Broadcast updated room state
        socket.emit('answerSubmittedConfirmation', { scoreEarned: scoreEarned }); // Confirmation to the specific player
    });


    // Move to next round (only host should trigger this, or auto after time/all answers)
    socket.on('nextRound', async (data) => {
        const { userId, roomId } = data;
        const room = rooms[roomId];

        if (!room) { socket.emit('error', 'Room not found.'); return; }
        if (room.hostId !== userId) { socket.emit('error', 'Only the host can advance rounds.'); return; }
        if (room.status !== 'playing') { socket.emit('error', 'Game not in progress.'); return; }

        const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
        const roundDuration = 15000; // 15 seconds
        const roundDurationPassed = (Date.now() - room.roundStartTime) >= roundDuration;

        if (!allPlayersAnswered && !roundDurationPassed) {
            socket.emit('error', 'Cannot advance round. Not all players have answered or time not up.');
            return;
        }

        room.currentRound++;
        room.currentQuestionIndex++;

        if (room.currentRound <= room.maxRounds && room.currentQuestionIndex < room.questions.length) {
            // Move to next question
            room.currentQuestion = room.questions[room.currentQuestionIndex];
            room.roundStartTime = Date.now(); // Reset timer for new round
            room.answersReceived = {}; // Reset answers for the new round
            room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for all players

            console.log(`Room ${roomId}: Moving to round ${room.currentRound}`);
            emitRoomState(roomId);
        } else {
            // Game finished
            room.status = 'finished';
            room.roundStartTime = null; // Clear timer
            console.log(`Game finished for room ${roomId}`);
            emitRoomState(roomId);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Find which user this socket belonged to
        let disconnectedUserId = null;
        for (const userId in users) {
            if (users[userId].socketId === socket.id) {
                disconnectedUserId = userId;
                users[userId].socketId = null; // Clear socket ID
                console.log(`User ${users[disconnectedUserId]?.username} (${disconnectedUserId}) lost socket connection.`);
                break;
            }
        }

        if (disconnectedUserId) {
            // Check if this user was in any room and update state or remove
            for (const roomId in rooms) {
                const room = rooms[roomId];
                const playerIndex = room.players.findIndex(p => p.id === disconnectedUserId);

                if (playerIndex !== -1) {
                    // For simplicity, if a player disconnects, they are considered to have left the room.
                    // In a real game, you might mark them as 'disconnected' or 'inactive' and allow reconnect.
                    console.log(`User ${users[disconnectedUserId]?.username} disconnected from room ${roomId}. Removing.`);
                    room.players.splice(playerIndex, 1); // Remove player

                    if (room.players.length === 0) {
                        delete rooms[roomId];
                        console.log(`Room ${roomId} deleted as all players left on disconnect.`);
                        io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room deleted due to disconnects.' });
                    } else {
                        // If host disconnected, assign new host
                        if (room.hostId === disconnectedUserId) {
                            room.hostId = room.players[0] ? room.players[0].id : null;
                            console.log(`Host ${disconnectedUserId} disconnected. New host for room ${roomId}: ${room.hostId}`);
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