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
const rooms = {}; // roomId: { hostId, users: [], status, currentQuestionIndex, questions: [], scores: {}, timerEndTime, answersReceived, difficulty }
const users = {}; // userId: { username }

// --- Helper Functions ---
function generateUniqueRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function generateQuizQuestions(difficulty = 'easy') {
    // Add a random string to the prompt to encourage more diverse outputs
    const uniqueifier = Math.random().toString(36).substring(2, 7);
    const prompt = `Generate 5 multiple-choice quiz questions about general knowledge, each with 4 answer options (one correct, three incorrect). The questions should be suitable for a ${difficulty} difficulty level. Ensure the correct answer is always unique among the options and strictly provide the output as a JSON array of objects. Include diverse topics. (Request ID: ${uniqueifier})

    Example format:
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
    `;

    try {
        console.log(`Generating quiz questions with difficulty: ${difficulty}...`);
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();

        // Attempt to clean and parse the JSON, as AI output can sometimes be wrapped
        if (text.startsWith('```json')) {
            text = text.substring(7, text.lastIndexOf('```')).trim();
        }

        const questions = JSON.parse(text);
        console.log('Successfully generated quiz questions:', questions.length);
        return questions;
    } catch (error) {
        console.error('Failed to generate valid quiz questions from AI:', error);
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

function emitRoomState(roomId) {
    const room = rooms[roomId];
    if (room) {
        const roomStateToSend = { ...room };
        delete roomStateToSend.sockets;

        io.to(roomId).emit('roomState', roomStateToSend);
        console.log(`Emitted roomUpdate for room ${roomId}. Current state:`, roomStateToSend);
    }
}

// --- API Endpoints ---

// User authentication/creation (anonymous login)
app.post('/api/auth/anonymous', (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 3) {
        return res.status(400).json({ message: 'Username is required and must be at least 3 characters long.' });
    }
    const userId = uuidv4();
    users[userId] = { id: userId, username };
    console.log(`User created: ${username} with ID ${userId}`);
    res.json({ userId, username });
});

// Create a new room
app.post('/api/rooms', async (req, res) => {
    const hostId = req.headers['x-user-id'];
    const username = req.headers['x-username'];
    const { difficulty } = req.body;

    if (!hostId || !username) {
        return res.status(401).json({ message: 'Authentication required to create a room.' });
    }

    const roomId = generateUniqueRoomId();
    const questions = await generateQuizQuestions(difficulty);

    rooms[roomId] = {
        roomId,
        hostId,
        players: [{ id: hostId, username: username, score: 0, hasAnsweredCurrentRound: false }],
        status: 'waiting',
        currentRound: 0,
        maxRounds: questions.length > 0 ? questions.length : 5,
        currentQuestionIndex: -1,
        questions: questions,
        roundStartTime: null,
        answersReceived: {},
        difficulty: difficulty || 'easy'
    };

    console.log(`Room created: ${roomId} by ${username} (Host: ${hostId}) with difficulty ${difficulty}`);
    emitRoomState(roomId);
    res.status(201).json({ roomId, message: 'Room created successfully!' });
});

// Join a room
app.post('/api/rooms/join', (req, res) => {
    const userId = req.headers['x-user-id'];
    const username = req.headers['x-username'];
    const { roomId: requestedRoomId } = req.body;
    const roomId = requestedRoomId.toUpperCase();

    if (!userId || !username) {
        return res.status(401).json({ message: 'Authentication required to join a room.' });
    }

    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }

    if (room.status !== 'waiting') {
        return res.status(400).json({ message: 'Cannot join: Game has already started or finished in this room.' });
    }

    if (room.players.some(p => p.id === userId)) {
        return res.status(200).json({ message: 'Already in room.', roomId });
    }

    room.players.push({ id: userId, username: username, score: 0, hasAnsweredCurrentRound: false });
    console.log(`User ${username} (${userId}) joined room ${roomId}.`);
    emitRoomState(roomId);
    res.json({ message: 'Joined room successfully!', roomId });
});

// Leave a room
app.post('/api/rooms/:roomId/leave', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) {
        // If room not found, it's already gone or never existed.
        // This is fine, just confirm to the client.
        console.log(`Attempted to leave room ${roomId} but it was not found on server.`);
        return res.status(200).json({ message: 'Room already left or does not exist.' });
    }

    const initialPlayerCount = room.players.length;
    room.players = room.players.filter(player => player.id !== userId);
    const playerRemoved = room.players.length < initialPlayerCount;

    if (playerRemoved) {
        console.log(`User ${users[userId]?.username} left room ${roomId}.`);
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
                room.status = 'finished';
                console.log(`Game in room ${roomId} ended due to player disconnect, only one player remains.`);
            }
            emitRoomState(roomId);
        }
        res.json({ message: 'Left room successfully!' });
    } else {
        // User was not found in the room's player list
        res.status(400).json({ message: 'You are not in this room.' });
    }
});


// Start the game
app.post('/api/rooms/:roomId/start', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.hostId !== userId) return res.status(403).json({ message: 'Only the host can start the game.' });
    if (room.status !== 'waiting') return res.status(400).json({ message: 'Game already started or finished.' });
    if (room.players.length < 2) return res.status(400).json({ message: 'Need at least 2 players to start the game.' });
    if (room.questions.length === 0) return res.status(500).json({ message: 'No questions generated for this room. Cannot start game.' });

    room.status = 'playing';
    room.currentRound = 1;
    room.currentQuestionIndex = 0;
    room.roundStartTime = Date.now() + 3000;
    room.answersReceived = {};
    room.players.forEach(p => p.hasAnsweredCurrentRound = false);

    console.log(`Game started in room ${roomId}. First question displayed.`);
    emitRoomState(roomId);
    res.json({ message: 'Game started successfully!' });
});

// Submit an answer
app.post('/api/rooms/:roomId/answer', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const { answer } = req.body;
    const room = rooms[roomId];

    if (!room) return res.status(404).json({ message: 'Room not found.' });
    if (room.status !== 'playing') return res.status(400).json({ message: 'Game is not active.' });

    const player = room.players.find(p => p.id === userId);
    if (!player) return res.status(404).json({ message: 'Player not found in room.' });
    if (player.hasAnsweredCurrentRound) return res.status(400).json({ message: 'You have already answered this question.' });

    const currentQuestion = room.questions[room.currentQuestionIndex];
    if (!currentQuestion) return res.status(500).json({ message: 'No current question available.' });

    room.answersReceived[userId] = answer;
    player.hasAnsweredCurrentRound = true;

    if (answer === currentQuestion.correctAnswer) {
        player.score = (player.score || 0) + 1;
        console.log(`Player ${player.username} answered correctly. Score: ${player.score}`);
    } else {
        console.log(`Player ${player.username} answered incorrectly. Correct was: ${currentQuestion.correctAnswer}`);
    }

    emitRoomState(roomId);

    const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
    if (allPlayersAnswered) {
        console.log(`All players in room ${roomId} have answered. Preparing for next round.`);
        setTimeout(() => {
            moveToNextQuestion(roomId);
        }, 3000);
    }

    res.json({ message: 'Answer received', room: room });
});

function moveToNextQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const nextQuestionIndex = room.currentQuestionIndex + 1;

    if (nextQuestionIndex < room.questions.length && room.currentRound < room.maxRounds) {
        room.currentQuestionIndex = nextQuestionIndex;
        room.currentRound++;
        room.roundStartTime = Date.now() + 3000;
        room.answersReceived = {};
        room.players.forEach(p => p.hasAnsweredCurrentRound = false);
        console.log(`Moved to question ${room.currentQuestionIndex + 1} in room ${roomId}.`);
        emitRoomState(roomId);
    } else {
        room.status = 'finished';
        room.roundStartTime = null;
        console.log(`Game finished in room ${roomId}.`);
        emitRoomState(roomId);
    }
}


// Handle Socket.IO connections
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('joinRoomSocket', ({ roomId, userId }) => {
        const room = rooms[roomId];
        if (room) {
            socket.join(roomId);
            console.log(`${userId} joined Socket.IO room: ${roomId}`);
            // Update the socket.id in the room's player list if it's different from the userId
            // This is crucial for disconnect logic to work correctly with the actual socket.id
            const playerInRoom = room.players.find(p => p.id === userId);
            if (playerInRoom) {
                // If the player exists, update their socket ID to the current one
                // This handles cases where a user reconnects with a new socket.id but same userId
                playerInRoom.socketId = socket.id; // Store socket.id for disconnect tracking
            } else {
                // This case should ideally not happen if /api/rooms/join was used first,
                // but as a fallback, add player to room if socket joins directly.
                const username = users[userId]?.username || `Guest-${userId.substring(0,4)}`;
                room.players.push({ id: userId, username: username, score: 0, hasAnsweredCurrentRound: false, socketId: socket.id });
                console.log(`Added missing player ${username} to room data for ${roomId}`);
            }
            emitRoomState(roomId);
        } else {
            socket.emit('roomDeleted', { roomId: roomId, message: 'Room does not exist or was deleted.' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            // Find player by socket.id now, as userId might persist across reconnections
            const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                const disconnectedPlayer = room.players[playerIndex];
                console.log(`User ${disconnectedPlayer.username || disconnectedPlayer.id} disconnected from room ${roomId}. Removing.`);
                room.players.splice(playerIndex, 1);

                if (room.players.length === 0) {
                    delete rooms[roomId];
                    console.log(`Room ${roomId} deleted as all players left on disconnect.`);
                    // No need to emit to room, as it's empty. Rely on client-side roomDeleted event.
                } else {
                    if (room.hostId === disconnectedPlayer.id) {
                        room.hostId = room.players[0] ? room.players[0].id : null;
                        console.log(`Host ${disconnectedPlayer.id} disconnected. New host for room ${roomId}: ${room.hostId}`);
                    }
                    if (room.status === 'playing' && room.players.length < 2) {
                        room.status = 'finished';
                        console.log(`Game in room ${roomId} ended due to player disconnect, only one player remains.`);
                    }
                    emitRoomState(roomId);
                }
            }
        }
    });
});


// Start the server
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});