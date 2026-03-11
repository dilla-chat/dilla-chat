import { create } from 'zustand';
import type { Message } from './messageStore';

export interface Thread {
  id: string;
  channel_id: string;
  parent_message_id: string;
  team_id: string;
  creator_id: string;
  title: string;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
}

interface ThreadStore {
  threads: Record<string, Thread[]>; // channelId -> threads
  activeThreadId: string | null;
  threadMessages: Record<string, Message[]>; // threadId -> messages
  threadPanelOpen: boolean;

  setThreads: (channelId: string, threads: Thread[]) => void;
  addThread: (channelId: string, thread: Thread) => void;
  updateThread: (thread: Thread) => void;
  removeThread: (channelId: string, threadId: string) => void;
  setActiveThread: (threadId: string | null) => void;
  setThreadPanelOpen: (open: boolean) => void;
  setThreadMessages: (threadId: string, messages: Message[]) => void;
  addThreadMessage: (threadId: string, message: Message) => void;
  updateThreadMessage: (threadId: string, message: Message) => void;
  removeThreadMessage: (threadId: string, messageId: string) => void;
}

export const useThreadStore = create<ThreadStore>((set) => ({
  threads: {},
  activeThreadId: null,
  threadMessages: {},
  threadPanelOpen: false,

  setThreads: (channelId, threads) =>
    set((state) => ({
      threads: { ...state.threads, [channelId]: threads },
    })),

  addThread: (channelId, thread) =>
    set((state) => {
      const existing = state.threads[channelId] ?? [];
      if (existing.some((t) => t.id === thread.id)) return state;
      return {
        threads: { ...state.threads, [channelId]: [...existing, thread] },
      };
    }),

  updateThread: (thread) =>
    set((state) => {
      const channelId = thread.channel_id;
      const existing = state.threads[channelId] ?? [];
      return {
        threads: {
          ...state.threads,
          [channelId]: existing.map((t) => (t.id === thread.id ? thread : t)),
        },
      };
    }),

  removeThread: (channelId, threadId) =>
    set((state) => {
      const existing = state.threads[channelId] ?? [];
      return {
        threads: {
          ...state.threads,
          [channelId]: existing.filter((t) => t.id !== threadId),
        },
      };
    }),

  setActiveThread: (threadId) =>
    set({ activeThreadId: threadId }),

  setThreadPanelOpen: (open) =>
    set({ threadPanelOpen: open }),

  setThreadMessages: (threadId, messages) =>
    set((state) => ({
      threadMessages: { ...state.threadMessages, [threadId]: messages },
    })),

  addThreadMessage: (threadId, message) =>
    set((state) => {
      const existing = state.threadMessages[threadId] ?? [];
      if (existing.some((m) => m.id === message.id)) return state;
      return {
        threadMessages: { ...state.threadMessages, [threadId]: [...existing, message] },
      };
    }),

  updateThreadMessage: (threadId, message) =>
    set((state) => {
      const existing = state.threadMessages[threadId] ?? [];
      return {
        threadMessages: {
          ...state.threadMessages,
          [threadId]: existing.map((m) => (m.id === message.id ? message : m)),
        },
      };
    }),

  removeThreadMessage: (threadId, messageId) =>
    set((state) => {
      const existing = state.threadMessages[threadId] ?? [];
      return {
        threadMessages: {
          ...state.threadMessages,
          [threadId]: existing.map((m) =>
            m.id === messageId ? { ...m, deleted: true, content: '' } : m,
          ),
        },
      };
    }),
}));
