import { ws } from '../websocket';
import { useAudioSettingsStore } from '../../stores/audioSettingsStore';

export class PushToTalkManager {
  private pttListeners: Array<() => void> = [];

  setupPTT(
    localStream: MediaStream | null,
    teamId: string | null,
    channelId: string | null,
  ): void {
    this.cleanupPTT();
    const audioSettings = useAudioSettingsStore.getState();
    if (!audioSettings.pushToTalk) return;

    // Start with mic muted when PTT is enabled
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = false;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const currentKey = useAudioSettingsStore.getState().pushToTalkKey;
      if (e.code === currentKey && localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack && !audioTrack.enabled) {
          audioTrack.enabled = true;
          if (teamId && channelId) {
            ws.voiceMute(teamId, channelId, false);
          }
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const currentKey = useAudioSettingsStore.getState().pushToTalkKey;
      if (e.code === currentKey && localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack?.enabled) {
          audioTrack.enabled = false;
          if (teamId && channelId) {
            ws.voiceMute(teamId, channelId, true);
          }
        }
      }
    };

    globalThis.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    this.pttListeners.push(
      () => globalThis.removeEventListener('keydown', onKeyDown),
      () => globalThis.removeEventListener('keyup', onKeyUp),
    );

    // Subscribe to PTT setting changes to re-setup when toggled
    const unsubPTT = useAudioSettingsStore.subscribe((state) => {
      if (!state.pushToTalk) {
        this.cleanupPTT();
        // Re-enable mic when PTT is turned off
        if (localStream) {
          const audioTrack = localStream.getAudioTracks()[0];
          if (audioTrack) audioTrack.enabled = true;
        }
      }
    });
    this.pttListeners.push(unsubPTT);
  }

  cleanupPTT(): void {
    for (const cleanup of this.pttListeners) {
      cleanup();
    }
    this.pttListeners = [];
  }
}
