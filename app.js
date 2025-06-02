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
// This line might not be strictly necessary if your frontend links to a CDN for socket.io-client
app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io-client/dist'));

// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in .env file! Please set it to your Gemini API key.");
    process.exit(1); // Exit if API key is missing
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// IMPORTANT: Ensure you are using a currently available and recommended model
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" }); 
// You can also try "gemini-1.5-flash" if "gemini-2.0-flash-001" has issues.

// --- In-memory Game State (for simplicity, NOT production-ready) ---
// In a real app, you'd use a database like MongoDB, PostgreSQL, or Redis
const rooms = {}; // roomId: { hostId, users: [], status, currentQuestionIndex, questions: [], scores: {}, timerEndTime, answersReceived, difficulty }
const users = {}; // userId: { username }

// --- Helper Functions ---
function generateUniqueRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function generateQuizQuestions(difficulty = 'easy') {
    const prompt = `Generate 5 multiple-choice quiz questions about general knowledge, each with 4 answer options (one correct, three incorrect). The questions should be suitable for a ${difficulty} difficulty level. Ensure the correct answer is always unique among the options and strictly provide the output as a JSON array of objects.

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
        // Create a copy of the room state to avoid sending sensitive data or modifying original
        const roomStateToSend = { ...room };
        // Remove individual player sockets info if any from the state sent to clients
        delete roomStateToSend.sockets; 

        // Mask correct answers if the game is in progress and sending to non-host players
        // (You might already handle this on the frontend or decide not to send correct answer until round end)
        // For now, we'll send everything as is, rely on frontend to only display what's needed.

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
    const questions = await generateQuizQuestions(difficulty); // Generate questions on room creation

    rooms[roomId] = {
        roomId,
        hostId,
        players: [{ id: hostId, username: username, score: 0, hasAnsweredCurrentRound: false }],
        status: 'waiting', // waiting, playing, finished
        currentRound: 0,
        maxRounds: questions.length > 0 ? questions.length : 5, // Max rounds based on generated questions
        currentQuestionIndex: -1, // -1 before game starts
        questions: questions,
        roundStartTime: null,
        answersReceived: {}, // userId: answer
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
    const roomId = requestedRoomId.toUpperCase(); // Ensure uppercase

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

    // Check if player is already in the room
    if (room.players.some(p => p.id === userId)) {
        return res.status(200).json({ message: 'Already in room.', roomId });
    }

    // Add player to room
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
        return res.status(404).json({ message: 'Room not found.' });
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
            // If the host left, assign a new host
            if (room.hostId === userId) {
                room.hostId = room.players[0] ? room.players[0].id : null;
                console.log(`Host ${userId} left. New host for room ${roomId}: ${room.hostId}`);
            }
            // If game was playing and now only one player remains, end the game
            if (room.status === 'playing' && room.players.length < 2) {
                room.status = 'finished';
                console.log(`Game in room ${roomId} ended due to player disconnect, only one player remains.`);
            }
            emitRoomState(roomId); // Broadcast updated room state
        }
        res.json({ message: 'Left room successfully!' });
    } else {
        res.status(400).json({ message: 'User not found in this room.' });
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
    room.currentQuestionIndex = 0; // Start with the first question
    room.roundStartTime = Date.now() + 3000; // Give 3 seconds countdown before timer starts (for frontend sync)
    room.answersReceived = {}; // Reset for the first question
    room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for all players

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

    // Check if the answer is correct and update score
    if (answer === currentQuestion.correctAnswer) {
        player.score = (player.score || 0) + 1; // Assuming 1 point per correct answer
        console.log(`Player ${player.username} answered correctly. Score: ${player.score}`);
    } else {
        console.log(`Player ${player.username} answered incorrectly. Correct was: ${currentQuestion.correctAnswer}`);
    }

    emitRoomState(roomId); // Emit update after answer received

    // If all players have answered or timer is up, move to next question/round end
    // This logic can be more robust, potentially handled by a server-side timer or host action
    const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
    if (allPlayersAnswered) {
        console.log(`All players in room ${roomId} have answered. Preparing for next round.`);
        
        // Short delay before moving to next question to allow frontend to show answers
        setTimeout(() => {
            moveToNextQuestion(roomId);
        }, 3000); // Wait 3 seconds
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
        room.roundStartTime = Date.now() + 3000; // Reset timer for new question (with 3s countdown)
        room.answersReceived = {}; // Reset answers for the new question
        room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for all players
        console.log(`Moved to question ${room.currentQuestionIndex + 1} in room ${roomId}.`);
        emitRoomState(roomId);
    } else {
        // Game finished
        room.status = 'finished';
        room.roundStartTime = null; // Clear timer
        console.log(`Game finished in room ${roomId}.`);
        emitRoomState(roomId); // Emit final state
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
            // Ensure player is actually in the room's data structure
            if (!room.players.some(p => p.id === userId)) {
                 // This case should ideally not happen if /api/rooms/join was used first,
                 // but as a fallback, add player to room if socket joins directly.
                const username = users[userId]?.username || `Guest-${userId.substring(0,4)}`;
                room.players.push({ id: userId, username: username, score: 0, hasAnsweredCurrentRound: false });
                console.log(`Added missing player ${username} to room data for ${roomId}`);
                emitRoomState(roomId); // Emit update if player was added
            } else {
                emitRoomState(roomId); // Just emit current state if already in room
            }
        } else {
            // If room doesn't exist on server, inform client
            socket.emit('roomDeleted', { roomId: roomId, message: 'Room does not exist or was deleted.' });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Find which room the disconnected socket was in
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id); // Assuming socket.id is stored as userId in players
            if (playerIndex !== -1) {
                const disconnectedUserId = room.players[playerIndex].id; // Get the actual userId from the room's player list

                if (playerIndex !== -1) {
                    // For simplicity, if a player disconnects, they are considered to have left the room.
                    console.log(`User ${users[disconnectedUserId]?.username || disconnectedUserId} disconnected from room ${roomId}. Removing.`);
                    room.players.splice(playerIndex, 1); // Remove player from room

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
                        // If game was playing and now only one player remains, end the game
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