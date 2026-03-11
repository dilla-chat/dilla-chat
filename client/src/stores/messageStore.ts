import { create } from 'zustand';

export interface Reaction {
  emoji: string;
  users: string[];
  count: number;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  username: string;
  content: string;
  encryptedContent: string;
  type: string;
  threadId: string | null;
  editedAt: string | null;
  deleted: boolean;
  createdAt: string;
  reactions: Reaction[];
}

export interface TypingUser {
  userId: string;
  username: string;
  timestamp: number;
}

interface MessageState {
  messages: Map<string, Message[]>;
  typing: Map<string, TypingUser[]>;
  loadingHistory: Map<string, boolean>;
  hasMore: Map<string, boolean>;

  addMessage: (channelId: string, message: Message) => void;
  prependMessages: (channelId: string, messages: Message[]) => void;
  updateMessage: (channelId: string, messageId: string, content: string) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
  updateReactions: (channelId: string, messageId: string, reactions: Reaction[]) => void;
  setTyping: (channelId: string, user: TypingUser) => void;
  clearTyping: (channelId: string, userId: string) => void;
  setLoadingHistory: (channelId: string, loading: boolean) => void;
  setHasMore: (channelId: string, hasMore: boolean) => void;
  clearChannel: (channelId: string) => void;
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: new Map(),
  typing: new Map(),
  loadingHistory: new Map(),
  hasMore: new Map(),

  addMessage: (channelId, message) =>
    set((state) => {
      const map = new Map(state.messages);
      const existing = map.get(channelId) ?? [];
      // Avoid duplicates
      if (existing.some((m) => m.id === message.id)) return state;
      map.set(channelId, [...existing, message]);
      return { messages: map };
    }),

  prependMessages: (channelId, messages) =>
    set((state) => {
      const map = new Map(state.messages);
      const existing = map.get(channelId) ?? [];
      const existingIds = new Set(existing.map((m) => m.id));
      const newMsgs = messages.filter((m) => !existingIds.has(m.id));
      map.set(channelId, [...newMsgs, ...existing]);
      return { messages: map };
    }),

  updateMessage: (channelId, messageId, content) =>
    set((state) => {
      const map = new Map(state.messages);
      const existing = map.get(channelId) ?? [];
      map.set(
        channelId,
        existing.map((m) =>
          m.id === messageId
            ? { ...m, content, editedAt: new Date().toISOString() }
            : m,
        ),
      );
      return { messages: map };
    }),

  deleteMessage: (channelId, messageId) =>
    set((state) => {
      const map = new Map(state.messages);
      const existing = map.get(channelId) ?? [];
      map.set(
        channelId,
        existing.map((m) =>
          m.id === messageId ? { ...m, deleted: true, content: '' } : m,
        ),
      );
      return { messages: map };
    }),

  updateReactions: (channelId, messageId, reactions) =>
    set((state) => {
      const map = new Map(state.messages);
      const existing = map.get(channelId) ?? [];
      map.set(
        channelId,
        existing.map((m) =>
          m.id === messageId ? { ...m, reactions } : m,
        ),
      );
      return { messages: map };
    }),

  setTyping: (channelId, user) =>
    set((state) => {
      const map = new Map(state.typing);
      const existing = map.get(channelId) ?? [];
      const filtered = existing.filter((u) => u.userId !== user.userId);
      map.set(channelId, [...filtered, user]);
      return { typing: map };
    }),

  clearTyping: (channelId, userId) =>
    set((state) => {
      const map = new Map(state.typing);
      const existing = map.get(channelId) ?? [];
      map.set(
        channelId,
        existing.filter((u) => u.userId !== userId),
      );
      return { typing: map };
    }),

  setLoadingHistory: (channelId, loading) =>
    set((state) => {
      const map = new Map(state.loadingHistory);
      map.set(channelId, loading);
      return { loadingHistory: map };
    }),

  setHasMore: (channelId, hasMore) =>
    set((state) => {
      const map = new Map(state.hasMore);
      map.set(channelId, hasMore);
      return { hasMore: map };
    }),

  clearChannel: (channelId) =>
    set((state) => {
      const messages = new Map(state.messages);
      const typing = new Map(state.typing);
      const loadingHistory = new Map(state.loadingHistory);
      const hasMore = new Map(state.hasMore);
      messages.delete(channelId);
      typing.delete(channelId);
      loadingHistory.delete(channelId);
      hasMore.delete(channelId);
      return { messages, typing, loadingHistory, hasMore };
    }),
}));
