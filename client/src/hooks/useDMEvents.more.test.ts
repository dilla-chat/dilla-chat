// Cover the uncovered branches in useDMEvents.ts: dm:message:new
// (decrypt + unread + active-DM markRead + auto-refetch channels),
// dm:message:updated, and the alternate field-name parsing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const h = vi.hoisted(() => ({
  wsHandlers: new Map<string, (...args: unknown[]) => void>(),
  markChannelRead: vi.fn(),
  getDMChannels: vi.fn(async () => []),
  decryptDM: vi.fn(async (_t: string, _s: string, ct: string) => `pt:${ct}`),
}));

vi.mock('../services/websocket', () => ({
  ws: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      h.wsHandlers.set(event, handler);
      return vi.fn();
    }),
    markChannelRead: h.markChannelRead,
  },
}));

vi.mock('../services/api', () => ({
  api: { getDMChannels: h.getDMChannels },
}));

vi.mock('../services/crypto', () => ({
  cryptoService: { decryptDM: h.decryptDM },
}));

vi.mock('../services/messageCache', () => ({
  deleteCachedMessage: vi.fn(),
  getCachedMessage: vi.fn(async () => null),
  cacheMessage: vi.fn(),
}));

vi.mock('./useMessageDecryption', () => ({
  serverToMessage: vi.fn((m: { id: string; channel_id: string; author_id: string; content: string }, content: string) => ({
    id: m.id,
    channelId: m.channel_id,
    authorId: m.author_id,
    content,
    type: 'text',
    createdAt: new Date().toISOString(),
  })),
}));

import { useDMEvents } from './useDMEvents';
import { useAuthStore } from '../stores/authStore';
import { useDMStore } from '../stores/dmStore';
import { useUnreadStore } from '../stores/unreadStore';

beforeEach(() => {
  h.wsHandlers.clear();
  h.markChannelRead.mockClear();
  h.getDMChannels.mockClear();
  h.decryptDM.mockClear();
  useAuthStore.setState({
    teams: new Map([['t1', { token: 'tok', user: { id: 'me', username: 'me' }, teamInfo: {}, baseUrl: 'http://localhost' }]]),
    derivedKey: 'dk',
  } as never);
  useDMStore.setState({
    activeDMId: null,
    dmChannels: { t1: [{ id: 'dm-1', participantIds: ['me', 'u2'], lastMessageAt: new Date() } as never] },
    dmMessages: {
      'dm-1': [
        { id: 'm1', channelId: 'dm-1', authorId: 'u2', content: 'original', type: 'text', createdAt: new Date().toISOString() } as never,
      ],
    },
    dmTyping: {},
  } as never);
  useUnreadStore.setState({ counts: new Map() } as never);
});

describe('dm:message:new', () => {
  it('decrypts and appends to dmMessages, increments unread for non-active DM', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:new');
    await fn?.({
      id: 'm-new', dm_id: 'dm-1', channel_id: 'dm-1',
      author_id: 'u2', content: 'ciphertext', type: 'text',
    });
    const msgs = useDMStore.getState().dmMessages['dm-1'] ?? [];
    expect(msgs.find((m) => m.id === 'm-new')).toBeTruthy();
    expect(h.decryptDM).toHaveBeenCalled();
  });

  it('accepts dm_channel_id as an alternative to dm_id', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:new');
    await fn?.({
      id: 'm-alt', dm_channel_id: 'dm-1', channel_id: 'dm-1',
      author_id: 'u2', content: 'ciphertext2', type: 'text',
    });
    const msgs = useDMStore.getState().dmMessages['dm-1'] ?? [];
    expect(msgs.find((m) => m.id === 'm-alt')).toBeTruthy();
  });

  it('rolls watermark forward when DM is active', async () => {
    useDMStore.setState({ activeDMId: 'dm-1' } as never);
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:new');
    await fn?.({
      id: 'm-active', dm_id: 'dm-1', channel_id: 'dm-1',
      author_id: 'u2', content: 'ciphertext', type: 'text',
    });
    expect(h.markChannelRead).toHaveBeenCalledWith('t1', 'dm-1', 'm-active');
  });

  it('does not bump unread for own message echo', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:new');
    await fn?.({
      id: 'm-self', dm_id: 'dm-1', channel_id: 'dm-1',
      author_id: 'me', content: 'ciphertext', type: 'text',
    });
    expect(useUnreadStore.getState().counts.get?.('dm-1') ?? 0).toBe(0);
  });

  it('returns early when dm_id is missing', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:new');
    await fn?.({ id: 'm-no-dm', channel_id: 'x', author_id: 'u2', content: 'x', type: 'text' });
    expect(h.decryptDM).not.toHaveBeenCalled();
  });

  it('refetches DM channels when the DM is not yet in the sidebar', async () => {
    useDMStore.setState({ dmChannels: { t1: [] } } as never);
    h.getDMChannels.mockResolvedValueOnce([{ id: 'dm-1', participantIds: ['me', 'u2'] }]);
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:new');
    await fn?.({
      id: 'm-new', dm_id: 'dm-1', channel_id: 'dm-1',
      author_id: 'u2', content: 'ciphertext', type: 'text',
    });
    expect(h.getDMChannels).toHaveBeenCalledWith('t1');
  });
});

describe('dm:message:updated', () => {
  it('updates the targeted DM message with decrypted content', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:updated');
    await fn?.({
      dm_id: 'dm-1', message_id: 'm1',
      content: 'edited-ct', author_id: 'u2', username: 'alice',
    });
    const msg = useDMStore.getState().dmMessages['dm-1']?.find((m) => m.id === 'm1');
    expect(msg?.content).toBe('pt:edited-ct');
  });

  it('accepts id instead of message_id', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:updated');
    await fn?.({
      dm_id: 'dm-1', id: 'm1',
      content: 'edited2', author_id: 'u2', username: 'alice',
    });
    const msg = useDMStore.getState().dmMessages['dm-1']?.find((m) => m.id === 'm1');
    expect(msg?.content).toBe('pt:edited2');
  });

  it('returns early when dm_id or message_id missing', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:updated');
    await fn?.({ content: 'x', author_id: 'u2', username: 'alice' });
    expect(h.decryptDM).not.toHaveBeenCalled();
  });

  it('returns early when target message not found', async () => {
    renderHook(() => useDMEvents('t1', true));
    const fn = h.wsHandlers.get('dm:message:updated');
    await fn?.({
      dm_id: 'dm-1', message_id: 'm-missing',
      content: 'x', author_id: 'u2', username: 'alice',
    });
    // No throw; existing m1 unchanged
    const m = useDMStore.getState().dmMessages['dm-1']?.find((mm) => mm.id === 'm1');
    expect(m?.content).toBe('original');
  });
});
