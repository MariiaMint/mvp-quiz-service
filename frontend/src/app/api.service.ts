import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
    AuthResponse,
    CreateQuizRequest,
    LiveQuestionPayload,
    OrganizerCabinetResponse,
    ParticipantCabinetResponse,
    QuizResponse,
    Role,
    SessionStateResponse,
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
    readonly baseUrl = 'http://localhost:8081';

    constructor(private readonly http: HttpClient) { }

    register(payload: { email: string; password: string; displayName: string; role: Role }): Observable<AuthResponse> {
        return this.http.post<AuthResponse>(`${this.baseUrl}/api/auth/register`, payload);
    }

    login(payload: { email: string; password: string }): Observable<AuthResponse> {
        return this.http.post<AuthResponse>(`${this.baseUrl}/api/auth/login`, payload);
    }

    getMyQuizzes(token: string): Observable<QuizResponse[]> {
        return this.http.get<QuizResponse[]>(`${this.baseUrl}/api/quizzes/my`, { headers: this.authHeaders(token) });
    }

    createQuiz(token: string, payload: CreateQuizRequest): Observable<QuizResponse> {
        return this.http.post<QuizResponse>(`${this.baseUrl}/api/quizzes`, payload, { headers: this.authHeaders(token) });
    }

    startSession(token: string, quizId: number): Observable<{ roomCode: string }> {
        return this.http.post<{ roomCode: string }>(`${this.baseUrl}/api/sessions/start/${quizId}`, {}, { headers: this.authHeaders(token) });
    }

    joinSession(token: string, roomCode: string): Observable<SessionStateResponse> {
        return this.http.post<SessionStateResponse>(`${this.baseUrl}/api/sessions/join`, { roomCode }, { headers: this.authHeaders(token) });
    }

    nextQuestion(token: string, roomCode: string): Observable<LiveQuestionPayload | null> {
        return this.http.post<LiveQuestionPayload | null>(`${this.baseUrl}/api/sessions/${roomCode}/next`, {}, { headers: this.authHeaders(token) });
    }

    submitAnswer(token: string, roomCode: string, questionId: number, optionIds: number[]): Observable<{ status: string }> {
        return this.http.post<{ status: string }>(
            `${this.baseUrl}/api/sessions/${roomCode}/answer`,
            { questionId, optionIds },
            { headers: this.authHeaders(token) }
        );
    }

    finishSession(token: string, roomCode: string): Observable<SessionStateResponse> {
        return this.http.post<SessionStateResponse>(`${this.baseUrl}/api/sessions/${roomCode}/finish`, {}, { headers: this.authHeaders(token) });
    }

    getSessionState(token: string, roomCode: string): Observable<SessionStateResponse> {
        return this.http.get<SessionStateResponse>(`${this.baseUrl}/api/sessions/${roomCode}/state`, { headers: this.authHeaders(token) });
    }

    getCurrentQuestion(token: string, roomCode: string): Observable<LiveQuestionPayload | null> {
        return this.http.get<LiveQuestionPayload | null>(`${this.baseUrl}/api/sessions/${roomCode}/current-question`, { headers: this.authHeaders(token) });
    }

    getOrganizerCabinet(token: string): Observable<OrganizerCabinetResponse> {
        return this.http.get<OrganizerCabinetResponse>(`${this.baseUrl}/api/cabinet/organizer`, { headers: this.authHeaders(token) });
    }

    getParticipantCabinet(token: string): Observable<ParticipantCabinetResponse> {
        return this.http.get<ParticipantCabinetResponse>(`${this.baseUrl}/api/cabinet/participant`, { headers: this.authHeaders(token) });
    }

    private authHeaders(token: string): HttpHeaders {
        return new HttpHeaders({ Authorization: `Bearer ${token}` });
    }
}
