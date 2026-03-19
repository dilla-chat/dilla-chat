import { MOCK_USERS, RANDOM_MESSAGES, DEMO_CURRENT_USER_ID } from './mockData';

type EventHandler = (payload: unknown) => void;

/**
 * Mock WebSocket service with the same on/off/send interface as the real one.
 * Simulates typing indicators, new messages, and presence changes.
 */
export class MockWebSocketService {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;

  connect(_teamId: string, _url: string, _token: string): void {
    if (this.running) return;
    this.running = true;

    // Emit a connected event
    setTimeout(() => this.emit('ws:connected', { teamId: 'demo-team' }), 100);

    this.scheduleTyping();
    this.scheduleNewMessage();
    this.schedulePresenceChange();
  }

  disconnect(_teamId?: string): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set());
    this.handlers.get(eventType)!.add(handler);
    return () => this.off(eventType, handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  private emit(eventType: string, payload: unknown): void {
    this.handlers.get(eventType)?.forEach(h => {
      try { h(payload); } catch { /* ignore */ }
    });
  }

  // No-op send — in demo mode we intercept at the store level
  send(_teamId: string, _event: { type: string; payload: unknown }): void {}

  // WS methods that are no-ops in demo (the mock API handles mutations)
  sendMessage(): void {}
  editMessage(): void {}
  deleteMessage(): void {}
  addReaction(): void {}
  removeReaction(): void {}
  startTyping(): void {}
  joinChannel(): void {}
  leaveChannel(): void {}
  updatePresence(): void {}
  voiceJoin(): void {}
  voiceLeave(): void {}
  voiceAnswer(): void {}
  voiceICECandidate(): void {}
  voiceMute(): void {}
  voiceDeafen(): void {}
  sendDMMessage(): void {}
  editDMMessage(): void {}
  deleteDMMessage(): void {}
  startDMTyping(): void {}
  stopDMTyping(): void {}

  // ─── Simulation timers (demo-only, not security-sensitive) ──────────────

  private randomDelay(minSec: number, maxSec: number): number {
    return (minSec + Math.random() * (maxSec - minSec)) * 1000; // lgtm[js/insecure-randomness]
  }

  private pickOtherUser() {
    const others = MOCK_USERS.filter(u => u.id !== DEMO_CURRENT_USER_ID);
    return others[Math.floor(Math.random() * others.length)]; // lgtm[js/insecure-randomness]
  }

  private scheduleTyping(): void {
    const run = () => {
      if (!this.running) return;
      const user = this.pickOtherUser();
      this.emit('typing:started', {
        channel_id: 'ch-2',
        user_id: user.id,
        username: user.username,
      });
      // Clear typing after 3 seconds
      const clearTimer = setTimeout(() => {
        this.emit('typing:stopped', {
          channel_id: 'ch-2',
          user_id: user.id,
        });
      }, 3000);
      this.timers.push(clearTimer);

      const nextTimer = setTimeout(run, this.randomDelay(15, 30));
      this.timers.push(nextTimer);
    };
    const t = setTimeout(run, this.randomDelay(10, 20));
    this.timers.push(t);
  }

  private scheduleNewMessage(): void {
    let msgCounter = 5000;
    const run = () => {
      if (!this.running) return;
      const user = this.pickOtherUser();
      const content = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];
      this.emit('message:created', {
        id: `sim-msg-${++msgCounter}`,
        channel_id: 'ch-2',
        author_id: user.id,
        username: user.username,
        content,
        encrypted_content: '',
        type: 'text',
        thread_id: null,
        edited_at: null,
        deleted: false,
        created_at: new Date().toISOString(),
        reactions: [],
      });

      const nextTimer = setTimeout(run, this.randomDelay(45, 60));
      this.timers.push(nextTimer);
    };
    const t = setTimeout(run, this.randomDelay(30, 45));
    this.timers.push(t);
  }

  private schedulePresenceChange(): void {
    const statuses = ['online', 'idle', 'dnd', 'offline'] as const;
    const run = () => {
      if (!this.running) return;
      const user = this.pickOtherUser();
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      this.emit('presence:changed', {
        user_id: user.id,
        status,
        custom_status: '',
        last_active: new Date().toISOString(),
        team_id: 'demo-team',
      });

      const nextTimer = setTimeout(run, this.randomDelay(20, 40));
      this.timers.push(nextTimer);
    };
    const t = setTimeout(run, this.randomDelay(15, 25));
    this.timers.push(t);
  }
}
