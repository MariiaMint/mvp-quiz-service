import { CommonModule } from '@angular/common';
import { Component, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import {
  CreateQuizRequest,
  LiveQuestionPayload,
  OrganizerCabinetResponse,
  ParticipantCabinetResponse,
  QuestionRequest,
  QuizResponse,
  Role,
  SessionStateResponse,
} from './models';
import { WebsocketService } from './websocket.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnDestroy {
  readonly roles: Role[] = ['ORGANIZER', 'PARTICIPANT'];

  authMode: 'login' | 'register' = 'login';
  email = '';
  password = '';
  displayName = '';
  role: Role = 'PARTICIPANT';

  token = this.readStorage('token');
  profileName = this.readStorage('displayName');
  profileRole = (this.readStorage('role') as Role | '') || null;

  quizzes: QuizResponse[] = [];
  organizerCabinet: OrganizerCabinetResponse | null = null;
  participantCabinet: ParticipantCabinetResponse | null = null;

  createQuizModel: CreateQuizRequest = {
    title: '',
    category: '',
    timePerQuestionSeconds: 20,
    questions: [this.emptyQuestion()],
  };

  roomCode = '';
  activeRoomCode = '';
  sessionState: SessionStateResponse | null = null;
  liveQuestion: LiveQuestionPayload | null = null;
  selectedOptionIds: number[] = [];

  uiMessage = '';
  uiError = '';
  currentView: 'live' | 'leaderboard' | 'cabinet' = 'live';
  private questionPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly api: ApiService, private readonly ws: WebsocketService) {
    if (this.token && !this.profileRole) {
      this.logout();
      this.uiMessage = 'Сессия устарела. Войдите снова.';
      return;
    }

    if (this.token) {
      this.bootstrapAfterAuth();
    }
  }

  ngOnDestroy(): void {
    this.ws.disconnect();
    this.stopQuestionPolling();
  }

  submitAuth(): void {
    this.clearAlerts();

    if (this.authMode === 'register') {
      this.api
        .register({
          email: this.email,
          password: this.password,
          displayName: this.displayName,
          role: this.role,
        })
        .subscribe({
          next: (res) => this.onAuthSuccess(res.token, res.displayName, res.role),
          error: (err) => this.onError(err),
        });
      return;
    }

    this.api.login({ email: this.email, password: this.password }).subscribe({
      next: (res) => this.onAuthSuccess(res.token, res.displayName, res.role),
      error: (err) => this.onError(err),
    });
  }

  logout(): void {
    this.ws.disconnect();
    this.stopQuestionPolling();
    this.clearStorage();
    this.token = '';
    this.profileName = '';
    this.profileRole = null;
    this.quizzes = [];
    this.organizerCabinet = null;
    this.participantCabinet = null;
    this.sessionState = null;
    this.liveQuestion = null;
    this.selectedOptionIds = [];
    this.uiMessage = 'Вы вышли из системы';
  }

  addQuestion(): void {
    this.createQuizModel.questions.push(this.emptyQuestion());
  }

  addOption(question: QuestionRequest): void {
    question.options.push({ text: '', correct: false });
  }

  onQuestionTypeChanged(question: QuestionRequest): void {
    if (question.type !== 'SINGLE_CHOICE') {
      return;
    }

    const firstCorrectIndex = question.options.findIndex((option) => option.correct);
    question.options = question.options.map((option, index) => ({
      ...option,
      correct: firstCorrectIndex >= 0 ? index === firstCorrectIndex : false,
    }));
  }

  onOptionCorrectChanged(question: QuestionRequest, optionIndex: number, checked: boolean): void {
    if (question.type === 'SINGLE_CHOICE') {
      if (!checked) {
        return;
      }

      question.options = question.options.map((option, index) => ({
        ...option,
        correct: index === optionIndex,
      }));
      return;
    }

    question.options[optionIndex].correct = checked;
  }

  createQuiz(): void {
    this.clearAlerts();

    const validationError = this.validateQuizBeforeSave();
    if (validationError) {
      this.uiError = validationError;
      return;
    }

    this.api.createQuiz(this.token, this.createQuizModel).subscribe({
      next: () => {
        this.uiMessage = 'Квиз создан';
        this.createQuizModel = {
          title: '',
          category: '',
          timePerQuestionSeconds: 20,
          questions: [this.emptyQuestion()],
        };
        this.loadOrganizerData();
      },
      error: (err) => this.onError(err),
    });
  }

  startSession(quizId: number): void {
    this.clearAlerts();
    this.api.startSession(this.token, quizId).subscribe({
      next: ({ roomCode }) => {
        this.activeRoomCode = roomCode;
        this.uiMessage = `Сессия запущена. Код комнаты: ${roomCode}`;
        this.connectRoomSocket(roomCode);
        this.refreshState(roomCode);
      },
      error: (err) => this.onError(err),
    });
  }

  nextQuestion(): void {
    if (!this.activeRoomCode) {
      return;
    }
    this.clearAlerts();
    this.api.nextQuestion(this.token, this.activeRoomCode).subscribe({
      next: (payload) => {
        if (!payload) {
          this.uiMessage = 'Квиз завершен';
          this.refreshState(this.activeRoomCode);
          return;
        }
        this.liveQuestion = payload;
        this.selectedOptionIds = [];
      },
      error: (err) => this.onError(err),
    });
  }

  finishSession(): void {
    if (!this.activeRoomCode) {
      return;
    }
    this.clearAlerts();
    this.api.finishSession(this.token, this.activeRoomCode).subscribe({
      next: (state) => {
        this.applySessionState(state);
        this.uiMessage = 'Сессия завершена';
      },
      error: (err) => this.onError(err),
    });
  }

  joinRoom(): void {
    this.clearAlerts();
    this.api.joinSession(this.token, this.roomCode.trim().toUpperCase()).subscribe({
      next: (state) => {
        this.activeRoomCode = state.roomCode;
        this.applySessionState(state);
        this.connectRoomSocket(state.roomCode);
        this.startQuestionPolling(state.roomCode);
        this.fetchCurrentQuestion(state.roomCode);
        this.uiMessage = `Вы подключились к комнате ${state.roomCode}`;
      },
      error: (err) => this.onError(err),
    });
  }

  toggleOption(optionId: number, checked: boolean): void {
    if (this.liveQuestion?.type === 'SINGLE_CHOICE') {
      this.selectedOptionIds = checked ? [optionId] : [];
      return;
    }

    if (checked) {
      this.selectedOptionIds = [...this.selectedOptionIds, optionId];
      return;
    }

    this.selectedOptionIds = this.selectedOptionIds.filter((id) => id !== optionId);
  }

  submitAnswer(): void {
    if (!this.liveQuestion || !this.activeRoomCode || this.selectedOptionIds.length === 0) {
      return;
    }

    this.clearAlerts();
    this.api.submitAnswer(this.token, this.activeRoomCode, this.liveQuestion.questionId, this.selectedOptionIds).subscribe({
      next: () => {
        this.uiMessage = 'Ответ принят';
      },
      error: (err) => this.onError(err),
    });
  }

  private bootstrapAfterAuth(): void {
    if (this.profileRole === 'ORGANIZER') {
      this.loadOrganizerData();
      return;
    }

    this.loadParticipantData();
  }

  private loadOrganizerData(): void {
    this.api.getMyQuizzes(this.token).subscribe({
      next: (quizzes) => (this.quizzes = quizzes),
      error: (err) => this.onError(err),
    });

    this.api.getOrganizerCabinet(this.token).subscribe({
      next: (cabinet) => (this.organizerCabinet = cabinet),
      error: (err) => this.onError(err),
    });
  }

  private loadParticipantData(): void {
    this.api.getParticipantCabinet(this.token).subscribe({
      next: (cabinet) => (this.participantCabinet = cabinet),
      error: (err) => this.onError(err),
    });
  }

  private refreshState(roomCode: string): void {
    this.api.getSessionState(this.token, roomCode).subscribe({
      next: (state) => this.applySessionState(state),
      error: (err) => this.onError(err),
    });
  }

  private fetchCurrentQuestion(roomCode: string): void {
    this.api.getCurrentQuestion(this.token, roomCode).subscribe({
      next: (question) => {
        if (!question) {
          if (this.sessionState?.status === 'FINISHED') {
            this.liveQuestion = null;
            this.stopQuestionPolling();
          }
          return;
        }

        if (!this.liveQuestion || this.liveQuestion.questionId !== question.questionId) {
          this.liveQuestion = question;
          this.selectedOptionIds = [];
        }
      },
      error: () => {
      },
    });
  }

  private startQuestionPolling(roomCode: string): void {
    this.stopQuestionPolling();
    this.questionPollTimer = setInterval(() => {
      if (!this.activeRoomCode || this.activeRoomCode !== roomCode) {
        return;
      }
      this.refreshState(roomCode);
      this.fetchCurrentQuestion(roomCode);
    }, 1200);
  }

  private stopQuestionPolling(): void {
    if (this.questionPollTimer) {
      clearInterval(this.questionPollTimer);
      this.questionPollTimer = null;
    }
  }

  private connectRoomSocket(roomCode: string): void {
    this.ws.connect(
      this.api.baseUrl,
      roomCode,
      (question) => {
        this.liveQuestion = question;
        this.selectedOptionIds = [];
      },
      (leaderboard) => {
        if (this.sessionState) {
          this.sessionState = { ...this.sessionState, leaderboard, status: 'FINISHED' };
          this.liveQuestion = null;
          this.stopQuestionPolling();
        }
      }
    );
  }

  private applySessionState(state: SessionStateResponse): void {
    this.sessionState = state;
    if (state.status === 'FINISHED') {
      this.liveQuestion = null;
      this.stopQuestionPolling();
    }
  }

  private onAuthSuccess(token: string, displayName: string, role: Role): void {
    this.token = token;
    this.profileName = displayName;
    this.profileRole = role;

    this.writeStorage('token', token);
    this.writeStorage('displayName', displayName);
    this.writeStorage('role', role);

    this.uiMessage = 'Авторизация успешна';
    this.bootstrapAfterAuth();
  }

  private onError(err: { error?: { error?: string } }): void {
    this.uiError = err.error?.error ?? 'Ошибка запроса';
  }

  private clearAlerts(): void {
    this.uiMessage = '';
    this.uiError = '';
  }

  private emptyQuestion(): QuestionRequest {
    return {
      text: '',
      imageUrl: '',
      type: 'SINGLE_CHOICE',
      points: 100,
      options: [
        { text: '', correct: false },
        { text: '', correct: false },
      ],
    };
  }

  private validateQuizBeforeSave(): string | null {
    for (let i = 0; i < this.createQuizModel.questions.length; i++) {
      const question = this.createQuizModel.questions[i];
      const correctCount = question.options.filter((option) => option.correct).length;

      if (question.type === 'SINGLE_CHOICE' && correctCount !== 1) {
        return `Вопрос ${i + 1}: для одиночного выбора нужен ровно 1 верный вариант`;
      }

      if (question.type === 'MULTIPLE_CHOICE' && correctCount < 1) {
        return `Вопрос ${i + 1}: отметьте хотя бы 1 верный вариант`;
      }
    }

    return null;
  }

  private readStorage(key: string): string {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  }

  private clearStorage(): void {
    try {
      localStorage.clear();
    } catch {
    }
  }
}
