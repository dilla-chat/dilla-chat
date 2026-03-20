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
  noiseSuppression: { cleanup: () => void } | null;
  timeDomainData: Float32Array;
}

export interface MicTestOptions {
  audioConstraints: MediaTrackConstraints | boolean;
  inputVolume: number;
  useRNNoise: boolean;
  createNoiseSuppression?: () => {
    initWorklet: (ctx: AudioContext) => Promise<void>;
    getWorkletNode: () => AudioNode | null;
    cleanup: () => void;
  };
  onLevelUpdate: (level: number) => void;
}

/**
 * Start a mic test session: acquire mic, build audio graph, start metering.
 */
export async function startMicTest(options: MicTestOptions): Promise<MicTestSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: options.audioConstraints });

  const audioContext = options.useRNNoise
    ? new AudioContext({ sampleRate: 48000 })
    : new AudioContext();

  const source = audioContext.createMediaStreamSource(stream);

  const gainNode = audioContext.createGain();
  gainNode.gain.value = options.inputVolume;

  let noiseSuppression: MicTestSession['noiseSuppression'] = null;

  if (options.useRNNoise && options.createNoiseSuppression) {
    const ns = options.createNoiseSuppression();
    noiseSuppression = ns;
    await ns.initWorklet(audioContext);
    const worklet = ns.getWorkletNode()!;
    source.connect(worklet);
    worklet.connect(gainNode);
  } else {
    source.connect(gainNode);
  }

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;
  gainNode.connect(analyser);

  const timeDomainData = new Float32Array(analyser.fftSize);

  let animFrameId = 0;
  const update = () => {
    analyser.getFloatTimeDomainData(timeDomainData);
    let sum = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      sum += timeDomainData[i] * timeDomainData[i];
    }
    const rms = Math.sqrt(sum / timeDomainData.length);
    const scaled = Math.min(rms * 4, 1);
    options.onLevelUpdate(scaled);
    animFrameId = requestAnimationFrame(update);
  };
  animFrameId = requestAnimationFrame(update);

  return { stream, audioContext, analyser, gainNode, animFrameId, noiseSuppression, timeDomainData };
}

/**
 * Stop a mic test session: release all resources.
 */
export function stopMicTest(session: MicTestSession | null): void {
  if (!session) return;

  cancelAnimationFrame(session.animFrameId);

  if (session.noiseSuppression) {
    session.noiseSuppression.cleanup();
  }

  session.stream.getTracks().forEach(t => t.stop());

  session.audioContext.close().catch(() => {});
}

/**
 * Compute RMS level from time-domain audio data.
 * Exported for direct unit testing.
 */
export function computeRmsLevel(timeDomainData: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    sum += timeDomainData[i] * timeDomainData[i];
  }
  const rms = Math.sqrt(sum / timeDomainData.length);
  return Math.min(rms * 4, 1);
}
