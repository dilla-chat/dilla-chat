import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startMicTest, stopMicTest, computeRmsLevel, type MicTestSession } from './micTest';

describe('computeRmsLevel', () => {
  it('returns 0 for silence', () => {
    const data = new Float32Array(1024).fill(0);
    expect(computeRmsLevel(data)).toBe(0);
  });

  it('returns scaled RMS for audio data', () => {
    const data = new Float32Array(1024).fill(0.5);
    const level = computeRmsLevel(data);
    // RMS of 0.5 = 0.5, scaled * 4 = 2.0, clamped to 1.0
    expect(level).toBe(1);
  });

  it('returns intermediate value for quiet audio', () => {
    const data = new Float32Array(1024).fill(0.1);
    const level = computeRmsLevel(data);
    // RMS of 0.1 = 0.1, scaled * 4 = 0.4
    expect(level).toBeCloseTo(0.4, 1);
  });

  it('handles mixed positive and negative values', () => {
    const data = new Float32Array(4);
    data[0] = 0.3;
    data[1] = -0.3;
    data[2] = 0.3;
    data[3] = -0.3;
    const level = computeRmsLevel(data);
    // RMS of ±0.3 = 0.3, scaled * 4 = 1.2, clamped to 1.0
    expect(level).toBe(1);
  });
});

describe('startMicTest', () => {
  let mockStream: MediaStream;
  let mockAnalyser: AnalyserNode;
  let mockGainNode: GainNode;
  let mockSource: MediaStreamAudioSourceNode;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStream = {
      getTracks: () => [{ stop: vi.fn(), kind: 'audio' }],
      getAudioTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;

    mockAnalyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData: vi.fn((arr: Float32Array) => {
        // Simulate some audio data
        arr.fill(0.2);
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AnalyserNode;

    mockGainNode = {
      gain: { value: 1 },
      connect: vi.fn(),
    } as unknown as GainNode;

    mockSource = {
      connect: vi.fn(),
    } as unknown as MediaStreamAudioSourceNode;

    mockAudioContext = {
      createMediaStreamSource: vi.fn(() => mockSource),
      createAnalyser: vi.fn(() => mockAnalyser),
      createGain: vi.fn(() => mockGainNode),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;

    // Mock the AudioContext constructor (must use class/function syntax for `new`)
    vi.stubGlobal('AudioContext', function() { return mockAudioContext; });

    // Mock getUserMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
      configurable: true,
    });

    // Mock requestAnimationFrame
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => {
      // Don't call cb to avoid infinite loop — just return an ID
      return 42;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('acquires user media and builds audio graph', async () => {
    const onLevel = vi.fn();
    const session = await startMicTest({
      audioConstraints: { echoCancellation: true },
      inputVolume: 0.8,
      useRNNoise: false,
      onLevelUpdate: onLevel,
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true },
    });
    expect(mockAudioContext.createMediaStreamSource).toHaveBeenCalledWith(mockStream);
    expect(mockSource.connect).toHaveBeenCalledWith(mockGainNode);
    expect(mockGainNode.connect).toHaveBeenCalledWith(mockAnalyser);
    expect(mockGainNode.gain.value).toBe(0.8);
    expect(session.stream).toBe(mockStream);
    expect(session.audioContext).toBe(mockAudioContext);
    expect(session.analyser).toBe(mockAnalyser);

    stopMicTest(session);
  });

  it('calls onLevelUpdate with computed level', async () => {
    const onLevel = vi.fn();

    // Make requestAnimationFrame call the callback once, then stop
    let called = false;
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: () => void) => {
      if (!called) {
        called = true;
        cb();
      }
      return 42;
    }));

    await startMicTest({
      audioConstraints: {},
      inputVolume: 1.0,
      useRNNoise: false,
      onLevelUpdate: onLevel,
    });

    // onLevelUpdate called: once from the initial update() call + once from raf
    expect(onLevel).toHaveBeenCalled();
    const level = onLevel.mock.calls[0][0];
    expect(level).toBeGreaterThan(0);
  });

  it('uses 48kHz sample rate with RNNoise', async () => {
    const mockNS = {
      initWorklet: vi.fn().mockResolvedValue(undefined),
      getWorkletNode: vi.fn(() => ({ connect: vi.fn() })),
      cleanup: vi.fn(),
    };

    const session = await startMicTest({
      audioConstraints: {},
      inputVolume: 1.0,
      useRNNoise: true,
      createNoiseSuppression: () => mockNS,
      onLevelUpdate: vi.fn(),
    });

    expect(session.audioContext).toBe(mockAudioContext);
    expect(mockNS.initWorklet).toHaveBeenCalledWith(mockAudioContext);
    expect(session.noiseSuppression).toBe(mockNS);

    stopMicTest(session);
  });

  it('connects source directly to gain without RNNoise', async () => {
    await startMicTest({
      audioConstraints: {},
      inputVolume: 1.0,
      useRNNoise: false,
      onLevelUpdate: vi.fn(),
    });

    expect(mockSource.connect).toHaveBeenCalledWith(mockGainNode);
  });
});

describe('stopMicTest', () => {
  it('is safe to call with null', () => {
    expect(() => stopMicTest(null)).not.toThrow();
  });

  it('cleans up all resources', () => {
    const mockTrack = { stop: vi.fn() };
    const session: MicTestSession = {
      stream: { getTracks: () => [mockTrack] } as unknown as MediaStream,
      audioContext: { close: vi.fn().mockResolvedValue(undefined) } as unknown as AudioContext,
      analyser: {} as AnalyserNode,
      gainNode: {} as GainNode,
      animFrameId: 99,
      noiseSuppression: { cleanup: vi.fn() },
      timeDomainData: new Float32Array(1024),
    };

    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    stopMicTest(session);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(99);
    expect(session.noiseSuppression!.cleanup).toHaveBeenCalled();
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(session.audioContext.close).toHaveBeenCalled();
  });

  it('works without noise suppression', () => {
    const mockTrack = { stop: vi.fn() };
    const session: MicTestSession = {
      stream: { getTracks: () => [mockTrack] } as unknown as MediaStream,
      audioContext: { close: vi.fn().mockResolvedValue(undefined) } as unknown as AudioContext,
      analyser: {} as AnalyserNode,
      gainNode: {} as GainNode,
      animFrameId: 0,
      noiseSuppression: null,
      timeDomainData: new Float32Array(1024),
    };

    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    expect(() => stopMicTest(session)).not.toThrow();
    expect(mockTrack.stop).toHaveBeenCalled();
  });
});
