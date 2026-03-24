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
        if (speaking !== prev || level > 0) {
          wasSpeaking.set(entry.userId, speaking);
          if (store.peers[entry.userId]) {
            store.updatePeer(entry.userId, { voiceLevel: level, speaking });
          }
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

  updateLocalLevel(level: number, speaking: boolean, localUserId: string | null): void {
    if (!localUserId) return;
    const store = useVoiceStore.getState();
    if (store.peers[localUserId]) {
      store.updatePeer(localUserId, { voiceLevel: level, speaking });
    }
  }

  startVAD(
    rawStream: MediaStream | null,
    localStream: MediaStream | null,
    localUserId: string | null,
  ): void {
    // Use raw (unprocessed) stream for VAD -- gives more accurate threshold detection
    const vadStream = rawStream ?? localStream;
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
        this.analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const level = Math.min(avg / 80, 1);
        const userThreshold = useUserSettingsStore.getState().inputThreshold;
        const vadThreshold = Math.round(userThreshold * 100);
        const isSpeaking = avg > vadThreshold;

        if (isSpeaking !== wasSpeaking) {
          wasSpeaking = isSpeaking;
          useVoiceStore.getState().setSpeaking(isSpeaking);
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
