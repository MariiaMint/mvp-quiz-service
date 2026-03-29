const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const path = require('path');

const PORT = Number(process.env.PORT || 8081);
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-for-production';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'quiz-node.db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    path: '/ws/socket.io',
    cors: {
        origin: ['http://localhost:4200'],
        methods: ['GET', 'POST'],
    },
});

app.use(cors({ origin: 'http://localhost:4200' }));
app.use(express.json({ limit: '2mb' }));

let db;

function nowIso() {
    return new Date().toISOString();
}

function normalizeRole(role) {
    if (role === 'ORGANIZER' || role === 'PARTICIPANT') {
        return role;
    }
    throw new Error('Invalid role');
}

function issueToken(user) {
    return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
}

async function authMiddleware(req, res, next) {
    const value = req.header('Authorization') || '';
    const token = value.startsWith('Bearer ') ? value.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        const user = await db.get('SELECT id, email, display_name AS displayName, role FROM users WHERE id = ?', [payload.sub]);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = user;
        return next();
    } catch (_err) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
}

function apiError(res, message, status = 400) {
    return res.status(status).json({ error: message });
}

function requireOrganizer(req, res) {
    if (req.user.role !== 'ORGANIZER') {
        apiError(res, 'Only organizer can perform this action', 403);
        return false;
    }
    return true;
}

function randomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i += 1) {
        out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
}

async function generateUniqueRoomCode() {
    for (let i = 0; i < 30; i += 1) {
        const candidate = randomRoomCode();
        const exists = await db.get('SELECT id FROM quiz_sessions WHERE room_code = ?', [candidate]);
        if (!exists) {
            return candidate;
        }
    }
    throw new Error('Cannot generate unique room code');
}

async function getSessionByRoomCode(roomCode) {
    return db.get(
        `SELECT
            qs.id,
            qs.quiz_id AS quizId,
            qs.room_code AS roomCode,
            qs.status,
            qs.current_question_index AS currentQuestionIndex,
            qs.question_started_at AS questionStartedAt,
            qs.started_at AS startedAt,
            qs.ended_at AS endedAt,
            q.title AS quizTitle,
            q.time_per_question_seconds AS timePerQuestionSeconds,
            q.organizer_id AS organizerId
         FROM quiz_sessions qs
         JOIN quizzes q ON q.id = qs.quiz_id
         WHERE qs.room_code = ?`,
        [roomCode.toUpperCase()]
    );
}

async function getQuizQuestions(quizId) {
    const questions = await db.all(
        `SELECT
            id,
            text,
            image_url AS imageUrl,
            type,
            points,
            position
         FROM questions
         WHERE quiz_id = ?
         ORDER BY position ASC`,
        [quizId]
    );

    for (const question of questions) {
        question.options = await db.all(
            `SELECT id, text, is_correct AS isCorrect, position
             FROM question_options
             WHERE question_id = ?
             ORDER BY position ASC`,
            [question.id]
        );
    }

    return questions;
}

async function getLeaderboard(sessionId) {
    return db.all(
        `SELECT u.display_name AS displayName, ps.score
         FROM participant_sessions ps
         JOIN users u ON u.id = ps.user_id
         WHERE ps.session_id = ?
         ORDER BY ps.score DESC, u.display_name ASC`,
        [sessionId]
    );
}

async function toStateResponse(session) {
    const row = await db.get('SELECT COUNT(*) AS total FROM questions WHERE quiz_id = ?', [session.quizId]);
    const leaderboard = await getLeaderboard(session.id);

    return {
        roomCode: session.roomCode,
        status: session.status,
        currentQuestionIndex: session.currentQuestionIndex,
        totalQuestions: row.total,
        leaderboard,
    };
}

function toLiveQuestionPayload(question, index, total, timeLimitSeconds) {
    return {
        questionId: question.id,
        index,
        total,
        text: question.text,
        imageUrl: question.imageUrl,
        type: question.type,
        timeLimitSeconds,
        options: question.options.map((option) => ({ id: option.id, text: option.text })),
    };
}

async function completeSession(session) {
    if (session.status !== 'FINISHED') {
        await db.run(
            `UPDATE quiz_sessions
             SET status = 'FINISHED', ended_at = ?, question_started_at = NULL
             WHERE id = ?`,
            [nowIso(), session.id]
        );
    }

    const refreshed = await getSessionByRoomCode(session.roomCode);
    const state = await toStateResponse(refreshed);
    io.to(refreshed.roomCode).emit('leaderboard', state.leaderboard);
    return state;
}

async function advanceToNextQuestion(session) {
    const questions = await getQuizQuestions(session.quizId);
    const nextIndex = Number(session.currentQuestionIndex) + 1;

    if (nextIndex >= questions.length) {
        await completeSession(session);
        return null;
    }

    const startedAt = nowIso();
    await db.run(
        'UPDATE quiz_sessions SET current_question_index = ?, question_started_at = ? WHERE id = ?',
        [nextIndex, startedAt, session.id]
    );

    const payload = toLiveQuestionPayload(
        questions[nextIndex],
        nextIndex,
        questions.length,
        session.timePerQuestionSeconds
    );

    io.to(session.roomCode).emit('question', payload);
    return payload;
}

async function autoAdvanceTimedOutQuestions() {
    const sessions = await db.all(
        `SELECT
            qs.id,
            qs.room_code AS roomCode,
            qs.quiz_id AS quizId,
            qs.status,
            qs.current_question_index AS currentQuestionIndex,
            qs.question_started_at AS questionStartedAt,
            q.time_per_question_seconds AS timePerQuestionSeconds
         FROM quiz_sessions qs
         JOIN quizzes q ON q.id = qs.quiz_id
         WHERE qs.status = 'LIVE'`
    );

    const now = Date.now();
    for (const session of sessions) {
        if (session.currentQuestionIndex < 0 || !session.questionStartedAt) {
            continue;
        }

        const timeoutAt = new Date(session.questionStartedAt).getTime() + session.timePerQuestionSeconds * 1000;
        if (timeoutAt > now) {
            continue;
        }

        await advanceToNextQuestion(session);
    }
}

setInterval(() => {
    autoAdvanceTimedOutQuestions().catch((err) => {
        console.error('Auto-advance error', err);
    });
}, 1000);

io.on('connection', (socket) => {
    socket.on('join-room', (payload) => {
        if (!payload || !payload.roomCode) {
            return;
        }
        socket.join(String(payload.roomCode).toUpperCase());
    });
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, displayName, role } = req.body || {};
        if (!email || !password || !displayName || !role) {
            return apiError(res, 'All fields are required');
        }

        const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
        if (existing) {
            return apiError(res, 'User already exists');
        }

        const hashed = await bcrypt.hash(String(password), 10);
        const createdAt = nowIso();
        const normalizedRole = normalizeRole(role);

        const result = await db.run(
            'INSERT INTO users (email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
            [email.toLowerCase(), hashed, displayName, normalizedRole, createdAt]
        );

        const user = {
            id: result.lastID,
            email: email.toLowerCase(),
            displayName,
            role: normalizedRole,
        };

        return res.json({ token: issueToken(user), ...user });
    } catch (err) {
        return apiError(res, err.message || 'Registration failed');
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return apiError(res, 'Email and password are required');
        }

        const user = await db.get(
            'SELECT id, email, password_hash AS passwordHash, display_name AS displayName, role FROM users WHERE email = ?',
            [String(email).toLowerCase()]
        );
        if (!user) {
            return apiError(res, 'Invalid credentials', 401);
        }

        const ok = await bcrypt.compare(String(password), user.passwordHash);
        if (!ok) {
            return apiError(res, 'Invalid credentials', 401);
        }

        return res.json({
            token: issueToken(user),
            email: user.email,
            displayName: user.displayName,
            role: user.role,
        });
    } catch (err) {
        return apiError(res, err.message || 'Login failed');
    }
});

app.get('/api/quizzes/my', authMiddleware, async (req, res) => {
    if (!requireOrganizer(req, res)) {
        return;
    }

    const quizzes = await db.all(
        `SELECT
            q.id,
            q.title,
            q.category,
            q.time_per_question_seconds AS timePerQuestionSeconds,
            q.created_at AS createdAt,
            (SELECT COUNT(*) FROM questions qq WHERE qq.quiz_id = q.id) AS questionCount
         FROM quizzes q
         WHERE q.organizer_id = ?
         ORDER BY q.created_at DESC`,
        [req.user.id]
    );

    res.json(quizzes);
});

app.post('/api/quizzes', authMiddleware, async (req, res) => {
    if (!requireOrganizer(req, res)) {
        return;
    }

    const { title, category, timePerQuestionSeconds, questions } = req.body || {};

    if (!title || !category || !Number.isFinite(timePerQuestionSeconds) || timePerQuestionSeconds <= 0) {
        return apiError(res, 'Invalid quiz header');
    }

    if (!Array.isArray(questions) || questions.length === 0) {
        return apiError(res, 'Quiz must contain at least one question');
    }

    for (const question of questions) {
        if (!question.text || !Array.isArray(question.options) || question.options.length < 2) {
            return apiError(res, 'Each question needs text and at least two options');
        }

        const correctCount = question.options.filter((option) => option.correct).length;
        if (question.type === 'SINGLE_CHOICE' && correctCount !== 1) {
            return apiError(res, 'Each single-choice question must have exactly one correct option');
        }

        if (question.type === 'MULTIPLE_CHOICE' && correctCount < 1) {
            return apiError(res, 'Each multiple-choice question must have at least one correct option');
        }

        if (!['SINGLE_CHOICE', 'MULTIPLE_CHOICE'].includes(question.type)) {
            return apiError(res, 'Unsupported question type');
        }
    }

    const createdAt = nowIso();
    const result = await db.run(
        `INSERT INTO quizzes (organizer_id, title, category, time_per_question_seconds, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, title, category, Number(timePerQuestionSeconds), createdAt]
    );

    const quizId = result.lastID;

    for (let qIndex = 0; qIndex < questions.length; qIndex += 1) {
        const q = questions[qIndex];
        const qResult = await db.run(
            `INSERT INTO questions (quiz_id, text, image_url, type, points, position)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [quizId, q.text, q.imageUrl || null, q.type, Number(q.points) || 0, qIndex]
        );

        for (let oIndex = 0; oIndex < q.options.length; oIndex += 1) {
            const option = q.options[oIndex];
            await db.run(
                `INSERT INTO question_options (question_id, text, is_correct, position)
                 VALUES (?, ?, ?, ?)`,
                [qResult.lastID, option.text, option.correct ? 1 : 0, oIndex]
            );
        }
    }

    const response = {
        id: quizId,
        title,
        category,
        questionCount: questions.length,
        timePerQuestionSeconds: Number(timePerQuestionSeconds),
        createdAt,
    };

    res.json(response);
});

app.post('/api/sessions/start/:quizId', authMiddleware, async (req, res) => {
    if (!requireOrganizer(req, res)) {
        return;
    }

    const quizId = Number(req.params.quizId);
    const quiz = await db.get('SELECT id, organizer_id AS organizerId FROM quizzes WHERE id = ?', [quizId]);

    if (!quiz) {
        return apiError(res, 'Quiz not found');
    }

    if (quiz.organizerId !== req.user.id) {
        return apiError(res, 'Only quiz owner can start this session', 403);
    }

    const roomCode = await generateUniqueRoomCode();
    await db.run(
        `INSERT INTO quiz_sessions (quiz_id, room_code, status, current_question_index, started_at)
         VALUES (?, ?, 'LIVE', -1, ?)`,
        [quizId, roomCode, nowIso()]
    );

    res.json({ roomCode });
});

app.post('/api/sessions/join', authMiddleware, async (req, res) => {
    const roomCode = String(req.body?.roomCode || '').trim().toUpperCase();
    if (!roomCode) {
        return apiError(res, 'Room code is required');
    }

    const session = await getSessionByRoomCode(roomCode);
    if (!session) {
        return apiError(res, 'Session not found');
    }

    if (session.status === 'FINISHED') {
        return apiError(res, 'Session already finished');
    }

    const existing = await db.get(
        'SELECT id FROM participant_sessions WHERE session_id = ? AND user_id = ?',
        [session.id, req.user.id]
    );

    if (!existing) {
        await db.run(
            'INSERT INTO participant_sessions (session_id, user_id, score, joined_at) VALUES (?, ?, 0, ?)',
            [session.id, req.user.id, nowIso()]
        );
    }

    const state = await toStateResponse(session);
    res.json(state);
});

app.post('/api/sessions/:roomCode/next', authMiddleware, async (req, res) => {
    const session = await getSessionByRoomCode(req.params.roomCode);
    if (!session) {
        return apiError(res, 'Session not found');
    }

    if (session.organizerId !== req.user.id || req.user.role !== 'ORGANIZER') {
        return apiError(res, 'Only quiz owner can perform this action', 403);
    }

    if (session.status !== 'LIVE') {
        return apiError(res, 'Session is not live');
    }

    const payload = await advanceToNextQuestion(session);
    res.json(payload);
});

app.post('/api/sessions/:roomCode/answer', authMiddleware, async (req, res) => {
    const session = await getSessionByRoomCode(req.params.roomCode);
    if (!session) {
        return apiError(res, 'Session not found');
    }

    if (session.status !== 'LIVE' || session.currentQuestionIndex < 0) {
        return apiError(res, 'There is no active question now');
    }

    const questions = await getQuizQuestions(session.quizId);
    const currentQuestion = questions[session.currentQuestionIndex];
    if (!currentQuestion) {
        return apiError(res, 'There is no active question now');
    }

    const { questionId, optionIds } = req.body || {};
    if (Number(questionId) !== currentQuestion.id) {
        return apiError(res, 'Can answer only current question');
    }

    if (session.questionStartedAt) {
        const timeoutAt = new Date(session.questionStartedAt).getTime() + session.timePerQuestionSeconds * 1000;
        if (Date.now() > timeoutAt) {
            return apiError(res, 'Answer timeout exceeded');
        }
    }

    const participant = await db.get(
        'SELECT id, score FROM participant_sessions WHERE session_id = ? AND user_id = ?',
        [session.id, req.user.id]
    );

    if (!participant) {
        return apiError(res, 'Join room first');
    }

    const alreadyAnswered = await db.get(
        'SELECT id FROM answer_submissions WHERE participant_session_id = ? AND question_id = ?',
        [participant.id, currentQuestion.id]
    );

    if (alreadyAnswered) {
        return apiError(res, 'Question already answered');
    }

    const selected = Array.isArray(optionIds) ? optionIds.map(Number).sort((a, b) => a - b) : [];
    const correct = currentQuestion.options
        .filter((option) => Number(option.isCorrect) === 1)
        .map((option) => option.id)
        .sort((a, b) => a - b);

    const isCorrect = selected.length === correct.length && selected.every((v, i) => v === correct[i]);
    const points = isCorrect ? Number(currentQuestion.points) : 0;

    await db.run('UPDATE participant_sessions SET score = score + ? WHERE id = ?', [points, participant.id]);
    await db.run(
        `INSERT INTO answer_submissions
         (participant_session_id, question_id, selected_option_ids, is_correct, points_awarded, answered_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [participant.id, currentQuestion.id, selected.join(','), isCorrect ? 1 : 0, points, nowIso()]
    );

    res.json({ status: 'accepted' });
});

app.post('/api/sessions/:roomCode/finish', authMiddleware, async (req, res) => {
    const session = await getSessionByRoomCode(req.params.roomCode);
    if (!session) {
        return apiError(res, 'Session not found');
    }

    if (session.organizerId !== req.user.id || req.user.role !== 'ORGANIZER') {
        return apiError(res, 'Only quiz owner can perform this action', 403);
    }

    const state = await completeSession(session);
    res.json(state);
});

app.get('/api/sessions/:roomCode/state', authMiddleware, async (req, res) => {
    const session = await getSessionByRoomCode(req.params.roomCode);
    if (!session) {
        return apiError(res, 'Session not found');
    }

    const state = await toStateResponse(session);
    res.json(state);
});

app.get('/api/sessions/:roomCode/current-question', authMiddleware, async (req, res) => {
    const session = await getSessionByRoomCode(req.params.roomCode);
    if (!session) {
        return apiError(res, 'Session not found');
    }

    if (session.status !== 'LIVE' || session.currentQuestionIndex < 0) {
        return res.json(null);
    }

    const questions = await getQuizQuestions(session.quizId);
    const question = questions[session.currentQuestionIndex];
    if (!question) {
        return res.json(null);
    }

    const payload = toLiveQuestionPayload(
        question,
        session.currentQuestionIndex,
        questions.length,
        session.timePerQuestionSeconds
    );

    return res.json(payload);
});

app.get('/api/cabinet/organizer', authMiddleware, async (req, res) => {
    if (!requireOrganizer(req, res)) {
        return;
    }

    const quizzes = await db.all(
        `SELECT
            q.id,
            q.title,
            q.category,
            q.time_per_question_seconds AS timePerQuestionSeconds,
            q.created_at AS createdAt,
            (SELECT COUNT(*) FROM questions qq WHERE qq.quiz_id = q.id) AS questionCount
         FROM quizzes q
         WHERE q.organizer_id = ?
         ORDER BY q.created_at DESC`,
        [req.user.id]
    );

    const sessionsHostedRow = await db.get(
        `SELECT COUNT(*) AS value
         FROM quiz_sessions qs
         JOIN quizzes q ON q.id = qs.quiz_id
         WHERE q.organizer_id = ?`,
        [req.user.id]
    );

    res.json({
        quizzesCreated: quizzes.length,
        sessionsHosted: sessionsHostedRow.value,
        quizzes,
    });
});

app.get('/api/cabinet/participant', authMiddleware, async (req, res) => {
    const history = await db.all(
        `SELECT
            q.title AS quizTitle,
            qs.room_code AS roomCode,
            ps.score,
            ps.joined_at AS playedAt
         FROM participant_sessions ps
         JOIN quiz_sessions qs ON qs.id = ps.session_id
         JOIN quizzes q ON q.id = qs.quiz_id
         WHERE ps.user_id = ?
         ORDER BY ps.joined_at DESC`,
        [req.user.id]
    );

    const totalRow = await db.get('SELECT COALESCE(SUM(score), 0) AS totalScore FROM participant_sessions WHERE user_id = ?', [
        req.user.id,
    ]);

    res.json({
        quizzesPlayed: history.length,
        totalScore: totalRow.totalScore,
        history,
    });
});

async function initSchema() {
    await db.exec(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('ORGANIZER', 'PARTICIPANT')),
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quizzes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            organizer_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            time_per_question_seconds INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS questions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            image_url TEXT,
            type TEXT NOT NULL CHECK(type IN ('SINGLE_CHOICE', 'MULTIPLE_CHOICE')),
            points INTEGER NOT NULL,
            position INTEGER NOT NULL,
            FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS question_options (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            is_correct INTEGER NOT NULL CHECK(is_correct IN (0, 1)),
            position INTEGER NOT NULL,
            FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS quiz_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quiz_id INTEGER NOT NULL,
            room_code TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK(status IN ('WAITING', 'LIVE', 'FINISHED')),
            current_question_index INTEGER NOT NULL DEFAULT -1,
            question_started_at TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS participant_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            score INTEGER NOT NULL DEFAULT 0,
            joined_at TEXT NOT NULL,
            UNIQUE(session_id, user_id),
            FOREIGN KEY (session_id) REFERENCES quiz_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS answer_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            participant_session_id INTEGER NOT NULL,
            question_id INTEGER NOT NULL,
            selected_option_ids TEXT NOT NULL,
            is_correct INTEGER NOT NULL CHECK(is_correct IN (0, 1)),
            points_awarded INTEGER NOT NULL,
            answered_at TEXT NOT NULL,
            UNIQUE(participant_session_id, question_id),
            FOREIGN KEY (participant_session_id) REFERENCES participant_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_quizzes_organizer ON quizzes(organizer_id);
        CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id);
        CREATE INDEX IF NOT EXISTS idx_options_question ON question_options(question_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_room ON quiz_sessions(room_code);
        CREATE INDEX IF NOT EXISTS idx_participant_sessions_session ON participant_sessions(session_id);
    `);
}

async function bootstrap() {
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await initSchema();

    app.use((_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    server.listen(PORT, () => {
        console.log(`Node backend is running on http://localhost:${PORT}`);
    });
}

bootstrap().catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
});
