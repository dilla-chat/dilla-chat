import { create } from 'zustand';
import type { Message } from './messageStore';

export interface DMChannelMember {
  user_id: string;
  username: string;
  display_name: string;
}

export interface DMChannel {
  id: string;
  team_id: string;
  is_group: boolean;
  members: DMChannelMember[];
  last_message?: Message;
  created_at: string;
}

interface DMStore {
  dmChannels: Record<string, DMChannel[]>; // teamId -> DM channels
  activeDMId: string | null;
  dmMessages: Record<string, Message[]>; // dmId -> messages
  dmTyping: Record<string, string[]>; // dmId -> userIds typing

  setDMChannels: (teamId: string, channels: DMChannel[]) => void;
  addDMChannel: (teamId: string, channel: DMChannel) => void;
  setActiveDM: (dmId: string | null) => void;
  setDMMessages: (dmId: string, messages: Message[]) => void;
  addDMMessage: (dmId: string, message: Message) => void;
  updateDMMessage: (dmId: string, message: Message) => void;
  removeDMMessage: (dmId: string, messageId: string) => void;
  setDMTyping: (dmId: string, userIds: string[]) => void;
}

export const useDMStore = create<DMStore>((set) => ({
  dmChannels: {},
  activeDMId: null,
  dmMessages: {},
  dmTyping: {},

  setDMChannels: (teamId, channels) =>
    set((state) => ({
      dmChannels: { ...state.dmChannels, [teamId]: channels },
    })),

  addDMChannel: (teamId, channel) =>
    set((state) => {
      const existing = state.dmChannels[teamId] ?? [];
      if (existing.some((c) => c.id === channel.id)) return state;
      return {
        dmChannels: { ...state.dmChannels, [teamId]: [channel, ...existing] },
      };
    }),

  setActiveDM: (dmId) => set({ activeDMId: dmId }),

  setDMMessages: (dmId, messages) =>
    set((state) => ({
      dmMessages: { ...state.dmMessages, [dmId]: messages },
    })),

  addDMMessage: (dmId, message) =>
    set((state) => {
      const existing = state.dmMessages[dmId] ?? [];
      if (existing.some((m) => m.id === message.id)) return state;
      return {
        dmMessages: { ...state.dmMessages, [dmId]: [...existing, message] },
      };
    }),

  updateDMMessage: (dmId, message) =>
    set((state) => {
      const existing = state.dmMessages[dmId] ?? [];
      return {
        dmMessages: {
          ...state.dmMessages,
          [dmId]: existing.map((m) => (m.id === message.id ? message : m)),
        },
      };
    }),

  removeDMMessage: (dmId, messageId) =>
    set((state) => {
      const existing = state.dmMessages[dmId] ?? [];
      return {
        dmMessages: {
          ...state.dmMessages,
          [dmId]: existing.map((m) =>
            m.id === messageId ? { ...m, deleted: true, content: '' } : m,
          ),
        },
      };
    }),

  setDMTyping: (dmId, userIds) =>
    set((state) => ({
      dmTyping: { ...state.dmTyping, [dmId]: userIds },
    })),
}));
