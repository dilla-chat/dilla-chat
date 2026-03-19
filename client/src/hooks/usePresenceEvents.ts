import { useEffect } from 'react';
import { usePresenceStore, type UserPresence } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
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

    return () => {
      unsubPresence();
      unsubVoiceJoin();
      unsubVoiceLeft();
      unsubMuteUpdate();
      unsubScreenUpdate();
      unsubWebcamUpdate();
    };
  }, [activeTeamId, updatePresence]);
}
