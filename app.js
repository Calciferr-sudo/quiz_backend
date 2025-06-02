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
        origin: "https://daily-quest.pages.dev", // NO TRAILING SLASH HERE
        methods: ["GET", "POST"]
    }
});

// --- Middleware ---
app.use(cors({
    origin: "https://daily-quest.pages.dev" // NO TRAILING SLASH HERE
}));
app.use(express.json()); // Enable parsing JSON request bodies

// Serve Socket.IO client library from the backend
app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io-client/dist'));


// --- Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in .env file!");
    process.exit(1); // Exit if API key is missing
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- In-memory Game State (for simplicity, NOT production-ready) ---
const rooms = {}; // roomId: { hostId, users: [], status, currentQuestionIndex, questions: [], scores: {}, timerEndTime, answersReceived, difficulty }
const users = {}; // userId: { username }

// --- Helper Functions ---
function generateUniqueRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Function to emit room state to all players in a room
function emitRoomState(roomId) {
    const room = rooms[roomId];
    if (room) {
        io.to(roomId).emit('roomState', room);
        console.log(`Emitted roomState for room ${roomId}. Status: ${room.status}`);
    }
}

// Timer management on backend
const ROOM_TIMERS = {}; // Stores setInterval IDs for each room

function startRoomTimer(roomId) {
    if (ROOM_TIMERS[roomId]) {
        clearInterval(ROOM_TIMERS[roomId]);
    }

    const room = rooms[roomId];
    if (!room || room.status !== 'playing') {
        return;
    }

    // Set a timer for the current round
    room.roundStartTime = Date.now(); // Set the start time of the round
    room.roundEndTime = room.roundStartTime + (room.roundDuration * 1000); // Calculate end time based on duration

    emitRoomState(roomId); // Emit immediately so clients get the new roundStartTime

    ROOM_TIMERS[roomId] = setInterval(() => {
        const now = Date.now();
        if (now >= room.roundEndTime) {
            clearInterval(ROOM_TIMERS[roomId]);
            console.log(`Timer for room ${roomId} ended.`);
            moveToNextQuestion(roomId);
        } else {
            // Optional: emit minor updates if needed, but client-side timer handles visual countdown
        }
    }, 1000); // Check every second
}

function stopRoomTimer(roomId) {
    if (ROOM_TIMERS[roomId]) {
        clearInterval(ROOM_TIMERS[roomId]);
        delete ROOM_TIMERS[roomId];
        console.log(`Timer for room ${roomId} stopped.`);
    }
}


async function getQuestions(difficulty) {
    try {
        const prompt = `Generate 5 multiple-choice quiz questions about general knowledge.
Each question should have 4 options, and clearly indicate the correct answer.
The questions should be suitable for a quiz game.
Difficulty: ${difficulty}.
Format the output as a JSON array of objects, like this:
[
  {
    "question": "What is the capital of France?",
    "options": ["Berlin", "Madrid", "Paris", "Rome"],
    "correctAnswer": "Paris"
  }
]`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log("Generated Questions Raw Text:", text);

        // Attempt to extract JSON from the text, as model might wrap it
        const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch && jsonMatch[0]) {
            return JSON.parse(jsonMatch[0]);
        } else {
            console.error("Could not extract JSON from Gemini response:", text);
            throw new Error("Failed to parse questions from AI. Invalid format.");
        }
    } catch (error) {
        console.error("Error generating questions:", error);
        return [];
    }
}

function moveToNextQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.currentQuestionIndex++;
    room.answersReceived = {}; // Reset for the new round
    room.players.forEach(p => p.hasAnsweredCurrentRound = false); // Reset answer status for players

    if (room.currentQuestionIndex < room.questions.length) {
        console.log(`Moving to question ${room.currentQuestionIndex + 1} in room ${roomId}`);
        room.status = 'playing'; // Ensure status is playing
        startRoomTimer(roomId); // Restart timer for next question
    } else {
        console.log(`Game finished in room ${roomId}.`);
        room.status = 'finished';
        stopRoomTimer(roomId); // Stop timer when game is finished
    }
    emitRoomState(roomId);
}


// --- API Endpoints ---

// User authentication/registration (simple anonymous user)
app.post('/api/auth/anonymous', (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 3) {
        return res.status(400).json({ message: 'Username must be at least 3 characters.' });
    }
    const userId = uuidv4();
    users[userId] = { id: userId, username: username };
    console.log(`User ${username} (${userId}) registered.`);
    res.json({ userId, username });
});

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected via Socket.IO:', socket.id);

    // Store socket.id to userId mapping
    socket.on('registerUserSocket', (userId) => {
        if (users[userId]) {
            users[userId].socketId = socket.id;
            console.log(`User ${userId} registered socket ${socket.id}`);
        } else {
            // If user not found, force them to re-authenticate
            socket.emit('forceAuth', 'User not found. Please re-authenticate.');
        }
    });

    socket.on('createRoom', async (data) => {
        const { userId, username, difficulty } = data;
        if (!userId || !username) {
            return socket.emit('error', { message: 'User ID and username required to create room.' });
        }
        if (!users[userId] || users[userId].username !== username) {
            return socket.emit('forceAuth', 'User authentication mismatch. Please re-enter your username.');
        }

        let roomId;
        do {
            roomId = generateUniqueRoomId();
        } while (rooms[roomId]);

        const questions = await getQuestions(difficulty);
        if (questions.length === 0) {
            return socket.emit('error', { message: 'Failed to generate quiz questions. Please try again.' });
        }

        rooms[roomId] = {
            roomId: roomId,
            hostId: userId,
            players: [{ id: userId, username: username, socketId: socket.id, score: 0, hasAnsweredCurrentRound: false }],
            status: 'waiting',
            currentQuestionIndex: 0,
            questions: questions,
            maxRounds: questions.length,
            scores: { [userId]: 0 }, // Initialize host's score
            roundDuration: 15, // Seconds
            roundStartTime: null, // Will be set when game starts/moves to next question
            answersReceived: {} // Tracks who answered in current round
        };

        socket.join(roomId);
        console.log(`Room ${roomId} created by ${username} (${userId}).`);
        socket.emit('roomCreated', { roomId: roomId });
        emitRoomState(roomId); // Send initial room state
    });

    socket.on('joinRoom', (data) => {
        const { roomId, userId, username } = data;
        const room = rooms[roomId];

        if (!userId || !username) {
            return socket.emit('error', { message: 'User ID and username required to join room.' });
        }
        if (!users[userId] || users[userId].username !== username) {
            return socket.emit('forceAuth', 'User authentication mismatch. Please re-enter your username.');
        }

        if (!room) {
            return socket.emit('error', { message: 'Room not found.' });
        }
        if (room.players.length >= 2) {
            return socket.emit('error', { message: 'Room is full.' });
        }
        if (room.status !== 'waiting') {
            return socket.emit('error', { message: 'Game has already started or finished in this room.' });
        }

        // Check if user is already in the room
        if (!room.players.some(p => p.id === userId)) {
            room.players.push({ id: userId, username: username, socketId: socket.id, score: 0, hasAnsweredCurrentRound: false });
            room.scores[userId] = 0; // Initialize score for new player
        } else {
            // If user re-joins, update their socketId
            const existingPlayer = room.players.find(p => p.id === userId);
            if (existingPlayer) {
                existingPlayer.socketId = socket.id;
            }
        }

        socket.join(roomId);
        console.log(`${username} (${userId}) joined room ${roomId}.`);
        emitRoomState(roomId); // Broadcast updated room state
    });

    socket.on('startGame', (data) => {
        const { roomId, userId } = data;
        const room = rooms[roomId];

        if (!room) {
            return socket.emit('error', { message: 'Room not found.' });
        }
        if (room.hostId !== userId) {
            return socket.emit('error', { message: 'Only the host can start the game.' });
        }
        if (room.players.length < 2) {
            return socket.emit('error', { message: 'Need at least 2 players to start.' });
        }
        if (room.status === 'playing') {
            return socket.emit('error', { message: 'Game already started.' });
        }

        room.status = 'playing';
        room.currentQuestionIndex = 0;
        room.answersReceived = {}; // Clear previous answers
        room.players.forEach(p => p.hasAnsweredCurrentRound = false);
        console.log(`Game started in room ${roomId}`);
        startRoomTimer(roomId); // Start the timer for the first question
    });

    socket.on('leaveRoom', (data) => {
        const { roomId, userId } = data;
        const room = rooms[roomId];

        if (room) {
            room.players = room.players.filter(p => p.id !== userId);
            socket.leave(roomId);
            console.log(`User ${userId} left room ${roomId}.`);

            // If room is empty, delete it and stop timer
            if (room.players.length === 0) {
                delete rooms[roomId];
                stopRoomTimer(roomId);
                console.log(`Room ${roomId} deleted as all players left.`);
                io.to(userId).emit('roomDeleted', { message: `Room ${roomId} has been deleted.` }); // Inform the leaving user
            } else {
                // If host left, assign new host
                if (room.hostId === userId) {
                    room.hostId = room.players[0] ? room.players[0].id : null;
                    console.log(`Host ${userId} disconnected. New host for room ${roomId}: ${room.hostId}`);
                }
                // If game was playing and now only one player remains, end game
                if (room.status === 'playing' && room.players.length < 2) {
                    room.status = 'finished';
                    stopRoomTimer(roomId);
                    console.log(`Game in room ${roomId} ended due to player disconnect.`);
                }
                emitRoomState(roomId); // Broadcast updated room state to remaining players
            }
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', socket.id, 'Reason:', reason);
        // Find user by disconnected socket ID and clean up
        for (const userId in users) {
            if (users[userId].socketId === socket.id) {
                console.log(`User ${userId} (${users[userId].username}) disconnected.`);
                // In a real app, you might track active sockets or have a more robust cleanup
                // For now, we rely on leaveRoom explicitly or next connection for re-registration
                break;
            }
        }
        // If a player disconnects during a game, you might want to mark them as inactive
        // or end the game if critical player disconnects. This is handled partially in leaveRoom.
    });
});


// --- REST API Endpoints (for non-realtime operations like answer submission) ---

app.post('/api/rooms/:roomId/answer', async (req, res) => {
    const { userId, answer, round } = req.body;
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.status !== 'playing') {
        return res.status(400).json({ message: 'Game is not in progress.' });
    }
    if (room.currentQuestionIndex !== round) { // 'round' here means currentQuestionIndex
        return res.status(400).json({ message: 'Answer for previous/future round.' });
    }

    const player = room.players.find(p => p.id === userId);
    if (!player) {
        return res.status(404).json({ message: 'Player not found in room.' });
    }
    if (player.hasAnsweredCurrentRound) {
        return res.status(400).json({ message: 'You have already submitted an answer for this round.' });
    }

    const currentQuestion = room.questions[room.currentQuestionIndex];
    if (!currentQuestion) {
        return res.status(500).json({ message: 'No current question available.' });
    }

    const isCorrect = answer === currentQuestion.correctAnswer;
    let scoreEarned = 0;

    if (isCorrect) {
        scoreEarned = 1; // Award 1 point for correct answer
        room.scores[userId] = (room.scores[userId] || 0) + scoreEarned;
    }

    room.answersReceived[userId] = { answer: answer, isCorrect: isCorrect, submittedAt: Date.now() };
    player.hasAnsweredCurrentRound = true;

    // Emit confirmation to the submitting player (optional, roomState will update scoreboard)
    io.to(player.socketId).emit('answerSubmittedConfirmation', { scoreEarned: scoreEarned, isCorrect: isCorrect });

    // Check if all players have answered
    const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);

    if (allPlayersAnswered) {
        console.log(`All players in room ${roomId} have answered. Moving to next question.`);
        stopRoomTimer(roomId); // Stop current timer
        moveToNextQuestion(roomId); // Immediately move to next question
    } else {
        // If not all players answered, just update room state for scoreboard
        emitRoomState(roomId);
    }

    res.json({ message: 'Answer received', room: room });
});


// Start the server
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});