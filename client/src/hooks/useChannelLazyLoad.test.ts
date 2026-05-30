import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useChannelLazyLoad } from './useChannelLazyLoad';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';

const getMessagesMock = vi.fn();
const isMockSessionMock = vi.fn(() => false);
const tryDecryptMock = vi.fn(async (_id, content) => content as string);
const serverToMessageMock = vi.fn((sm: { id: string }, content: string) => ({
  id: sm.id,
  content,
  authorId: 'u',
  channelId: 'c1',
  username: 'u',
  encryptedContent: '',
  type: 'text',
  threadId: null,
  editedAt: null,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  reactions: [],
}));

vi.mock('../services/api', () => ({
  api: { getMessages: (...a: unknown[]) => getMessagesMock(...a) },
}));

vi.mock('../services/mockSession', () => ({
  isMockSession: () => isMockSessionMock(),
}));

vi.mock('./useMessageDecryption', () => ({
  tryDecrypt: (...a: unknown[]) => tryDecryptMock(...a),
  serverToMessage: (...a: unknown[]) => serverToMessageMock(...a),
}));

function makeScrollEl(scrollTop = 0, scrollHeight = 1000): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollTop', {
    value: scrollTop, writable: true, configurable: true,
  });
  Object.defineProperty(el, 'scrollHeight', {
    value: scrollHeight, writable: true, configurable: true,
  });
  return el;
}

describe('useChannelLazyLoad', () => {
  beforeEach(() => {
    getMessagesMock.mockReset().mockResolvedValue([]);
    isMockSessionMock.mockReset().mockReturnValue(false);
    useAuthStore.setState({ derivedKey: 'k' as never });
    useTeamStore.setState({
      activeTeamId: 't1',
      members: new Map([['t1', []]]),
    } as never);
    useMessageStore.setState({
      messages: new Map(),
      loadingHistory: new Map(),
      hasMore: new Map(),
      typing: new Map(),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when channelId is null', () => {
    renderHook(() => {
      const ref = useRef<HTMLElement | null>(null);
      ref.current = makeScrollEl();
      useChannelLazyLoad(null, ref);
    });
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('does nothing when running in /mesh mock session', () => {
    isMockSessionMock.mockReturnValue(true);
    const ref = { current: makeScrollEl() } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('does nothing when the message list is empty (initial fetch hasn\'t landed)', async () => {
    // Empty messages — bail before fetching.
    const ref = { current: makeScrollEl(/*scrollTop*/ 0) } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    await new Promise((r) => setTimeout(r, 10));
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('triggers a fetch on mount when scrolled near the top + there is at least one existing message', async () => {
    useMessageStore.setState({
      messages: new Map([['c1', [{
        id: 'm0', createdAt: '2026-01-01T00:00:00Z', content: 'old', authorId: 'u', channelId: 'c1',
        username: 'u', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, reactions: [],
      } as never]]]),
    } as never);
    const ref = { current: makeScrollEl(/*scrollTop*/ 50) } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    await new Promise((r) => setTimeout(r, 20));
    expect(getMessagesMock).toHaveBeenCalledTimes(1);
    expect(getMessagesMock).toHaveBeenCalledWith('t1', 'c1', 50, '2026-01-01T00:00:00Z');
  });

  it('does NOT fetch when scrolled past the top threshold', async () => {
    useMessageStore.setState({
      messages: new Map([['c1', [{
        id: 'm0', createdAt: '2026-01-01T00:00:00Z', content: 'old', authorId: 'u', channelId: 'c1',
        username: 'u', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, reactions: [],
      } as never]]]),
    } as never);
    const ref = { current: makeScrollEl(/*scrollTop*/ 5000) } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    await new Promise((r) => setTimeout(r, 20));
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('does NOT fetch when hasMore is false', async () => {
    useMessageStore.setState({
      messages: new Map([['c1', [{
        id: 'm0', createdAt: '2026-01-01T00:00:00Z', content: 'x', authorId: 'u', channelId: 'c1',
        username: 'u', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, reactions: [],
      } as never]]]),
      hasMore: new Map([['c1', false]]),
    } as never);
    const ref = { current: makeScrollEl(/*scrollTop*/ 50) } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    await new Promise((r) => setTimeout(r, 20));
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('does NOT fetch when loadingHistory is already true', async () => {
    useMessageStore.setState({
      messages: new Map([['c1', [{
        id: 'm0', createdAt: '2026-01-01T00:00:00Z', content: 'x', authorId: 'u', channelId: 'c1',
        username: 'u', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, reactions: [],
      } as never]]]),
      loadingHistory: new Map([['c1', true]]),
    } as never);
    const ref = { current: makeScrollEl(/*scrollTop*/ 50) } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    await new Promise((r) => setTimeout(r, 20));
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('does NOT fetch when no active team', async () => {
    useTeamStore.setState({ activeTeamId: null } as never);
    useMessageStore.setState({
      messages: new Map([['c1', [{
        id: 'm0', createdAt: '2026-01-01T00:00:00Z', content: 'x', authorId: 'u', channelId: 'c1',
        username: 'u', encryptedContent: '', type: 'text', threadId: null, editedAt: null, deleted: false, reactions: [],
      } as never]]]),
    } as never);
    const ref = { current: makeScrollEl(/*scrollTop*/ 50) } as React.RefObject<HTMLElement | null>;
    renderHook(() => useChannelLazyLoad('c1', ref));
    await new Promise((r) => setTimeout(r, 20));
    expect(getMessagesMock).not.toHaveBeenCalled();
  });

  it('attaches and detaches the scroll listener on the element', () => {
    const el = makeScrollEl();
    const add = vi.spyOn(el, 'addEventListener');
    const remove = vi.spyOn(el, 'removeEventListener');
    const ref = { current: el } as React.RefObject<HTMLElement | null>;
    const { unmount } = renderHook(() => useChannelLazyLoad('c1', ref));
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
    unmount();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
