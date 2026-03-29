import { Injectable } from '@angular/core';
import { LeaderboardEntry, LiveQuestionPayload } from './models';

@Injectable({ providedIn: 'root' })
export class WebsocketService {
    private socket: { disconnect: () => void; emit: (event: string, payload: unknown) => void; on: (event: string, callback: (payload: unknown) => void) => void } | null = null;

    connect(
        baseUrl: string,
        roomCode: string,
        onQuestion: (payload: LiveQuestionPayload) => void,
        onLeaderboard: (payload: LeaderboardEntry[]) => void
    ): void {
        this.disconnect();

        import('socket.io-client')
            .then((ioModule) => {
                const socket = ioModule.io(baseUrl, {
                    path: '/ws/socket.io',
                    transports: ['websocket'],
                    reconnectionDelay: 1500,
                });

                socket.on('connect', () => {
                    socket.emit('join-room', { roomCode });
                });

                socket.on('question', (payload: unknown) => {
                    onQuestion(payload as LiveQuestionPayload);
                });

                socket.on('leaderboard', (payload: unknown) => {
                    onLeaderboard(payload as LeaderboardEntry[]);
                });

                this.socket = socket;
            })
            .catch((err) => {
                console.error('WebSocket init failed', err);
            });
    }

    disconnect(): void {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }
}
