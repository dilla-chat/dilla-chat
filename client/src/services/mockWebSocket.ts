import {
  MOCK_USERS, RANDOM_MESSAGES, DEMO_CURRENT_USER_ID, DEMO_TEAM_ID,
  MOCK_TEAM, MOCK_CHANNELS, MOCK_MEMBERS, MOCK_ROLES, MOCK_GROUPS,
  MOCK_PRESENCES, MOCK_VOICE_STATES,
} from './mockData';

type EventHandler = (payload: unknown) => void;

/**
 * Mock WebSocket service with the same on/off/send interface as the real one.
 * Simulates typing indicators, new messages, and presence changes.
 */
export class MockWebSocketService {
  private readonly handlers: Map<string, Set<EventHandler>> = new Map();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private peerApi: any | null = null;

  /** Link to the mockApi so request() can delegate per-action loads
   *  (messages:list, dms:list, threads:list, etc.) to the same fixture
   *  store the api serves over REST. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setPeerApi(api: any): void { this.peerApi = api; }

  connect(teamId: string, _url: string, _token: string): void {
    if (this.running) return;
    this.running = true;

    // Emit a connected event
    setTimeout(() => this.emit('ws:connected', { teamId: teamId || DEMO_TEAM_ID }), 100);

    this.scheduleTyping();
    this.scheduleNewMessage();
    this.schedulePresenceChange();
  }

  /** Real ws exposes connectWithParams for ticket-based auth; mock aliases it. */
  connectWithParams(
    teamId: string,
    url: string,
    authParam: string,
    _refreshAuth?: () => Promise<string>,
  ): void {
    this.connect(teamId, url, authParam);
  }

  disconnect(_teamId?: string): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Real ws lets useTeamSync tear down on auth failure / logout. */
  disconnectAll(): void {
    this.disconnect();
  }

  isConnected(_teamId: string): boolean {
    return this.running;
  }

  flushPendingMessages(_teamId: string): void { /* noop — mock send is synchronous */ }

  /** Mirrors the real ws.request(): useTeamSync calls ws.request('sync:init')
   *  to fetch the full team snapshot; ChannelView / DMView / ThreadPanel call
   *  it for per-channel history. Delegates to the linked mockApi so both
   *  WS-fast-path and REST-fallback paths return the same fixture. */
  async request<T = unknown>(teamId: string, action: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (action === 'sync:init') {
      return buildSyncInitPayload() as T;
    }
    const api = this.peerApi;
    if (!api) return {} as T;
    switch (action) {
      case 'messages:list':
        return api.getMessages(teamId, payload.channel_id as string, payload.limit as number | undefined, payload.before as string | undefined) as T;
      case 'threads:list':
        return api.getChannelThreads(teamId, payload.channel_id as string) as T;
      case 'threads:messages':
        return api.getThreadMessages(teamId, payload.thread_id as string) as T;
      case 'dms:list':
        return { dm_channels: await api.getDMChannels() } as T;
      case 'dms:messages':
        return api.getDMMessages(teamId, payload.dm_id as string) as T;
      default:
        return {} as T;
    }
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
  send(_teamId: string, _event: { type: string; payload: unknown }): void { /* noop */ }

  // WS methods that are no-ops in demo (the mock API handles mutations)
  sendMessage(): void { /* noop */ }
  editMessage(): void { /* noop */ }
  deleteMessage(): void { /* noop */ }
  addReaction(): void { /* noop */ }
  removeReaction(): void { /* noop */ }
  startTyping(): void { /* noop */ }
  joinChannel(): void { /* noop */ }
  leaveChannel(): void { /* noop */ }
  updatePresence(): void { /* noop */ }
  voiceJoin(): void { /* noop */ }
  voiceLeave(): void { /* noop */ }
  voiceAnswer(): void { /* noop */ }
  voiceICECandidate(): void { /* noop */ }
  voiceMute(): void { /* noop */ }
  voiceDeafen(): void { /* noop */ }
  sendDMMessage(): void { /* noop */ }
  editDMMessage(): void { /* noop */ }
  deleteDMMessage(): void { /* noop */ }
  startDMTyping(): void { /* noop */ }
  stopDMTyping(): void { /* noop */ }

  // ─── Simulation timers (demo-only, not security-sensitive) ──────────────

  private randomDelay(minSec: number, maxSec: number): number {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return (minSec + (arr[0] / 0xffffffff) * (maxSec - minSec)) * 1000;
  }

  private pickOtherUser() {
    const others = MOCK_USERS.filter(u => u.id !== DEMO_CURRENT_USER_ID);
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return others[arr[0] % others.length];
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
      const msgArr = new Uint32Array(1);
      crypto.getRandomValues(msgArr);
      const content = RANDOM_MESSAGES[msgArr[0] % RANDOM_MESSAGES.length];
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
      const statusArr = new Uint32Array(1);
      crypto.getRandomValues(statusArr);
      const status = statuses[statusArr[0] % statuses.length];
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

/** Build the sync:init response that the real server emits, populated from
 *  the demo fixtures. Channels carry teamId; members are flat-shape (already
 *  normalized); presences are keyed by user_id; voice_states by channel_id. */
function buildSyncInitPayload() {
  return {
    team: MOCK_TEAM,
    channels: MOCK_CHANNELS.map((ch) => ({ ...ch, team_id: DEMO_TEAM_ID, group_id: ch.groupId ?? null })),
    members: MOCK_MEMBERS,
    roles: MOCK_ROLES,
    groups: MOCK_GROUPS.map((g) => ({
      id: g.id, team_id: g.teamId, name: g.name, position: g.position,
      access_role_ids: g.accessRoleIds, hidden_if_restricted: g.hiddenIfRestricted,
    })),
    presences: MOCK_PRESENCES,
    voice_states: MOCK_VOICE_STATES,
    unread_counts: {},
    // Pins start empty in the demo; the user can pin via the message
    // context menu and the mock api keeps state in-memory.
    pins: [] as Array<{ channel_id: string; message_id: string }>,
  };
}
