import { useVoiceStore } from '../../stores/voiceStore';
import { useUserSettingsStore } from '../../stores/userSettingsStore';

const VAD_INTERVAL_MS = 100;

export class VoiceActivityDetector {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly remoteAnalysers: Map<
    string,
    { analyser: AnalyserNode; data: Uint8Array; userId: string }
  > = new Map();
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private remoteVadTimer: ReturnType<typeof setInterval> | null = null;

  getAudioContext(): AudioContext {
    this.audioContext ??= new AudioContext();
    return this.audioContext;
  }

  addRemoteAnalyser(stream: MediaStream, userId?: string): void {
    try {
      const ctx = this.getAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.remoteAnalysers.set(stream.id, {
        analyser,
        data: new Uint8Array(analyser.frequencyBinCount),
        userId: userId ?? stream.id,
      });
      this.startRemoteVAD();
    } catch {
      // AudioContext not available
    }
  }

  startRemoteVAD(): void {
    if (this.remoteVadTimer) return; // already running
    const wasSpeaking = new Map<string, boolean>();
    const lastLevel = new Map<string, number>();
    // Only emit a store update when something a human would
    // notice changes:
    //   - speaking flag transition (rare), OR
    //   - level moved by more than this delta WHILE speaking.
    // When not speaking we force level=0 once and stay silent. Without
    // this gate every tick (10 Hz × N peers) pushed a Zustand update
    // and re-rendered the entire member list — see github issue note in
    // changelog. Keeping the threshold small enough that the VU bar
    // still animates smoothly during speech.
    const LEVEL_EMIT_DELTA = 0.05;
    this.remoteVadTimer = setInterval(() => {
      const store = useVoiceStore.getState();
      const userThreshold = useUserSettingsStore.getState().inputThreshold;
      const vadThreshold = Math.round(userThreshold * 100);
      for (const [, entry] of this.remoteAnalysers) {
        entry.analyser.getByteFrequencyData(entry.data as unknown as Uint8Array<ArrayBuffer>);
        const avg = entry.data.reduce((a, b) => a + b, 0) / entry.data.length;
        const level = Math.min(avg / 80, 1);
        const speaking = avg > vadThreshold;
        const prev = wasSpeaking.get(entry.userId) ?? false;
        const prevLevel = lastLevel.get(entry.userId) ?? 0;

        const transition = speaking !== prev;
        const meaningfulLevelChange =
          speaking && Math.abs(level - prevLevel) >= LEVEL_EMIT_DELTA;

        if (!transition && !meaningfulLevelChange) continue;

        // Snap to 0 on transition-to-silent so the UI doesn't keep
        // showing the last animated bar value.
        const emitLevel = speaking ? level : 0;
        wasSpeaking.set(entry.userId, speaking);
        lastLevel.set(entry.userId, emitLevel);
        if (store.peers[entry.userId]) {
          store.updatePeer(entry.userId, { voiceLevel: emitLevel, speaking });
        }
      }
    }, VAD_INTERVAL_MS);
  }

  stopRemoteVAD(): void {
    if (this.remoteVadTimer) {
      clearInterval(this.remoteVadTimer);
      this.remoteVadTimer = null;
    }
  }

  // Mirror of the remote-VAD throttle: only push voiceLevel into the
  // store when it shifts by a perceptible amount during active speech.
  // Tracks last emitted value across calls.
  private localLastLevel = 0;
  private localLastSpeaking = false;
  updateLocalLevel(level: number, speaking: boolean, localUserId: string | null): void {
    if (!localUserId) return;
    const LEVEL_EMIT_DELTA = 0.05;
    const transition = speaking !== this.localLastSpeaking;
    const meaningfulLevelChange =
      speaking && Math.abs(level - this.localLastLevel) >= LEVEL_EMIT_DELTA;
    if (!transition && !meaningfulLevelChange) return;

    const emitLevel = speaking ? level : 0;
    this.localLastLevel = emitLevel;
    this.localLastSpeaking = speaking;
    const store = useVoiceStore.getState();
    if (store.peers[localUserId]) {
      store.updatePeer(localUserId, { voiceLevel: emitLevel, speaking });
    }
  }

  startVAD(
    rawStream: MediaStream | null,
    localStream: MediaStream | null,
    localUserId: string | null,
    processedStream?: MediaStream | null,
  ): void {
    // When DFN3 is active, use the processed stream for VAD so the
    // speaking indicator reflects the cleaned audio, not the raw mic.
    const vadStream = processedStream ?? rawStream ?? localStream;
    if (!vadStream) return;

    try {
      const ctx = this.getAudioContext();
      const source = ctx.createMediaStreamSource(vadStream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      let wasSpeaking = false;

      this.vadTimer = setInterval(() => {
        if (!this.analyser) return;
        const store = useVoiceStore.getState();

        // Never show speaking when muted or deafened
        if (store.muted || store.deafened) {
          if (wasSpeaking) {
            wasSpeaking = false;
            store.setSpeaking(false);
            this.updateLocalLevel(0, false, localUserId);
          }
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const level = Math.min(avg / 80, 1);
        const userThreshold = useUserSettingsStore.getState().inputThreshold;
        const vadThreshold = Math.round(userThreshold * 100);
        const isSpeaking = avg > vadThreshold;

        if (isSpeaking !== wasSpeaking) {
          wasSpeaking = isSpeaking;
          store.setSpeaking(isSpeaking);
        }

        this.updateLocalLevel(level, wasSpeaking, localUserId);
      }, VAD_INTERVAL_MS);
    } catch {
      // AudioContext not available
    }
  }

  stopVAD(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    useVoiceStore.getState().setSpeaking(false);
  }

  /** Clean up all audio resources. Call on disconnect. */
  cleanup(): void {
    this.stopVAD();
    this.stopRemoteVAD();

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.analyser = null;
    this.remoteAnalysers.clear();
  }
}
