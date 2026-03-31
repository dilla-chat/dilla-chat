import { useCallback, useMemo } from 'react';
import { useVoiceStore } from '../stores/voiceStore';
import { useShallow } from 'zustand/react/shallow';

export function useVoiceConnection() {
  const {
    connected,
    connecting,
    currentChannelId,
    currentTeamId,
    muted,
    deafened,
    speaking,
    joinChannel,
    leaveChannel,
    toggleMute,
    toggleDeafen,
    peers,
  } = useVoiceStore(
    useShallow((s) => ({
      connected: s.connected,
      connecting: s.connecting,
      currentChannelId: s.currentChannelId,
      currentTeamId: s.currentTeamId,
      muted: s.muted,
      deafened: s.deafened,
      speaking: s.speaking,
      joinChannel: s.joinChannel,
      leaveChannel: s.leaveChannel,
      toggleMute: s.toggleMute,
      toggleDeafen: s.toggleDeafen,
      peers: s.peers,
    })),
  );

  const peerList = useMemo(() => Object.values(peers), [peers]);

  const join = useCallback(
    (teamId: string, channelId: string) => joinChannel(teamId, channelId),
    [joinChannel],
  );

  const leave = useCallback(() => leaveChannel(), [leaveChannel]);

  return {
    connected,
    connecting,
    currentChannelId,
    currentTeamId,
    muted,
    deafened,
    speaking,
    peerList,
    peerCount: peerList.length,
    join,
    leave,
    toggleMute,
    toggleDeafen,
  };
}
