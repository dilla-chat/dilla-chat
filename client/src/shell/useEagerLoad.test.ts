import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useEagerLoad } from './useEagerLoad';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';

// vi.mock is hoisted to top of file; references to outer consts crash
// with "Cannot access before initialization". Use vi.hoisted() to
// build the mocks-state up front, so the factories can read it.
const h = vi.hoisted(() => ({
  api: {
    getMessages: vi.fn(),
    getDMChannels: vi.fn(),
    getDMMessages: vi.fn(),
    getChannelThreads: vi.fn(),
    getThreadMessages: vi.fn(),
    getPolls: vi.fn(),
  },
  isMockSession: vi.fn(() => false),
  isCryptoInit: vi.fn(() => true),
  tryDecrypt: vi.fn(async (_id: string, content: string) => content),
  serverToMessage: vi.fn((sm: { id: string; channel_id: string; author_id: string; content: string }, content: string) => ({
    id: sm.id, channelId: sm.channel_id, authorId: sm.author_id, username: 'u', content,
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: '2026-01-01T00:00:00Z', reactions: [],
  })),
  wsOn: vi.fn((_event: string, _hh: unknown) => () => {}),
  wsJoin: vi.fn(),
  wsDistribute: vi.fn(),
  getSenderKeyDistribution: vi.fn(async () => ({ chain_key: [], signing_public_key: [] })),
  decryptDM: vi.fn(async (_t: string, _a: string, content: string) => content),
}));

vi.mock('../services/api', () => ({ api: h.api }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => h.isMockSession() }));
vi.mock('../services/crypto', () => ({
  cryptoService: {
    getSenderKeyDistribution: h.getSenderKeyDistribution,
    decryptDM: h.decryptDM,
  },
  isCryptoInitialized: () => h.isCryptoInit(),
}));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryDecrypt: h.tryDecrypt,
  serverToMessage: h.serverToMessage,
}));
vi.mock('../services/messageCache', () => ({
  getCachedMessage: vi.fn(async () => null),
  cacheMessage: vi.fn(async () => {}),
}));
vi.mock('../services/websocket', () => ({
  ws: {
    on: h.wsOn,
    joinChannel: h.wsJoin,
    distributeChannelKey: h.wsDistribute,
  },
}));
vi.mock('../stores/pollStore', () => ({
  usePollStore: { getState: () => ({ upsert: vi.fn() }) },
  normalizePoll: (p: unknown) => p,
}));

const apiMock = h.api;
const isMockSessionMock = h.isMockSession;
const isCryptoInitMock = h.isCryptoInit;
const tryDecryptMock = h.tryDecrypt;
const serverToMessageMock = h.serverToMessage;
const wsOn = h.wsOn;
const wsJoin = h.wsJoin;
const wsDistribute = h.wsDistribute;

function seedStores() {
  useTeamStore.setState({
    activeTeamId: 't1',
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'voice', type: 'voice' },
    ]]]),
    members: new Map([['t1', [{ userId: 'u1', username: 'me', displayName: 'Me', publicKeyHex: '' }]]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'key' as never });
  useMessageStore.setState({ messages: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {} } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
}

describe('useEagerLoad', () => {
  beforeEach(() => {
    apiMock.getMessages.mockReset().mockResolvedValue([]);
    apiMock.getDMChannels.mockReset().mockResolvedValue([]);
    apiMock.getDMMessages.mockReset().mockResolvedValue([]);
    apiMock.getChannelThreads.mockReset().mockResolvedValue([]);
    apiMock.getThreadMessages.mockReset().mockResolvedValue([]);
    apiMock.getPolls.mockReset().mockResolvedValue([]);
    isMockSessionMock.mockReset().mockReturnValue(false);
    isCryptoInitMock.mockReset().mockReturnValue(true);
    tryDecryptMock.mockReset().mockImplementation(async (_id, c) => c);
    serverToMessageMock.mockClear();
    wsOn.mockClear();
    wsJoin.mockClear();
    wsDistribute.mockClear();
    seedStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ready=false on first render before fetches resolve', () => {
    const { result } = renderHook(() => useEagerLoad('t1'));
    expect(result.current.ready).toBe(false);
  });

  it('flips ready=true after all fetches land', async () => {
    const { result } = renderHook(() => useEagerLoad('t1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(apiMock.getMessages).toHaveBeenCalledWith('t1', 'ch-1', 50);
    expect(apiMock.getDMChannels).toHaveBeenCalledWith('t1');
    expect(apiMock.getChannelThreads).toHaveBeenCalledWith('t1', 'ch-1');
    expect(apiMock.getPolls).toHaveBeenCalledWith('t1', 'ch-1');
  });

  it('does NOT fetch when activeTeamId is null', async () => {
    renderHook(() => useEagerLoad(null));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.getMessages).not.toHaveBeenCalled();
  });

  it('does NOT fetch when channels are empty', async () => {
    useTeamStore.setState({ channels: new Map([['t1', []]]) } as never);
    renderHook(() => useEagerLoad('t1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.getMessages).not.toHaveBeenCalled();
  });

  it('does NOT fetch when cryptoReady is false (and not a mock session)', async () => {
    isMockSessionMock.mockReturnValue(false);
    renderHook(() => useEagerLoad('t1', /*cryptoReady*/ false));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.getMessages).not.toHaveBeenCalled();
  });

  it('does NOT fetch when crypto is not initialized', async () => {
    isCryptoInitMock.mockReturnValue(false);
    renderHook(() => useEagerLoad('t1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.getMessages).not.toHaveBeenCalled();
  });

  it('mock session bypasses crypto + cryptoReady gates', async () => {
    isMockSessionMock.mockReturnValue(true);
    isCryptoInitMock.mockReturnValue(false);
    const { result } = renderHook(() => useEagerLoad('t1', /*cryptoReady*/ false));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(apiMock.getMessages).toHaveBeenCalled();
    // Sender-key distribute is skipped on /mesh; joinChannel still fires.
    expect(wsDistribute).not.toHaveBeenCalled();
    expect(wsJoin).toHaveBeenCalled();
  });

  it('only text channels are fetched (voice channels skipped)', async () => {
    const { result } = renderHook(() => useEagerLoad('t1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const ids = apiMock.getMessages.mock.calls.map((c) => c[1]);
    expect(ids).toContain('ch-1');
    expect(ids).not.toContain('ch-2');
  });

  it('prepends fetched messages into messageStore', async () => {
    apiMock.getMessages.mockResolvedValue([
      { id: 'm1', channel_id: 'ch-1', author_id: 'u', content: 'hi', created_at: '2026-01-01' },
    ]);
    const { result } = renderHook(() => useEagerLoad('t1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const stored = useMessageStore.getState().messages.get('ch-1');
    expect(stored?.[0]?.id).toBe('m1');
  });

  it('sets hasMore=true when fetch returned a full page', async () => {
    apiMock.getMessages.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`, channel_id: 'ch-1', author_id: 'u', content: 'x',
      })),
    );
    const { result } = renderHook(() => useEagerLoad('t1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(useMessageStore.getState().hasMore.get('ch-1')).toBe(true);
  });

  it('sets hasMore=false when fetch returned a short page', async () => {
    apiMock.getMessages.mockResolvedValue([
      { id: 'm1', channel_id: 'ch-1', author_id: 'u', content: 'x' },
    ]);
    const { result } = renderHook(() => useEagerLoad('t1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(useMessageStore.getState().hasMore.get('ch-1')).toBe(false);
  });

  it('subscribes to ws:connected for offline-edit refetch', () => {
    renderHook(() => useEagerLoad('t1'));
    expect(wsOn).toHaveBeenCalledWith('ws:connected', expect.any(Function));
  });

  it('runs only once per active team (de-duped via internal Set)', async () => {
    const { result, rerender } = renderHook(() => useEagerLoad('t1'));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const before = apiMock.getMessages.mock.calls.length;
    act(() => { rerender(); });
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.getMessages.mock.calls.length).toBe(before);
  });

  it('tolerates fetch rejections (mock session) without throwing', async () => {
    isMockSessionMock.mockReturnValue(true);
    apiMock.getMessages.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useEagerLoad('t1'));
    // Should still flip ready=true; promise chain swallows the error.
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});
