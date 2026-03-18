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
});
