// Cover groupSessionWorkerImpl ops: encrypt/decrypt/processDistribution/rotate/getDistribution.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sessionStoreMock = vi.hoisted(() => ({
  loadSession: vi.fn(async () => null),
  saveSession: vi.fn(async () => {}),
}));
vi.mock('./sessionStoreWorkerImpl', () => sessionStoreMock);

const groupSessionMock = vi.hoisted(() => {
  const fake = {
    encrypt: vi.fn(async (pt: Uint8Array) => ({ chain: 'c', cipher: Array.from(pt) })),
    decrypt: vi.fn(async (_msg: unknown) => new Uint8Array([0x68, 0x69])), // 'hi'
    processDistribution: vi.fn(),
    rotateMyKey: vi.fn(async () => {}),
    removeMember: vi.fn(),
    createDistributionMessage: vi.fn(() => ({ chain: 'd' })),
    toJSON: vi.fn(() => ({ stored: true })),
  };
  return {
    fake,
    GroupSession: {
      create: vi.fn(async () => fake),
      fromJSON: vi.fn(() => fake),
    },
  };
});
vi.mock('./groupSession', () => ({ GroupSession: groupSessionMock.GroupSession }));

vi.mock('./helpers', () => ({
  fromBase64: (s: string) => new Uint8Array(atob(s).split('').map((c) => c.charCodeAt(0))),
  toBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
}));

import {
  opEncrypt, opDecrypt, opProcessDistribution, opRotateMyKey, opGetDistribution,
  resetSessionCache,
} from './groupSessionWorkerImpl';

beforeEach(() => {
  sessionStoreMock.loadSession.mockClear();
  sessionStoreMock.saveSession.mockClear();
  Object.values(groupSessionMock.fake).forEach((f) => 'mockClear' in f && (f as { mockClear: () => void }).mockClear());
  groupSessionMock.GroupSession.create.mockClear();
  groupSessionMock.GroupSession.fromJSON.mockClear();
  resetSessionCache();
});

describe('opEncrypt', () => {
  it('creates fresh session + encrypts + persists', async () => {
    const out = await opEncrypt('ch-1', 'me', btoa('hello'));
    expect(out).toBeTruthy();
    expect(sessionStoreMock.saveSession).toHaveBeenCalledWith('ch-1', { stored: true });
  });

  it('loads existing session + encrypts', async () => {
    sessionStoreMock.loadSession.mockResolvedValueOnce({ stored: true });
    const out = await opEncrypt('ch-1', 'me', btoa('hi'));
    expect(out).toBeTruthy();
  });
});

describe('opDecrypt', () => {
  it('throws when no session exists', async () => {
    sessionStoreMock.loadSession.mockResolvedValueOnce(null);
    await expect(opDecrypt('ch-x', btoa('{}'))).rejects.toThrow(/No group session/);
  });

  it('decrypts when session exists', async () => {
    sessionStoreMock.loadSession.mockResolvedValueOnce({ stored: true });
    const wire = btoa(JSON.stringify({ chain: 'c', cipher: [1, 2, 3] }));
    const out = await opDecrypt('ch-1', wire);
    expect(typeof out).toBe('string');
  });
});

describe('opProcessDistribution', () => {
  it('processes a peer distribute, creates session if needed', async () => {
    await opProcessDistribution('ch-1', 'me', '{"distribute":"x"}');
    expect(groupSessionMock.fake.processDistribution).toHaveBeenCalled();
  });

  it('uses existing session when available', async () => {
    sessionStoreMock.loadSession.mockResolvedValueOnce({ stored: true });
    await opProcessDistribution('ch-1', 'me', '{"distribute":"x"}');
    expect(groupSessionMock.fake.processDistribution).toHaveBeenCalled();
  });
});

describe('opRotateMyKey', () => {
  it('returns null when no session exists', async () => {
    sessionStoreMock.loadSession.mockResolvedValueOnce(null);
    const out = await opRotateMyKey('ch-x', 'u-evicted');
    expect(out).toBeNull();
  });

  it('rotates + removes member + returns new dist', async () => {
    sessionStoreMock.loadSession.mockResolvedValueOnce({ stored: true });
    const out = await opRotateMyKey('ch-1', 'u-evicted');
    expect(out).toBeTruthy();
    expect(groupSessionMock.fake.removeMember).toHaveBeenCalledWith('u-evicted');
    expect(groupSessionMock.fake.rotateMyKey).toHaveBeenCalled();
  });
});

describe('opGetDistribution', () => {
  it('returns distribution JSON, creating session if missing', async () => {
    const out = await opGetDistribution('ch-1', 'me');
    expect(typeof out).toBe('string');
    expect(JSON.parse(out)).toEqual({ chain: 'd' });
  });

  it('uses cached session on repeat calls', async () => {
    await opGetDistribution('ch-1', 'me');
    groupSessionMock.GroupSession.create.mockClear();
    await opGetDistribution('ch-1', 'me');
    expect(groupSessionMock.GroupSession.create).not.toHaveBeenCalled();
  });
});

describe('resetSessionCache', () => {
  it('clears the cache so next op reloads', async () => {
    await opGetDistribution('ch-1', 'me');
    resetSessionCache();
    sessionStoreMock.loadSession.mockClear();
    await opGetDistribution('ch-1', 'me');
    expect(sessionStoreMock.loadSession).toHaveBeenCalled();
  });
});
