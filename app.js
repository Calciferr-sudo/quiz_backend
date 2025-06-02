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
// room: { roomId, hostId, players: [{ id, username, score, hasAnsweredCurrentRound }],
//         status, currentRound, maxRounds, currentQuestion, roundStartTime, answersSubmittedThisRound }
const rooms = {};
const users = {}; // userId: { username }

// --- Helper Functions ---
function generateUniqueRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Generates a quiz question for a "list 8 items" type game using Gemini.
 * The AI will provide a question and an array of 8 correct answers.
 * @param {string} difficulty - 'easy', 'medium', or 'hard'.
 * @returns {Promise<object>} - { question: string, correct_answers: string[] }
 */
async function generateQuizQuestion(difficulty) {
    const prompt = `Generate a unique, daily-basis quiz question. The question should ask the user to list exactly 8 distinct items related to a common everyday activity, household items, general knowledge related to daily life, or simple practical scenarios.
    Provide the question and an array of exactly 8 correct answers for that question. Ensure all answers are single words or very short phrases.
    Difficulty: ${difficulty}.
    Format the response as a JSON object with two fields: 'question' (string) and 'correct_answers' (an array of exactly 8 strings). Example:
    {
      "question": "List 8 common fruits.",
      "correct_answers": ["Apple", "Banana", "Orange", "Grape", "Strawberry", "Blueberry", "Pineapple", "Mango"]
    }`;

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
            // Attempt to parse directly, assuming AI mostly provides pure JSON due to responseMimeType
            questionData = JSON.parse(responseText);
        } catch (parseError) {
            // Fallback for cases where AI might wrap in markdown fences
            const jsonMatch = responseText.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch && jsonMatch[1]) {
                questionData = JSON.parse(jsonMatch[1]);
            } else {
                console.error("Failed to parse AI response JSON (no markdown or pure JSON):", responseText, parseError);
                throw new Error("Invalid JSON from AI model. Response was: " + responseText.substring(0, 100));
            }
        }

        // Basic validation of AI response structure and answer count
        if (!questionData.question || 
            !Array.isArray(questionData.correct_answers) || 
            questionData.correct_answers.length !== 8) {
            console.error("Malformed question data from AI:", questionData);
            throw new Error("AI returned malformed question data or incorrect number of answers.");
        }

        // Normalize correct answers to lowercase for easier comparison
        questionData.correct_answers = questionData.correct_answers.map(ans => ans.trim().toLowerCase());

        return questionData;
    } catch (error) {
        console.error("Error generating question from Gemini:", error);
        throw error;
    }
}

// --- API Endpoints ---

// User Authentication (Simple Anonymous Login)
app.post('/api/auth/anonymous', (req, res) => {
    let userId = req.headers['x-user-id']; // From frontend localStorage if exists
    let username = req.headers['x-username'] || req.body.username;

    if (!userId || !users[userId]) {
        userId = uuidv4(); // Generate new if not provided or doesn't exist
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
        players: [{ id: userId, username: username, score: 0, hasAnsweredCurrentRound: false }], // Players array with individual scores and answer status
        status: 'waiting', // waiting, playing, finished
        currentRound: 0, // 0-indexed round number
        maxRounds: 5, // You can make this configurable
        currentQuestion: null,
        roundStartTime: null, // Timestamp when the round started
        answersSubmittedThisRound: {}, // userId: { answers: [], score: number }
        difficulty: difficulty,
        playerOrder: [userId] // To maintain consistent player order for UI
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
    if (room.status !== 'waiting') {
        return res.status(400).json({ message: 'Cannot join: Game has already started or finished.' });
    }
    if (room.players.length >= 2) {
        return res.status(400).json({ message: 'Room is full (max 2 players).' });
    }
    if (room.players.some(p => p.id === userId)) {
        // If user is already in the room, just return current state
        return res.json(room); 
    }

    room.players.push({ id: userId, username: username, score: 0, hasAnsweredCurrentRound: false });
    room.playerOrder.push(userId); // Add to player order
    res.json(room);
});

// Get Room State (for polling)
app.get('/api/rooms/:roomId', (req, res) => {
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    // Mask sensitive info before sending to frontend if needed (e.g., correct answers)
    // For now, we'll send everything, as the frontend needs correct answers for final display logic.
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
    if (room.players.length < 2) {
        return res.status(400).json({ message: 'Need 2 players to start the game.' });
    }
    if (room.status !== 'waiting') {
        return res.status(400).json({ message: 'Game has already started or finished.' });
    }

    try {
        // Generate all questions at once for the game
        const generatedQuestions = [];
        for (let i = 0; i < room.maxRounds; i++) {
            const q = await generateQuizQuestion(room.difficulty);
            generatedQuestions.push(q);
        }

        room.status = 'playing';
        room.currentRound = 1; // Start from round 1
        room.currentQuestion = generatedQuestions[0]; // First question
        room.allQuestions = generatedQuestions; // Store all generated questions
        room.roundStartTime = Date.now(); // Start timer for the first round

        // Reset player-specific round state
        room.players.forEach(p => {
            p.score = 0; // Reset scores at game start
            p.hasAnsweredCurrentRound = false;
        });
        room.answersSubmittedThisRound = {}; // Reset for the first question

        res.json({ message: 'Game started!', room: room });
    } catch (error) {
        console.error('Error starting game:', error);
        res.status(500).json({ message: 'Failed to start game: ' + error.message });
    }
});

// Submit Answers
app.post('/api/rooms/:roomId/answer', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    // Frontend sends 'answers' (array) and 'round' (number)
    const { round, answers } = req.body;

    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    if (room.status !== 'playing') {
        return res.status(400).json({ message: 'Game is not in progress.' });
    }
    if (room.currentRound !== round) {
        return res.status(400).json({ message: 'Submitted answers for a past or future round.' });
    }
    // Find the player in the room's players array
    const player = room.players.find(p => p.id === userId);
    if (!player) {
        return res.status(401).json({ message: 'You are not a player in this room.' });
    }
    if (player.hasAnsweredCurrentRound) {
        return res.status(400).json({ message: 'You have already submitted answers for this round.' });
    }
    if (!Array.isArray(answers) || answers.length !== 8) {
        return res.status(400).json({ message: 'Answers must be an array of exactly 8 items.' });
    }

    const currentQuestion = room.currentQuestion;
    if (!currentQuestion || !currentQuestion.correct_answers) {
        return res.status(500).json({ message: 'Current question data is missing or malformed.' });
    }

    let scoreEarnedThisRound = 0;
    const correctAnswersSet = new Set(currentQuestion.correct_answers.map(a => a.trim().toLowerCase())); // Ensure correct answers are normalized

    // Compare submitted answers to correct answers
    const submittedNormalized = answers.map(ans => ans.trim().toLowerCase());
    submittedNormalized.forEach(submittedAns => {
        if (correctAnswersSet.has(submittedAns)) {
            scoreEarnedThisRound++;
            correctAnswersSet.delete(submittedAns); // Prevent double counting for duplicate submissions that match
        }
    });

    // Update player's score
    player.score += scoreEarnedThisRound;
    player.hasAnsweredCurrentRound = true; // Mark player as having answered this round

    // Store submitted answers for review or other logic
    room.answersSubmittedThisRound[userId] = {
        answers: submittedNormalized,
        score: scoreEarnedThisRound
    };

    // Check if all players have answered
    const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);

    // If all players have answered or time is up (backend handles actual timer/state progression)
    // For now, let the frontend polling trigger next round.
    res.json({ message: 'Answers received and scored.', room: room, scoreEarned: scoreEarnedThisRound });
});


// Advance to the next round / End Game
// This endpoint should be called by the host client after answers are in or time runs out,
// or an internal backend timer could trigger it.
app.post('/api/rooms/:roomId/next-round', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }
    // Only host can trigger this, or make it an internal server mechanism.
    if (room.hostId !== userId) {
        return res.status(403).json({ message: 'Only the host can advance rounds.' });
    }
    if (room.status !== 'playing') {
        return res.status(400).json({ message: 'Game is not in progress.' });
    }

    // Check if enough time has passed or all players have answered
    // (This logic could be more robust, e.g., checking timestamps or player submission flags)
    const allPlayersAnswered = room.players.every(p => p.hasAnsweredCurrentRound);
    const timeElapsed = (Date.now() - room.roundStartTime) >= (15000); // 15 seconds round duration
    
    // Only proceed if round criteria met
    if (!allPlayersAnswered && !timeElapsed) {
         return res.status(400).json({ message: 'Not all players have answered and time has not elapsed.' });
    }

    const nextRound = room.currentRound + 1;

    if (nextRound <= room.maxRounds) {
        // Move to next round
        room.currentRound = nextRound;
        room.currentQuestion = room.allQuestions[nextRound - 1]; // Get next question
        room.roundStartTime = Date.now(); // Reset timer for new round
        
        // Reset player-specific round state for the new round
        room.players.forEach(p => {
            p.hasAnsweredCurrentRound = false;
        });
        room.answersSubmittedThisRound = {}; // Clear submitted answers for this round

        res.json({ message: `Moved to round ${nextRound}`, room: room });
    } else {
        // Game finished
        room.status = 'finished';
        room.currentQuestion = null; // Clear question
        room.roundStartTime = null; // Clear timer
        res.json({ message: 'Game finished', room: room });
    }
});

// Leave Room
app.post('/api/rooms/:roomId/leave', (req, res) => {
    const userId = req.headers['x-user-id'];
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({ message: 'Room not found.' });
    }

    const playerIndex = room.players.findIndex(p => p.id === userId);
    if (playerIndex === -1) {
        return res.status(400).json({ message: 'You are not in this room.' });
    }

    room.players.splice(playerIndex, 1); // Remove player
    room.playerOrder = room.playerOrder.filter(id => id !== userId); // Remove from order

    // If host leaves, delete room or assign new host
    if (room.hostId === userId) {
        if (room.players.length > 0) {
            // Assign new host to the next player in line
            room.hostId = room.players[0].id;
            console.log(`Host ${userId} left. New host is ${room.hostId}`);
            // If game was playing and now only one player is left, end the game
            if (room.status === 'playing' && room.players.length < 2) {
                room.status = 'finished';
                room.currentQuestion = null;
                room.roundStartTime = null;
                console.log(`Game ${roomId} ended because only one player remains.`);
                return res.json({ message: 'Left room, new host assigned, game ended as players < 2.', room: room });
            }
        } else {
            // No players left, delete the room
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted as host left and no players remain.`);
            return res.json({ message: 'Room deleted.', room: null });
        }
    }

    // If a non-host player leaves and game is playing and now only one player is left
    if (room.status === 'playing' && room.players.length < 2) {
        room.status = 'finished';
        room.currentQuestion = null;
        room.roundStartTime = null;
        console.log(`Game ${roomId} ended because only one player remains after ${userId} left.`);
    }
    
    // If no players left after someone leaves, delete the room
    if (room.players.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted as last player left.`);
        return res.json({ message: 'Left room, room deleted.', room: null });
    }

    res.json({ message: 'Left room successfully', room: room });
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`Backend server listening on port ${PORT}`);
});