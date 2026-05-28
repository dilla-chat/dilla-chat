import { useEffect } from 'react';
import { usePresenceStore, type UserPresence } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { VoicePeer } from '../services/api';
import { ws } from '../services/websocket';

/**
 * Subscribes to presence and voice WebSocket events for the active team.
 */
export function usePresenceEvents(activeTeamId: string | null): void {
  const { updatePresence } = usePresenceStore();

  useEffect(() => {
    const unsubPresence = ws.on('presence:changed', (payload: Record<string, string>) => {
      const teamId = payload.team_id ?? activeTeamId;
      if (teamId && payload.user_id) {
        // Normalize server's status_type → status
        const normalized: UserPresence = {
          user_id: payload.user_id,
          status: (payload.status_type || payload.status || 'offline') as UserPresence['status'],
          custom_status: payload.status_text ?? payload.custom_status ?? '',
          last_active: payload.last_active ?? '',
        };
        updatePresence(teamId, normalized);
      }
    });

    // Global voice presence: track who's in voice channels across the team
    const unsubVoiceJoin = ws.on('voice:user-joined', (payload: { channel_id: string; user_id: string; username: string; muted?: boolean; deafened?: boolean; screen_sharing?: boolean; webcam_sharing?: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().addVoiceOccupant(payload.channel_id, {
          user_id: payload.user_id,
          username: payload.username,
          muted: payload.muted ?? false,
          deafened: payload.deafened ?? false,
          speaking: false,
          voiceLevel: 0,
          screen_sharing: payload.screen_sharing ?? false,
          webcam_sharing: payload.webcam_sharing ?? false,
        });
      }
    });

    const unsubVoiceLeft = ws.on('voice:user-left', (payload: { channel_id: string; user_id: string }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().removeVoiceOccupant(payload.channel_id, payload.user_id);
      }
    });

    const unsubJoinDenied = ws.on('voice:join-denied', (payload: { channel_id: string; reason?: string }) => {
      const vs = useVoiceStore.getState();
      if (vs.currentChannelId === payload.channel_id) {
        vs.leaveChannel();
      }
      const reason = payload.reason === 'locked' ? 'Channel is locked.' : 'Voice join denied.';
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: '', author: 'system', text: reason, duration: 3000 } }));
    });

    // Server-side eviction: an admin removed access while we were in the
    // voice channel. Mirror the local leave-channel flow so WebRTC tears
    // down and the UI reflects "not connected" without a reload.
    const unsubForceDisconnect = ws.on('voice:force-disconnect', (payload: { channel_id?: string; reason?: string }) => {
      const vs = useVoiceStore.getState();
      if (vs.currentChannelId && (!payload.channel_id || vs.currentChannelId === payload.channel_id)) {
        vs.leaveChannel();
      }
      const text = payload.reason === 'access_revoked'
        ? 'You were removed from voice — channel access changed.'
        : payload.reason === 'moderator_action'
          ? 'You were disconnected from voice by a moderator.'
          : 'You were disconnected from voice.';
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', {
        detail: { channel: '', author: 'system', text, duration: 4500 },
      }));
    });

    // Global voice state updates: keep sidebar occupants in sync
    const unsubMuteUpdate = ws.on('voice:mute-update', (payload: { channel_id: string; user_id: string; muted: boolean; deafened: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().updateVoiceOccupant(payload.channel_id, payload.user_id, {
          muted: payload.muted,
          deafened: payload.deafened,
        });
      }
    });

    const unsubScreenUpdate = ws.on('voice:screen-update', (payload: { channel_id: string; user_id: string; sharing: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().updateVoiceOccupant(payload.channel_id, payload.user_id, {
          screen_sharing: payload.sharing,
        });
      }
    });

    const unsubWebcamUpdate = ws.on('voice:webcam-update', (payload: { channel_id: string; user_id: string; sharing: boolean }) => {
      if (payload.channel_id && payload.user_id) {
        useVoiceStore.getState().updateVoiceOccupant(payload.channel_id, payload.user_id, {
          webcam_sharing: payload.sharing,
        });
      }
    });

    // Initial snapshot from the server when the WS connects. Replaces
    // any stale voiceOccupants entries for the team. Subsequent deltas
    // come via the voice:user-joined/left handlers above.
    const unsubRoomsSnapshot = ws.on(
      'voice:rooms-snapshot',
      (payload: { team_id: string; rooms: Record<string, VoicePeer[]> }) => {
        if (!payload?.rooms) return;
        useVoiceStore.getState().setVoiceOccupants(payload.rooms);
      },
    );

    return () => {
      unsubPresence();
      unsubVoiceJoin();
      unsubVoiceLeft();
      unsubJoinDenied();
      unsubForceDisconnect();
      unsubMuteUpdate();
      unsubScreenUpdate();
      unsubWebcamUpdate();
      unsubRoomsSnapshot();
    };
  }, [activeTeamId, updatePresence]);
}
