/**
 * Extracted mic test logic from UserSettings.
 * Handles audio graph construction, level metering, and cleanup.
 */

export interface MicTestSession {
  stream: MediaStream;
  audioContext: AudioContext;
  analyser: AnalyserNode;
  gainNode: GainNode;
  animFrameId: number;
  timeDomainData: Float32Array;
}

export interface MicTestOptions {
  audioConstraints: MediaTrackConstraints | boolean;
  inputVolume: number;
  onLevelUpdate: (level: number) => void;
}

/**
 * Start a mic test session: acquire mic, build audio graph, start metering.
 */
export async function startMicTest(options: MicTestOptions): Promise<MicTestSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: options.audioConstraints });

  const audioContext = new AudioContext();

  const source = audioContext.createMediaStreamSource(stream);

  const gainNode = audioContext.createGain();
  gainNode.gain.value = options.inputVolume;

  source.connect(gainNode);

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;
  gainNode.connect(analyser);

  const timeDomainData = new Float32Array(analyser.fftSize);

  let animFrameId: number;
  const update = () => {
    analyser.getFloatTimeDomainData(timeDomainData);
    const rms = computeRmsLevel(timeDomainData);
    options.onLevelUpdate(rms);
    animFrameId = requestAnimationFrame(update);
  };
  animFrameId = requestAnimationFrame(update);

  return { stream, audioContext, analyser, gainNode, animFrameId, timeDomainData };
}

/**
 * Stop a mic test session: release all resources.
 */
export function stopMicTest(session: MicTestSession | null): void {
  if (!session) return;

  cancelAnimationFrame(session.animFrameId);

  session.stream.getTracks().forEach(t => t.stop());

  session.audioContext.close().catch(() => {});
}

/**
 * Compute RMS level from time-domain audio data.
 * Exported for direct unit testing.
 */
export function computeRmsLevel(timeDomainData: Float32Array): number {
  let sum = 0;
  for (const sample of timeDomainData) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / timeDomainData.length);
  return Math.min(rms * 4, 1);
}
