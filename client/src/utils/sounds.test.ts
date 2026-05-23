import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom doesn't ship a working AudioContext. Stub one before importing.
class FakeOscillator {
  type = 'sine';
  frequency = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGainNode {
  gain = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
  connect = vi.fn();
}

let lastCtx: FakeAudioContext;

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createOscillator = vi.fn(() => new FakeOscillator());
  createGain = vi.fn(() => new FakeGainNode());
  constructor() {
    lastCtx = this;
  }
}

(globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;

import { playMuteSound, playUnmuteSound } from './sounds';

describe('sounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('playMuteSound creates an AudioContext, oscillator, and gain node', () => {
    playMuteSound();
    expect(lastCtx.createOscillator).toHaveBeenCalledTimes(1);
    expect(lastCtx.createGain).toHaveBeenCalledTimes(1);
  });

  it('playMuteSound ramps frequency down from 900Hz to 500Hz', () => {
    playMuteSound();
    const osc = lastCtx.createOscillator.mock.results[0].value as FakeOscillator;
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(900, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(500, 0.12);
  });

  it('playUnmuteSound ramps frequency up from 500Hz to 900Hz', () => {
    playUnmuteSound();
    const osc = lastCtx.createOscillator.mock.results[0].value as FakeOscillator;
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(500, 0);
    expect(osc.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(900, 0.12);
  });

  it('starts and stops the oscillator at currentTime + 0.12s', () => {
    playMuteSound();
    const osc = lastCtx.createOscillator.mock.results[0].value as FakeOscillator;
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledWith(0.12);
  });

  it('gain envelope ramps down from 0.2 to 0.001', () => {
    playMuteSound();
    const gain = lastCtx.createGain.mock.results[0].value as FakeGainNode;
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.2, 0);
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.001, 0.12);
  });

  it('connects oscillator → gain → destination', () => {
    playMuteSound();
    const osc = lastCtx.createOscillator.mock.results[0].value as FakeOscillator;
    const gain = lastCtx.createGain.mock.results[0].value as FakeGainNode;
    expect(osc.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(lastCtx.destination);
  });
});
