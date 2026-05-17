import { describe, it, expect, beforeEach } from 'vitest';
import { useMeshStore } from './meshStore';

beforeEach(() => {
  useMeshStore.setState({
    nodeName: '',
    peersConnected: 0,
    peersTotal: 0,
    lamport: 0,
    latencyMs: 0,
    status: 'ready',
    connectionBanner: null,
  });
});

describe('meshStore', () => {
  it('exposes defaults', () => {
    const s = useMeshStore.getState();
    expect(s.nodeName).toBe('');
    expect(s.peersConnected).toBe(0);
    expect(s.peersTotal).toBe(0);
    expect(s.lamport).toBe(0);
    expect(s.latencyMs).toBe(0);
    expect(s.status).toBe('ready');
    expect(s.connectionBanner).toBeNull();
  });

  it('setNodeName updates value', () => {
    useMeshStore.getState().setNodeName('gbg-1.dilla.local');
    expect(useMeshStore.getState().nodeName).toBe('gbg-1.dilla.local');
  });

  it('setPeers updates connected + total atomically', () => {
    useMeshStore.getState().setPeers(2, 3);
    const s = useMeshStore.getState();
    expect(s.peersConnected).toBe(2);
    expect(s.peersTotal).toBe(3);
  });

  it('setLamport + tickLamport', () => {
    useMeshStore.getState().setLamport(100);
    expect(useMeshStore.getState().lamport).toBe(100);
    useMeshStore.getState().tickLamport();
    expect(useMeshStore.getState().lamport).toBe(101);
  });

  it('setLatency clamps to non-negative', () => {
    useMeshStore.getState().setLatency(42);
    expect(useMeshStore.getState().latencyMs).toBe(42);
    useMeshStore.getState().setLatency(-5);
    expect(useMeshStore.getState().latencyMs).toBe(0);
  });

  it('setStatus accepts ok/degraded/ready', () => {
    useMeshStore.getState().setStatus('ok');
    expect(useMeshStore.getState().status).toBe('ok');
    useMeshStore.getState().setStatus('degraded');
    expect(useMeshStore.getState().status).toBe('degraded');
    useMeshStore.getState().setStatus('ready');
    expect(useMeshStore.getState().status).toBe('ready');
  });

  it('showConnectionBanner / hideConnectionBanner', () => {
    useMeshStore.getState().showConnectionBanner({
      kind: 'reconnecting',
      message: 'Reconnecting to peer…',
    });
    expect(useMeshStore.getState().connectionBanner).toEqual({
      kind: 'reconnecting',
      message: 'Reconnecting to peer…',
    });
    useMeshStore.getState().hideConnectionBanner();
    expect(useMeshStore.getState().connectionBanner).toBeNull();
  });
});
