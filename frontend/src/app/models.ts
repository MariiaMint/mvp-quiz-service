export type Role = 'ORGANIZER' | 'PARTICIPANT';

export interface AuthResponse {
    token: string;
    email: string;
    displayName: string;
    role: Role;
}

export interface OptionRequest {
    text: string;
    correct: boolean;
}

export interface QuestionRequest {
    text: string;
    imageUrl?: string;
    type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
    points: number;
    options: OptionRequest[];
}

export interface CreateQuizRequest {
    title: string;
    category: string;
    timePerQuestionSeconds: number;
    questions: QuestionRequest[];
}

export interface QuizResponse {
    id: number;
    title: string;
    category: string;
    questionCount: number;
    timePerQuestionSeconds: number;
    createdAt: string;
}

export interface SessionStateResponse {
    roomCode: string;
    status: 'WAITING' | 'LIVE' | 'FINISHED';
    currentQuestionIndex: number;
    totalQuestions: number;
    leaderboard: LeaderboardEntry[];
}

export interface LeaderboardEntry {
    displayName: string;
    score: number;
}

export interface LiveQuestionPayload {
    questionId: number;
    index: number;
    total: number;
    text: string;
    imageUrl?: string;
    type: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE';
    timeLimitSeconds: number;
    options: { id: number; text: string }[];
}

export interface OrganizerCabinetResponse {
    quizzesCreated: number;
    sessionsHosted: number;
    quizzes: QuizResponse[];
}

export interface ParticipantCabinetResponse {
    quizzesPlayed: number;
    totalScore: number;
    history: { quizTitle: string; roomCode: string; score: number; playedAt: string }[];
}
