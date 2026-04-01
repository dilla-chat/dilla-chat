import { useMessageStore } from './messageStore';
import { useVoiceStore } from './voiceStore';
import { useDMStore } from './dmStore';
import { usePresenceStore } from './presenceStore';
import { useThreadStore } from './threadStore';
import { useTeamStore } from './teamStore';
import { useShallow } from 'zustand/react/shallow';

// Stable empty array to avoid infinite re-render loops from `?? []` creating
// new references on every selector invocation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EMPTY: any[] = [];

// Message selectors
export function useChannelMessages(channelId: string) {
  return useMessageStore((s) => s.messages.get(channelId) ?? EMPTY);
}

export function useChannelLoading(channelId: string) {
  return useMessageStore((s) => s.loadingHistory.get(channelId) ?? false);
}

export function useChannelHasMore(channelId: string) {
  return useMessageStore((s) => s.hasMore.get(channelId) ?? true);
}

export function useChannelTyping(channelId: string) {
  return useMessageStore((s) => s.typing.get(channelId) ?? EMPTY);
}

// Voice selectors
export function useVoiceConnectionState() {
  return useVoiceStore(
    useShallow((s) => ({
      connected: s.connected,
      connecting: s.connecting,
      currentChannelId: s.currentChannelId,
      currentTeamId: s.currentTeamId,
    })),
  );
}

export function useVoiceMediaState() {
  return useVoiceStore(
    useShallow((s) => ({
      muted: s.muted,
      deafened: s.deafened,
      speaking: s.speaking,
      screenSharing: s.screenSharing,
      webcamSharing: s.webcamSharing,
    })),
  );
}

export function useVoicePeers() {
  return useVoiceStore((s) => s.peers);
}

export function useVoiceChannelOccupants(channelId: string) {
  return useVoiceStore((s) => s.voiceOccupants[channelId] ?? EMPTY);
}

// DM selectors
export function useTeamDMs(teamId: string) {
  return useDMStore((s) => s.dmChannels[teamId] ?? EMPTY);
}

export function useDMTyping(dmId: string) {
  return useDMStore((s) => s.dmTyping[dmId] ?? EMPTY);
}

// Presence selectors
export function useUserPresence(teamId: string, userId: string) {
  return usePresenceStore((s) => s.presences[teamId]?.[userId]);
}

// Thread selectors
export function useChannelThreads(channelId: string) {
  const raw = useThreadStore((s) => s.threads[channelId]);
  return Array.isArray(raw) ? raw : [];
}

export function useThreadMessages(threadId: string) {
  return useThreadStore((s) => s.threadMessages[threadId] ?? EMPTY);
}

// Team selectors
export function useTeamChannels(teamId: string) {
  const ch = useTeamStore((s) => s.channels.get(teamId));
  return Array.isArray(ch) ? ch : [];
}

export function useTeamMembers(teamId: string) {
  return useTeamStore((s) => s.members.get(teamId) ?? EMPTY);
}
