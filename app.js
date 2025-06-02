require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

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
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- In-memory Game State (for simplicity, NOT production-ready) ---
// In a real app, you'd use a database like MongoDB, PostgreSQL, or Redis
const rooms = {}; // roomId: { hostId, users: [], status, currentQuestionIndex, questions: [], scores: {}, timerEndTime, answersReceived, difficulty }
const users = {}; // userId: { username }

// --- Helper Functions ---
function generateUniqueRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function generateQuizQuestion(difficulty) {
    const prompt = `Generate a unique, daily-basis quiz question. The question should be about common everyday activities, household items, general knowledge related to daily life, or simple practical scenarios. Provide 4 options, with one correct answer.
    Difficulty: ${difficulty}.
    Format the response as a JSON object with 'question', 'options' (an array of strings), and 'correct_answer' (the exact string of the correct option).`;

    try {
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
            },
        });
        const responseText = result.response.text();
        let questionData;
        try {
            const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                questionData = JSON.parse(jsonMatch[1]);
            } else {
                questionData = JSON.parse(responseText); // Assume pure JSON
            }
        } catch (parseError) {
            console.error("Failed to parse AI response JSON:", responseText, parseError);
            throw new Error("Invalid JSON from AI model.");
        }

        // Basic validation of AI response
        if (!questionData.question || !Array.isArray(questionData.options) || questionData.options.length === 0 || !questionData.correct_answer) {
            console.error("Malformed question data from AI:", questionData);
            throw new Error("AI returned malformed question data.");
        }

        return questionData;
    } catch (error) {
        console.error("Error generating question from Gemini:", error);
        throw error;
    }
}

// --- API Endpoints ---

// User Authentication (Simple Anonymous Login)
app.post('/api/auth/anonymous', (req, res) => {
    let userId = req.headers['x-user-id'];
    let username = req.headers['x-username'] || req.body.username;

    if (!userId || !users[userId]) {
        userId = uuidv4();
        users[userId] = { username: username || `Guest_${userId.substring(0, 6)}` };
    } else {
        // Update username if provided in body and different
        if (req.body.username && users[userId].username !== req.body.username) {
             users[userId].username = req.body.username;
        }
    }
    res.json({ userId: userId, username: users[userId].username });
});

// Update Username
app.post('/api/user/update-username', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { newUsername } = req.body;

    if (!userId || !users[userId]) {
        return res.status(401).json({ message: 'User not authenticated' });
    }
    if (!newUsername || newUsername.trim() === '') {
        return res.status(400).json({ message: 'New username cannot be empty' });
    }

    users[userId].username = newUsername.trim();
    res.json({ message: 'Username updated successfully', username: users[userId].username });
});


// Create Room
app.post('/api/rooms/create', (req, res) => {
    const userId = req.headers['x-user-id'];
    const username = req.headers['x-username'];
    const { difficulty } = req.body;

    if (!userId || !username) {
        return res.status(401).json({ message: 'User not authenticated' });
    }
    if (!difficulty) {
        return res.status(400).json({ message: 'Difficulty must be specified.' });
    }

    const roomId = generateUniqueRoomId();
    rooms[roomId] = {
        roomId: roomId,
        hostId: userId,
        users: [{ id: userId, username: username }],
        status: 'waiting',
        currentQuestionIndex: -1,
        questions: [],
        scores: { [userId]: 0 },
        timerEndTime: null,
        answersReceived: {},
        difficulty: difficulty
    };
    res.status(201).json(rooms[roomId]);
});

// Join Room
app.post('/api/rooms/join/:roomId', (req, res) => {
    const userId = req.headers['x-user-id'];
    const username = req.headers['x-username'];
    const roomId = req.params.roomId.toUpperCase();

    if (!userId || !username) {
        return res.status(401).json({ message: 'User not authenticated' });
    }

    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.users.length >= 2) {
        return res.status(400).json({ message: 'Room is full.' });
    }
    if (room.users.some(u => u.id === userId)) {
        return res.json(room); // Already in the room, return current state
    }

    room.users.push({ id: userId, username: username });
    room.scores[userId] = 0; // Initialize score for joining user
    res.json(room);
});

// Get Room State (for polling)
app.get('/api/rooms/:roomId', (req, res) => {
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    res.json(room);
});

// Start Game
app.post('/api/rooms/:roomId/start', async (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.hostId !== userId) {
        return res.status(403).json({ message: 'Only the host can start the game.' });
    }
    if (room.users.length < 2) {
        return res.status(400).json({ message: 'Need 2 players to start the game.' });
    }
    if (room.status !== 'waiting') {
        return res.status(400).json({ message: 'Game has already started or finished.' });
    }

    try {
        const numQuestions = 8; // "at least 8 answers"
        const generatedQuestions = [];
        for (let i = 0; i < numQuestions; i++) {
            const q = await generateQuizQuestion(room.difficulty);
            generatedQuestions.push(q);
        }

        room.status = 'playing';
        room.currentQuestionIndex = 0;
        room.questions = generatedQuestions;
        room.timerEndTime = Date.now() + 15000; // 15 seconds
        room.answersReceived = {}; // Reset for the first question
        // Scores are already initialized when users join

        res.json({ message: 'Game started!', room: room });
    } catch (error) {
        console.error('Error starting game:', error);
        res.status(500).json({ message: 'Failed to start game: ' + error.message });
    }
});

// Answer Question
app.post('/api/rooms/:roomId/answer', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const { questionIndex, answer } = req.body;

    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.status !== 'playing') {
        return res.status(400).json({ message: 'Game is not in progress.' });
    }
    if (room.currentQuestionIndex !== questionIndex) {
        return res.status(400).json({ message: 'Not the current question.' });
    }
    if (room.answersReceived[userId] !== undefined) {
        return res.status(400).json({ message: 'You have already answered this question.' });
    }

    const currentQuestion = room.questions[room.currentQuestionIndex];
    if (!currentQuestion) {
        return res.status(500).json({ message: 'Current question data is missing.' });
    }

    room.answersReceived[userId] = answer;

    // Logic for "first user to answer gets the point"
    const answeredUsers = Object.keys(room.answersReceived);
    if (answer === currentQuestion.correct_answer) {
        // If this user is the *first* to answer correctly
        const correctAnswersCount = Object.values(room.answersReceived).filter(a => a === currentQuestion.correct_answer).length;

        // This check is a simple way to approximate "first correct answer" for an in-memory game.
        // A more robust solution for competitive play would involve timestamps or locking.
        if (correctAnswersCount === 1) { // If this is the first correct answer received for this question
            room.scores[userId] = (room.scores[userId] || 0) + 1;
        }
    }

    // After all players (2) have answered or timer expires (handled by polling on frontend), move to next question.
    // The client-side polling will detect updates to answersReceived and trigger next question logic if host.
    res.json({ message: 'Answer received', room: room });
});


// Move to next question (only host should trigger this or timer)
app.post('/api/rooms/:roomId/next-question', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) return res.status(404).json({ message: 'Room not found.' });
    // This endpoint should ideally only be triggered by the host or an automated timer mechanism
    // For simplicity, we'll let the frontend polling mechanism manage transitions after answers/timer.
    // The /api/rooms/:roomId/answer endpoint already updates room.answersReceived and scores.
    // The frontend host logic will call this when needed.

    const nextQuestionIndex = room.currentQuestionIndex + 1;
    if (nextQuestionIndex < room.questions.length) {
        room.currentQuestionIndex = nextQuestionIndex;
        room.timerEndTime = Date.now() + 15000; // Reset timer for new question
        room.answersReceived = {}; // Reset answers for the new question
        res.json({ message: 'Moved to next question', room: room });
    } else {
        room.status = 'finished';
        res.json({ message: 'Game finished', room: room });
    }
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});