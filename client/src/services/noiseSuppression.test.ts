import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoiseSuppression } from './noiseSuppression';

describe('NoiseSuppression', () => {
  let ns: NoiseSuppression;

  beforeEach(() => {
    ns = new NoiseSuppression();
  });

  it('defaults to enabled', () => {
    expect(ns.isEnabled()).toBe(true);
  });

  it('defaults to not initialized', () => {
    expect(ns.isInitialized()).toBe(false);
  });

  it('getWorkletNode returns null before init', () => {
    expect(ns.getWorkletNode()).toBeNull();
  });

  it('setEnabled toggles the flag', () => {
    ns.setEnabled(false);
    expect(ns.isEnabled()).toBe(false);
    ns.setEnabled(true);
    expect(ns.isEnabled()).toBe(true);
  });

  it('setEnabled sends message to worklet when node exists', () => {
    const mockPort = { postMessage: vi.fn(), onmessage: null };
    const mockNode = { port: mockPort, disconnect: vi.fn() } as unknown as AudioWorkletNode;
    // Access private field for testing
    (ns as unknown as Record<string, unknown>).workletNode = mockNode;

    ns.setEnabled(false);
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'enable', enabled: false });
  });

  it('setVadThreshold sends message when node exists', () => {
    const mockPort = { postMessage: vi.fn(), onmessage: null };
    const mockNode = { port: mockPort, disconnect: vi.fn() } as unknown as AudioWorkletNode;
    (ns as unknown as Record<string, unknown>).workletNode = mockNode;

    ns.setVadThreshold(0.5);
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'vadThreshold', value: 0.5 });
  });

  it('setVadGracePeriodMs sends message when node exists', () => {
    const mockPort = { postMessage: vi.fn(), onmessage: null };
    const mockNode = { port: mockPort, disconnect: vi.fn() } as unknown as AudioWorkletNode;
    (ns as unknown as Record<string, unknown>).workletNode = mockNode;

    ns.setVadGracePeriodMs(300);
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'vadGracePeriodMs', value: 300 });
  });

  it('setRetroactiveGraceMs sends message when node exists', () => {
    const mockPort = { postMessage: vi.fn(), onmessage: null };
    const mockNode = { port: mockPort, disconnect: vi.fn() } as unknown as AudioWorkletNode;
    (ns as unknown as Record<string, unknown>).workletNode = mockNode;

    ns.setRetroactiveGraceMs(100);
    expect(mockPort.postMessage).toHaveBeenCalledWith({ type: 'retroactiveGraceMs', value: 100 });
  });

  it('cleanup disconnects node and resets state', () => {
    const mockPort = { postMessage: vi.fn(), onmessage: null };
    const mockNode = { port: mockPort, disconnect: vi.fn() } as unknown as AudioWorkletNode;
    (ns as unknown as Record<string, unknown>).workletNode = mockNode;
    (ns as unknown as Record<string, unknown>).initialized = true;

    ns.cleanup();

    expect(mockNode.disconnect).toHaveBeenCalled();
    expect(ns.getWorkletNode()).toBeNull();
    expect(ns.isInitialized()).toBe(false);
  });

  it('cleanup handles null node gracefully', () => {
    expect(() => ns.cleanup()).not.toThrow();
  });

  it('waitForReady resolves true immediately when initialized', async () => {
    (ns as unknown as Record<string, unknown>).initialized = true;
    const result = await ns.waitForReady();
    expect(result).toBe(true);
  });

  it('waitForReady resolves false on timeout when not initialized', async () => {
    const result = await ns.waitForReady(100);
    expect(result).toBe(false);
  });

  it('waitForReady resolves true when initialized during wait', async () => {
    // Set initialized to true after a delay
    setTimeout(() => {
      (ns as unknown as Record<string, unknown>).initialized = true;
    }, 50);
    const result = await ns.waitForReady(500);
    expect(result).toBe(true);
  });

  it('setVadThreshold does nothing when no node', () => {
    expect(() => ns.setVadThreshold(0.5)).not.toThrow();
  });

  it('setVadGracePeriodMs does nothing when no node', () => {
    expect(() => ns.setVadGracePeriodMs(300)).not.toThrow();
  });

  it('setRetroactiveGraceMs does nothing when no node', () => {
    expect(() => ns.setRetroactiveGraceMs(100)).not.toThrow();
  });

  it('setEnabled without node only sets the flag', () => {
    ns.setEnabled(false);
    expect(ns.isEnabled()).toBe(false);
    // No postMessage should be called (no node)
  });

  it('cleanup with store unsubscribe', () => {
    const unsub = vi.fn();
    (ns as unknown as Record<string, unknown>).storeUnsubscribe = unsub;

    ns.cleanup();
    expect(unsub).toHaveBeenCalled();
    expect(ns.isInitialized()).toBe(false);
  });

  it('initWorklet creates worklet node and sets up handlers', async () => {
    const ns2 = new NoiseSuppression();
    const mockWorkletNode = {
      port: {
        postMessage: vi.fn(),
        onmessage: null as ((e: MessageEvent) => void) | null,
      },
      disconnect: vi.fn(),
    };

    const mockCtx = {
      audioWorklet: {
        addModule: vi.fn().mockResolvedValue(undefined),
      },
    };

    const OrigAWN = globalThis.AudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioWorkletNode = function() { return mockWorkletNode; };

    await ns2.initWorklet(mockCtx as unknown as AudioContext);

    expect(mockCtx.audioWorklet.addModule).toHaveBeenCalled();
    expect(ns2.getWorkletNode()).toBe(mockWorkletNode);
    expect(mockWorkletNode.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'enable', enabled: true }),
    );

    // Simulate ready message
    mockWorkletNode.port.onmessage!({ data: { type: 'ready' } } as MessageEvent);
    expect(ns2.isInitialized()).toBe(true);

    // Clean up
    ns2.cleanup();
    if (OrigAWN) {
      (globalThis as Record<string, unknown>).AudioWorkletNode = OrigAWN;
    } else {
      delete (globalThis as Record<string, unknown>).AudioWorkletNode;
    }
  });
});
