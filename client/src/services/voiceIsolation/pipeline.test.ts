// Cover createPipeline + Pipeline.destroy via mocked AudioContext + Worker.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./audioWorklet/ringProtocol', () => ({
  createRing: vi.fn(() => ({ sab: new ArrayBuffer(64) })),
}));

import { createPipeline } from './pipeline';

class FakeAudioWorkletNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeMediaStreamSource {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeMediaStreamDestination {
  stream = {
    getAudioTracks: () => [{ id: 'out-track', kind: 'audio' }],
  };
}

class FakeAudioContext {
  createMediaStreamSource = vi.fn(() => new FakeMediaStreamSource());
  createMediaStreamDestination = vi.fn(() => new FakeMediaStreamDestination());
}

beforeEach(() => {
  (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
  (globalThis as unknown as { MediaStream: unknown }).MediaStream = function MockMediaStream(tracks: MediaStreamTrack[]) {
    return { tracks } as never;
  };
});

describe('createPipeline', () => {
  it('exports a function', () => {
    expect(typeof createPipeline).toBe('function');
  });

  it('posts attach-stream to worker on creation', () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    const track = { id: 'in-track' } as MediaStreamTrack;
    const pipeline = createPipeline({
      audioContext: new FakeAudioContext() as never,
      worker,
      track,
      sessionId: 'sess-1',
    });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'attach-stream', sessionId: 'sess-1',
    }));
    expect(pipeline.outputTrack).toBeTruthy();
  });

  it('connects source -> workletNode -> destination', () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    const audioContext = new FakeAudioContext();
    createPipeline({
      audioContext: audioContext as never,
      worker,
      track: { id: 'tk' } as MediaStreamTrack,
      sessionId: 'sess-1',
    });
    expect(audioContext.createMediaStreamSource).toHaveBeenCalled();
    expect(audioContext.createMediaStreamDestination).toHaveBeenCalled();
  });

  it('destroy() posts detach-stream', () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    const p = createPipeline({
      audioContext: new FakeAudioContext() as never,
      worker,
      track: { id: 'tk' } as MediaStreamTrack,
      sessionId: 'sess-1',
    });
    p.destroy();
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'detach-stream',
    }));
  });

  it('destroy() swallows disconnect errors', () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    class ThrowingNode extends FakeAudioWorkletNode {
      disconnect = vi.fn(() => { throw new Error('already disconnected'); });
    }
    (globalThis as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = ThrowingNode;
    const p = createPipeline({
      audioContext: new FakeAudioContext() as never,
      worker,
      track: { id: 'tk' } as MediaStreamTrack,
      sessionId: 'sess-1',
    });
    expect(() => p.destroy()).not.toThrow();
  });

  it('generates unique stream ids across multiple pipelines', () => {
    const worker = { postMessage: vi.fn() } as unknown as Worker;
    const ctx = new FakeAudioContext();
    createPipeline({ audioContext: ctx as never, worker, track: { id: 'a' } as MediaStreamTrack, sessionId: 's1' });
    createPipeline({ audioContext: ctx as never, worker, track: { id: 'b' } as MediaStreamTrack, sessionId: 's1' });
    const ids = (worker.postMessage as unknown as { mock: { calls: [{ type: string; streamId?: string }][] } }).mock.calls
      .filter((c) => c[0].type === 'attach-stream')
      .map((c) => c[0].streamId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
