import { traceWSEvent } from './telemetry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventHandler = (payload: any) => void;

interface WSEvent {
  type: string;
  payload: Record<string, unknown>;
}

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 1_000;

export class WebSocketService {
  private readonly connections: Map<string, WebSocket> = new Map();
  private readonly handlers: Map<string, Set<EventHandler>> = new Map();
  private readonly reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly reconnectAttempts: Map<string, number> = new Map();
  private readonly connectionParams: Map<string, { url: string; token: string }> = new Map();
  private readonly heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly pendingMessages: Map<string, WSEvent[]> = new Map();
  private lastUserActivity = Date.now();

  constructor() {
    // Track user activity in the browser
    const markActive = () => { this.lastUserActivity = Date.now(); };
    if (globalThis.window !== undefined) {
      globalThis.addEventListener('mousemove', markActive, { passive: true });
      globalThis.addEventListener('keydown', markActive, { passive: true });
      globalThis.addEventListener('scroll', markActive, { passive: true, capture: true });
      globalThis.addEventListener('click', markActive, { passive: true });
    }
  }

  connect(teamId: string, url: string, token: string): void {
    this.connectWithParams(teamId, url, `token=${encodeURIComponent(token)}`);
  }

  /** Connect with custom auth query params (e.g. ticket= or token=). */
  connectWithParams(teamId: string, url: string, authParam: string): void {
    this.disconnect(teamId);
    this.connectionParams.set(teamId, { url, token: authParam });
    this.reconnectAttempts.set(teamId, 0);
    this.createConnection(teamId);
  }

  private createConnection(teamId: string): void {
    const params = this.connectionParams.get(teamId);
    if (!params) return;

    const wsUrl = `${params.url}?${params.token}&team=${encodeURIComponent(teamId)}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      this.reconnectAttempts.set(teamId, 0);
      this.startHeartbeat(teamId);
      traceWSEvent('receive', 'ws:connected', { team_id: teamId });
      this.emit('ws:connected', { teamId });
      // Note: pending messages are NOT flushed here — they must wait until
      // after sync:init completes and channels are joined. Call
      // flushPendingMessages() from the sync handler instead.
    };

    socket.onmessage = (event) => {
      try {
        const data: WSEvent = JSON.parse(event.data);
        if (data.type === 'response') {
          this.handleResponse(data.payload);
          return;
        }
        traceWSEvent('receive', data.type, { team_id: teamId });
        this.emit(data.type, data.payload);
      } catch {
        // ignore malformed messages
      }
    };

    socket.onclose = () => {
      this.connections.delete(teamId);
      this.stopHeartbeat(teamId);
      traceWSEvent('receive', 'ws:disconnected', { team_id: teamId });
      this.emit('ws:disconnected', { teamId });
      this.scheduleReconnect(teamId);
    };

    socket.onerror = () => {
      // onclose will fire after this
    };

    this.connections.set(teamId, socket);
  }

  // Send a lightweight ping every 2 minutes if user has been active recently.
  // This resets the server's idle timer (5 min) so users don't go idle while browsing.
  private startHeartbeat(teamId: string): void {
    this.stopHeartbeat(teamId);
    const timer = setInterval(() => {
      // Only heartbeat if user was active in the last 4 minutes
      if (Date.now() - this.lastUserActivity < 4 * 60 * 1000) {
        this.send(teamId, { type: 'ping', payload: { t: Date.now() } });
      }
    }, 2 * 60 * 1000); // every 2 minutes
    this.heartbeatTimers.set(teamId, timer);
  }

  private stopHeartbeat(teamId: string): void {
    const timer = this.heartbeatTimers.get(teamId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(teamId);
    }
  }

  private scheduleReconnect(teamId: string): void {
    if (!this.connectionParams.has(teamId)) return;

    const attempts = this.reconnectAttempts.get(teamId) ?? 0;
    const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** attempts, MAX_RECONNECT_DELAY);
    this.reconnectAttempts.set(teamId, attempts + 1);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(teamId);
      if (this.connectionParams.has(teamId)) {
        this.createConnection(teamId);
      }
    }, delay);

    this.reconnectTimers.set(teamId, timer);
  }

  disconnect(teamId: string): void {
    this.connectionParams.delete(teamId);

    const timer = this.reconnectTimers.get(teamId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(teamId);
    }

    this.stopHeartbeat(teamId);

    const socket = this.connections.get(teamId);
    if (socket) {
      socket.onclose = null;
      socket.close();
      this.connections.delete(teamId);
    }
  }

  /** Disconnect all teams — used on auth failure / logout. */
  disconnectAll(): void {
    for (const teamId of [...this.connectionParams.keys()]) {
      this.disconnect(teamId);
    }
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => this.off(eventType, handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  private emit(eventType: string, payload: unknown): void {
    this.handlers.get(eventType)?.forEach((handler) => {
      try {
        handler(payload);
      } catch {
        // prevent handler errors from breaking the event loop
      }
    });
  }

  send(teamId: string, event: WSEvent): void {
    const socket = this.connections.get(teamId);
    if (socket?.readyState === WebSocket.OPEN) {
      traceWSEvent('send', event.type, { team_id: teamId });
      socket.send(JSON.stringify(event));
    } else {
      const queue = this.pendingMessages.get(teamId) ?? [];
      if (queue.length < 100) {
        queue.push(event);
        this.pendingMessages.set(teamId, queue);
      }
      console.warn(`WebSocket not connected for team ${teamId}, queued event: ${event.type}`);
    }
  }

  flushPendingMessages(teamId: string): void {
    const queue = this.pendingMessages.get(teamId);
    if (!queue || queue.length === 0) return;
    this.pendingMessages.delete(teamId);
    for (const event of queue) {
      this.send(teamId, event);
    }
  }

  isConnected(teamId: string): boolean {
    const socket = this.connections.get(teamId);
    return socket?.readyState === WebSocket.OPEN;
  }

  // Ping/pong for latency measurement
  ping(teamId: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const t = performance.now();
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error('ping timeout'));
      }, 5000);
      const unsub = this.on('pong', () => {
        clearTimeout(timeout);
        unsub();
        resolve(Math.round(performance.now() - t));
      });
      this.send(teamId, { type: 'ping', payload: { t } });
    });
  }

  // Request/response pattern for data fetching over WS
  private readonly pendingRequests: Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }> = new Map();

  request<T = unknown>(teamId: string, action: string, payload: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`WS request timeout: ${action}`));
      }, 15_000);

      this.pendingRequests.set(id, {
        resolve: (data: unknown) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          resolve(data as T);
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(err);
        },
      });

      this.send(teamId, {
        type: 'request',
        payload: { id, action, payload },
      });
    });
  }

  private handleResponse(payload: Record<string, unknown>): void {
    const { id, ok, payload: data, error: errMsg } = payload as {
      id: string;
      ok: boolean;
      payload: unknown;
      error?: string;
    };
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    if (ok) {
      pending.resolve(data);
    } else {
      pending.reject(new Error(errMsg || 'WS request failed'));
    }
  }

  sendMessage(
    teamId: string,
    channelId: string,
    content: string,
    type: string = 'text',
    threadId?: string,
    attachmentIds?: string[],
  ): void {
    this.send(teamId, {
      type: 'message:send',
      payload: {
        channel_id: channelId,
        content,
        type,
        thread_id: threadId ?? null,
        attachment_ids: attachmentIds ?? [],
      },
    });
  }

  editMessage(teamId: string, messageId: string, channelId: string, content: string): void {
    this.send(teamId, {
      type: 'message:edit',
      payload: { message_id: messageId, channel_id: channelId, content },
    });
  }

  deleteMessage(teamId: string, messageId: string, channelId: string): void {
    this.send(teamId, {
      type: 'message:delete',
      payload: { message_id: messageId, channel_id: channelId },
    });
  }

  sendThreadMessage(teamId: string, threadId: string, content: string): void {
    this.send(teamId, {
      type: 'thread:message:send',
      payload: { thread_id: threadId, content },
    });
  }

  editThreadMessage(teamId: string, threadId: string, messageId: string, content: string): void {
    this.send(teamId, {
      type: 'thread:message:edit',
      payload: { thread_id: threadId, message_id: messageId, content },
    });
  }

  deleteThreadMessage(teamId: string, threadId: string, messageId: string): void {
    this.send(teamId, {
      type: 'thread:message:remove',
      payload: { thread_id: threadId, message_id: messageId },
    });
  }

  addReaction(teamId: string, channelId: string, messageId: string, emoji: string): void {
    this.send(teamId, {
      type: 'reaction:add',
      payload: { channel_id: channelId, message_id: messageId, emoji },
    });
  }

  removeReaction(teamId: string, channelId: string, messageId: string, emoji: string): void {
    this.send(teamId, {
      type: 'reaction:remove',
      payload: { channel_id: channelId, message_id: messageId, emoji },
    });
  }

  startTyping(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'typing:start',
      payload: { channel_id: channelId },
    });
  }

  joinChannel(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'channel:join',
      payload: { channel_id: channelId },
    });
  }

  leaveChannel(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'channel:leave',
      payload: { channel_id: channelId },
    });
  }

  distributeChannelKey(teamId: string, channelId: string, distribution: string): void {
    this.send(teamId, {
      type: 'channel:key-distribute',
      payload: { channel_id: channelId, distribution },
    });
  }

  updatePresence(teamId: string, statusType: string, statusText?: string): void {
    this.send(teamId, {
      type: 'presence:update',
      payload: { status_type: statusType, status_text: statusText ?? null },
    });
  }

  // Voice WebSocket methods
  voiceJoin(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'voice:join',
      payload: { channel_id: channelId },
    });
  }

  voiceLeave(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'voice:leave',
      payload: { channel_id: channelId },
    });
  }

  voiceAnswer(teamId: string, channelId: string, sdp: RTCSessionDescriptionInit): void {
    this.send(teamId, {
      type: 'voice:answer',
      payload: { channel_id: channelId, sdp: sdp.sdp },
    });
  }

  voiceICECandidate(teamId: string, channelId: string, candidate: RTCIceCandidateInit): void {
    this.send(teamId, {
      type: 'voice:ice-candidate',
      payload: {
        channel_id: channelId,
        candidate: candidate.candidate ?? '',
        sdp_mid: candidate.sdpMid ?? '',
        sdp_mline_index: candidate.sdpMLineIndex ?? 0,
      },
    });
  }

  voiceMute(teamId: string, channelId: string, muted: boolean): void {
    this.send(teamId, {
      type: 'voice:mute',
      payload: { channel_id: channelId, muted },
    });
  }

  voiceDeafen(teamId: string, channelId: string, deafened: boolean): void {
    this.send(teamId, {
      type: 'voice:deafen',
      payload: { channel_id: channelId, deafened },
    });
  }

  voiceScreenStart(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'voice:screen-start',
      payload: { channel_id: channelId },
    });
  }

  voiceScreenStop(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'voice:screen-stop',
      payload: { channel_id: channelId },
    });
  }

  voiceWebcamStart(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'voice:webcam-start',
      payload: { channel_id: channelId },
    });
  }

  voiceWebcamStop(teamId: string, channelId: string): void {
    this.send(teamId, {
      type: 'voice:webcam-stop',
      payload: { channel_id: channelId },
    });
  }

  voiceKeyDistribute(
    teamId: string,
    channelId: string,
    keyId: number,
    encryptedKeys: Record<string, string>,
  ): void {
    this.send(teamId, {
      type: 'voice:key-distribute',
      payload: { channel_id: channelId, key_id: keyId, encrypted_keys: encryptedKeys },
    });
  }

  // DM WebSocket methods
  sendDMMessage(teamId: string, dmId: string, content: string, type: string = 'text'): void {
    this.send(teamId, {
      type: 'dm:message:send',
      payload: { dm_channel_id: dmId, content, type },
    });
  }

  editDMMessage(teamId: string, dmId: string, messageId: string, content: string): void {
    this.send(teamId, {
      type: 'dm:message:edit',
      payload: { dm_channel_id: dmId, message_id: messageId, content },
    });
  }

  deleteDMMessage(teamId: string, dmId: string, messageId: string): void {
    this.send(teamId, {
      type: 'dm:message:delete',
      payload: { dm_channel_id: dmId, message_id: messageId },
    });
  }

  startDMTyping(teamId: string, dmId: string): void {
    this.send(teamId, {
      type: 'dm:typing:start',
      payload: { dm_channel_id: dmId },
    });
  }

  stopDMTyping(teamId: string, dmId: string): void {
    this.send(teamId, {
      type: 'dm:typing:stop',
      payload: { dm_channel_id: dmId },
    });
  }
}

export const ws = new WebSocketService();

export function enableMockWs(mockService: Record<string, unknown>): void {
  const target = ws as unknown as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(mockService))) {
    if (key !== 'constructor') {
      const val = mockService[key];
      target[key] = typeof val === 'function' ? val.bind(mockService) : val;
    }
  }
  for (const key of Object.keys(mockService)) {
    target[key] = mockService[key];
  }
}
