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
        origin: "https://daily-quest.pages.dev/", // Allow all origins for development. Restrict in production.
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
const rooms = {}; // roomId: { hostId, players: [], status, currentRound, maxRounds, currentQuestionIndex, questions: [], scores: {}, roundStartTime, answersReceived, difficulty }
const users = {}; // userId: { username, socketId } (Store socketId to send direct messages if needed)

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


// --- API Endpoints (some still for initial state, others replaced by Socket.IO) ---

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


// Create a new room
app.post('/api/rooms/create', async (req, res) => {
    const userId = req.headers['x-user-id'];
    const username = req.headers['x-username'];
    const difficulty = req.body.difficulty || 'medium';

    if (!userId || !users[userId]) {
        return res.status(401).json({ message: 'User not authenticated.' });
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
        scores: {}, // Overall game scores: { userId: score }
        roundStartTime: null,
        answersReceived: {}, // { userId: { round: N, answers: [] }}
        difficulty: difficulty,
    };

    // Join the host to the Socket.IO room
    const hostSocket = io.sockets.sockets.get(users[userId].socketId);
    if (hostSocket) {
        hostSocket.join(roomId);
        console.log(`User ${username} (${userId}) created and joined room ${roomId}`);
    } else {
        console.warn(`Host socket not found for user ${userId} when creating room ${roomId}`);
        // Consider error handling or forcing re-connection logic
    }

    emitRoomState(roomId); // Broadcast initial room state
    res.status(201).json({ message: 'Room created', roomId: roomId });
});

// Join an existing room
app.post('/api/rooms/join/:roomId', (req, res) => {
    const userId = req.headers['x-user-id'];
    const username = req.headers['x-username'];
    const roomId = req.params.roomId.toUpperCase();

    if (!userId || !users[userId]) {
        return res.status(401).json({ message: 'User not authenticated.' });
    }

    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.status !== 'waiting') {
        return res.status(400).json({ message: 'Cannot join game in progress or finished.' });
    }
    if (room.players.length >= 2) {
        return res.status(400).json({ message: 'Room is full (max 2 players).' });
    }
    if (room.players.some(p => p.id === userId)) {
        // User is already in the room, just re-add their socket to the room if needed
        const existingPlayerSocket = io.sockets.sockets.get(users[userId].socketId);
        if (existingPlayerSocket) {
            existingPlayerSocket.join(roomId);
        }
        console.log(`User ${username} (${userId}) re-joined room ${roomId}`);
        emitRoomState(roomId);
        return res.json({ message: 'Already in room', roomId: roomId });
    }

    const newPlayer = { id: userId, username: username, score: 0, hasAnsweredCurrentRound: false };
    room.players.push(newPlayer);
    room.scores[userId] = 0; // Initialize score for new player

    // Join the new player to the Socket.IO room
    const playerSocket = io.sockets.sockets.get(users[userId].socketId);
    if (playerSocket) {
        playerSocket.join(roomId);
        console.log(`User ${username} (${userId}) joined room ${roomId}`);
    } else {
        console.warn(`Player socket not found for user ${userId} when joining room ${roomId}`);
        // Consider error handling or forcing re-connection logic
    }

    emitRoomState(roomId); // Broadcast updated room state
    res.json({ message: 'Joined room', roomId: roomId });
});

// Leave a room
app.post('/api/rooms/:roomId/leave', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();

    if (!userId || !users[userId]) {
        return res.status(401).json({ message: 'User not authenticated.' });
    }

    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }

    // Remove player from room
    room.players = room.players.filter(p => p.id !== userId);
    // Remove from socket.io room
    const playerSocket = io.sockets.sockets.get(users[userId].socketId);
    if (playerSocket) {
        playerSocket.leave(roomId);
    }

    if (room.players.length === 0) {
        // If room is empty, delete it
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted as all players left.`);
        io.to(roomId).emit('roomDeleted', { roomId: roomId, message: 'Room deleted.' }); // Inform clients
        return res.json({ message: 'Room deleted.' });
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
        return res.json({ message: 'Left room successfully.' });
    }
});


// Start the game (only host)
app.post('/api/rooms/:roomId/start', async (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.hostId !== userId) {
        return res.status(403).json({ message: 'Only the host can start the game.' });
    }
    if (room.players.length < 2) {
        return res.status(400).json({ message: 'Need 2 players to start the game.' });
    }
    if (room.status === 'playing') {
        return res.status(400).json({ message: 'Game already in progress.' });
    }

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
    res.json({ message: 'Game started', room: room });
});


// Submit answer for current round
app.post('/api/rooms/:roomId/answer', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const { round, answers } = req.body;

    const room = rooms[roomId];

    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.status !== 'playing') {
        return res.status(400).json({ message: 'Game not in progress.' });
    }
    if (room.currentRound !== round) {
        return res.status(400).json({ message: 'Invalid round number.' });
    }

    const player = room.players.find(p => p.id === userId);
    if (!player) {
        return res.status(404).json({ message: 'Player not found in room.' });
    }
    if (player.hasAnsweredCurrentRound) {
        return res.status(400).json({ message: 'You have already submitted answers for this round.' });
    }

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

    res.json({ message: 'Answers submitted', scoreEarned: scoreEarned, room: room });
});


// Move to next round (only host should trigger this, or auto after time/all answers)
app.post('/api/rooms/:roomId/next-round', async (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.hostId !== userId) {
        return res.status(403).json({ message: 'Only the host can advance rounds.' });
    }
    if (room.status !== 'playing') {
        return res.status(400).json({ message: 'Game not in progress.' });
    }

    const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
    const roundDurationPassed = (Date.now() - room.roundStartTime) >= 15000; // 15 seconds

    if (!allPlayersAnswered && !roundDurationPassed) {
        return res.status(400).json({ message: 'Cannot advance round. Not all players have answered or time not up.' });
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
        res.json({ message: 'Moved to next round', room: room });
    } else {
        // Game finished
        room.status = 'finished';
        room.roundStartTime = null; // Clear timer
        console.log(`Game finished for room ${roomId}`);
        emitRoomState(roomId);
        res.json({ message: 'Game finished', room: room });
    }
});


// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // When a user connects, we need to associate their socket ID with their userId
    // This typically happens after they've authenticated/set their username
    // and the userId is sent from the client.
    socket.on('registerUserSocket', (userId) => {
        if (users[userId]) {
            users[userId].socketId = socket.id;
            console.log(`Socket ${socket.id} registered for user ${userId} (${users[userId].username})`);
            // Find if this user is in any active room and re-join their socket to that room
            for (const roomId in rooms) {
                const room = rooms[roomId];
                if (room.players.some(p => p.id === userId)) {
                    socket.join(roomId);
                    console.log(`User ${users[userId].username} (${userId}) re-joined Socket.IO room ${roomId}`);
                    emitRoomState(roomId); // Emit latest state in case they reconnected to an active game
                    break;
                }
            }
        } else {
            console.warn(`Attempted to register socket for unknown userId: ${userId}`);
            // Optionally, force client to re-authenticate or generate new user
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
                    // Here, we're removing them and cleaning up.
                    console.log(`User ${users[disconnectedUserId]?.username} disconnected from room ${roomId}. Removing.`);
                    room.players.splice(playerIndex, 1); // Remove player
                    delete room.scores[disconnectedUserId]; // Remove their score

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

    // Socket.IO custom events from frontend
    socket.on('leaveRoom', ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (room) {
            // This logic is already handled by the /api/rooms/:roomId/leave HTTP endpoint,
            // but we can also handle it here if the client directly emits this event.
            // For now, let's just make sure the socket leaves the room.
            socket.leave(roomId);
            console.log(`User ${userId} explicitly left Socket.IO room ${roomId}.`);
            // You might want to trigger the HTTP leave endpoint from client,
            // or duplicate the room cleanup logic here for a pure Socket.IO flow.
            // For simplicity, the existing HTTP endpoint is preferred for state changes.
            // The disconnect handler already cleans up if a socket connection is lost.
        }
    });

    socket.on('startGame', ({ roomId, userId }) => {
        // This should typically be an HTTP POST, but if emitted via socket
        // you'd have to replicate the start game logic here or call the internal API.
        // For current setup, the client calls /api/rooms/:roomId/start via HTTP,
        // which then triggers emitRoomState.
        console.warn(`startGame event received via socket, but preferred method is HTTP POST to /api/rooms/:roomId/start.`);
        // If you want this to be purely Socket.IO, move the logic from app.post('/api/rooms/:roomId/start') here.
    });

    socket.on('submitAnswer', ({ roomId, userId, round, answers }) => {
        const room = rooms[roomId];
        if (!room) {
            console.warn(`Room ${roomId} not found for submitAnswer from ${userId}.`);
            return;
        }
        const player = room.players.find(p => p.id === userId);
        if (!player || player.hasAnsweredCurrentRound || room.currentRound !== round || room.status !== 'playing') {
            console.warn(`Invalid submitAnswer for room ${roomId} by ${userId}.`);
            return;
        }

        const correctAnswers = room.currentQuestion.answers;
        const submittedAnswers = Array.isArray(answers) ? answers.map(a => String(a).toLowerCase().trim()) : [];

        let scoreEarned = 0;
        const matchedAnswers = new Set();
        submittedAnswers.forEach(submitted => {
            if (correctAnswers.includes(submitted) && !matchedAnswers.has(submitted)) {
                scoreEarned += 1;
                matchedAnswers.add(submitted);
            }
        });

        player.score += scoreEarned;
        player.hasAnsweredCurrentRound = true;

        room.answersReceived[userId] = {
            round: room.currentRound,
            answers: submittedAnswers,
            score: scoreEarned
        };
        console.log(`User ${player.username} submitted answers for room ${roomId}, round ${round}. Earned ${scoreEarned} points via Socket.IO.`);
        emitRoomState(roomId);
        // Optionally, send a confirmation to the specific user:
        socket.emit('answerSubmittedConfirmation', { scoreEarned: scoreEarned });
    });

    socket.on('nextRound', ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== userId || room.status !== 'playing') {
            console.warn(`Invalid nextRound request for room ${roomId} by ${userId}.`);
            return;
        }

        const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
        const roundDurationPassed = (Date.now() - room.roundStartTime) >= 15000;

        if (!allPlayersAnswered && !roundDurationPassed) {
            console.warn(`Cannot advance round for room ${roomId}. Not all players answered or time not up.`);
            return;
        }

        room.currentRound++;
        room.currentQuestionIndex++;

        if (room.currentRound <= room.maxRounds && room.currentQuestionIndex < room.questions.length) {
            room.currentQuestion = room.questions[room.currentQuestionIndex];
            room.roundStartTime = Date.now();
            room.answersReceived = {};
            room.players.forEach(p => p.hasAnsweredCurrentRound = false);

            console.log(`Room ${roomId}: Moving to round ${room.currentRound} via Socket.IO.`);
            emitRoomState(roomId);
        } else {
            room.status = 'finished';
            room.roundStartTime = null;
            console.log(`Game finished for room ${roomId} via Socket.IO.`);
            emitRoomState(roomId);
        }
    });

});


// Start the server
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});