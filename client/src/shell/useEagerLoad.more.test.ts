// Cover DM/thread/poll/distribute paths in useEagerLoad that aren't
// drilled by the existing test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  api: {
    getMessages: vi.fn().mockResolvedValue([]),
    getDMChannels: vi.fn().mockResolvedValue([]),
    getDMMessages: vi.fn().mockResolvedValue([]),
    getChannelThreads: vi.fn().mockResolvedValue([]),
    getThreadMessages: vi.fn().mockResolvedValue([]),
    getPolls: vi.fn().mockResolvedValue([]),
  },
  isMockSession: vi.fn(() => false),
  isCryptoInit: vi.fn(() => true),
  tryDecrypt: vi.fn(async (_id: string, content: string) => content),
  serverToMessage: vi.fn((sm: { id: string; channel_id: string; author_id: string; content: string }, content: string) => ({
    id: sm.id, channelId: sm.channel_id, authorId: sm.author_id, username: 'u', content,
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: '2026-01-01T00:00:00Z', reactions: [],
  })),
  decryptDM: vi.fn(async (_t: string, _s: string, ct: string) => `pt:${ct}`),
  getSenderKeyDistribution: vi.fn().mockResolvedValue('dist'),
  joinChannel: vi.fn(),
  distributeChannelKey: vi.fn(),
  wsOn: vi.fn(() => () => {}),
}));

vi.mock('../services/api', () => ({ api: h.api }));
vi.mock('../services/mockSession', () => ({ isMockSession: h.isMockSession }));
vi.mock('../services/crypto', () => ({
  cryptoService: {
    decryptDM: h.decryptDM,
    getSenderKeyDistribution: h.getSenderKeyDistribution,
  },
  isCryptoInitialized: () => h.isCryptoInit(),
}));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryDecrypt: h.tryDecrypt,
  serverToMessage: h.serverToMessage,
}));
vi.mock('../services/messageCache', () => ({
  getCachedMessage: vi.fn(async () => null),
  cacheMessage: vi.fn(),
}));
vi.mock('../services/websocket', () => ({
  ws: {
    on: h.wsOn,
    joinChannel: h.joinChannel,
    distributeChannelKey: h.distributeChannelKey,
  },
}));
vi.mock('../stores/pollStore', () => ({
  usePollStore: { getState: () => ({ upsert: vi.fn() }) },
  normalizePoll: (p: unknown) => p,
}));

import { useEagerLoad } from './useEagerLoad';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useDMStore } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';

function seed() {
  useAuthStore.setState({
    teams: new Map([['t1', { token: 'tok', user: { id: 'me' }, teamInfo: {}, baseUrl: 'https://srv' }]]),
    derivedKey: 'dk',
  } as never);
  useTeamStore.setState({
    activeTeamId: 't1',
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'random', type: 'text' },
      { id: 'ch-voice', name: 'lounge', type: 'voice' },
    ]]]),
    members: new Map([['t1', [{ id: 'm1', userId: 'me', username: 'me' }]]]),
  } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, dmTyping: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: new Map(), threadMessages: new Map() } as never);
}

beforeEach(() => {
  for (const fn of Object.values(h.api)) fn.mockClear();
  h.joinChannel.mockClear();
  h.distributeChannelKey.mockClear();
  h.getSenderKeyDistribution.mockClear();
  h.decryptDM.mockClear();
  h.isMockSession.mockReturnValue(false);
  h.isCryptoInit.mockReturnValue(true);
  seed();
});

describe('DM eager load', () => {
  it('fetches DM channels + per-DM messages and stashes them', async () => {
    h.api.getDMChannels.mockResolvedValueOnce([
      { id: 'dm-1', participantIds: ['me', 'u2'] },
      { id: 'dm-2', participantIds: ['me', 'u3'] },
    ]);
    h.api.getDMMessages.mockResolvedValue([
      { id: 'dm-m1', channel_id: 'dm-1', author_id: 'u2', content: 'ct', type: 'text' },
    ]);
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => {
      expect(h.api.getDMChannels).toHaveBeenCalledWith('t1');
      expect(h.api.getDMMessages).toHaveBeenCalled();
    });
  });

  it('decryptDM is called for non-mock sessions', async () => {
    h.api.getDMChannels.mockResolvedValueOnce([{ id: 'dm-1', participantIds: ['me', 'u2'] }]);
    h.api.getDMMessages.mockResolvedValueOnce([{ id: 'dm-m1', channel_id: 'dm-1', author_id: 'u2', content: 'ct', type: 'text' }]);
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => expect(h.decryptDM).toHaveBeenCalled());
  });
});

describe('Thread eager load', () => {
  it('fetches threads + thread messages per text channel', async () => {
    h.api.getChannelThreads.mockResolvedValue([{ id: 'th-1', name: 'topic' }]);
    h.api.getThreadMessages.mockResolvedValue([
      { id: 'tm-1', channel_id: 'ch-1', author_id: 'me', content: 'tx', type: 'text' },
    ]);
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => {
      expect(h.api.getChannelThreads).toHaveBeenCalledWith('t1', 'ch-1');
      expect(h.api.getThreadMessages).toHaveBeenCalled();
    });
  });
});

describe('Poll eager load', () => {
  it('fetches polls per text channel', async () => {
    h.api.getPolls.mockResolvedValue([{ id: 'p1', question: 'Q?', options: [] }]);
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => expect(h.api.getPolls).toHaveBeenCalledWith('t1', 'ch-1'));
  });
});

describe('Sender-key distribute', () => {
  it('joins + distributes key for every text channel when crypto ready', async () => {
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => {
      expect(h.joinChannel).toHaveBeenCalled();
      expect(h.distributeChannelKey).toHaveBeenCalled();
    });
  });

  it('mock session joins channels but does NOT distribute', async () => {
    h.isMockSession.mockReturnValue(true);
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => expect(h.joinChannel).toHaveBeenCalled());
    expect(h.distributeChannelKey).not.toHaveBeenCalled();
  });

  it('tolerates distribute errors per-channel', async () => {
    h.getSenderKeyDistribution.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => expect(result.current.ready).toBe(true));
  });
});

describe('ws:connected re-fetch', () => {
  it('registers ws:connected listener', () => {
    renderHook(() => useEagerLoad('t1', true));
    expect(h.wsOn).toHaveBeenCalledWith('ws:connected', expect.any(Function));
  });
});

describe('voice channels are skipped', () => {
  it('only fetches messages for text channels', async () => {
    renderHook(() => useEagerLoad('t1', true));
    await waitFor(() => {
      expect(h.api.getMessages).toHaveBeenCalledWith('t1', 'ch-1', 50);
      expect(h.api.getMessages).toHaveBeenCalledWith('t1', 'ch-2', 50);
    });
    const calls = h.api.getMessages.mock.calls;
    expect(calls.find((c) => c[1] === 'ch-voice')).toBeUndefined();
  });
});
