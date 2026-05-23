import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import TypingIndicator from './TypingIndicator';
import { useMessageStore } from '../../stores/messageStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: string, vars?: Record<string, string>) => {
      let out = fb ?? _k;
      if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{{${k}}}`, v);
      return out;
    },
  }),
}));

function seedTyping(channelId: string, users: Array<{ userId: string; username: string; timestamp: number }>) {
  useMessageStore.setState((s) => ({ typing: new Map(s.typing).set(channelId, users) }));
}

describe('TypingIndicator', () => {
  beforeEach(() => {
    useMessageStore.setState({ typing: new Map() } as never);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when nobody is typing', () => {
    const { container } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    expect(container.firstChild).toBeNull();
  });

  it('excludes the current user from the typing list', () => {
    seedTyping('c1', [{ userId: 'me', username: 'Me', timestamp: Date.now() }]);
    const { container } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "{name} is typing" for one user', () => {
    seedTyping('c1', [{ userId: 'u1', username: 'Alice', timestamp: Date.now() }]);
    const { getByText } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    expect(getByText('Alice is typing')).toBeTruthy();
  });

  it('renders "{a} and {b} are typing" for two users', () => {
    seedTyping('c1', [
      { userId: 'u1', username: 'Alice', timestamp: Date.now() },
      { userId: 'u2', username: 'Bob', timestamp: Date.now() },
    ]);
    const { getByText } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    expect(getByText('Alice and Bob are typing')).toBeTruthy();
  });

  it('renders "Several people are typing" for three or more users', () => {
    seedTyping('c1', [
      { userId: 'u1', username: 'Alice', timestamp: Date.now() },
      { userId: 'u2', username: 'Bob', timestamp: Date.now() },
      { userId: 'u3', username: 'Carol', timestamp: Date.now() },
    ]);
    const { getByText } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    expect(getByText('Several people are typing')).toBeTruthy();
  });

  it('shows up to 3 avatars even with more typists', () => {
    seedTyping('c1', [
      { userId: 'u1', username: 'Alice', timestamp: Date.now() },
      { userId: 'u2', username: 'Bob', timestamp: Date.now() },
      { userId: 'u3', username: 'Carol', timestamp: Date.now() },
      { userId: 'u4', username: 'Dan', timestamp: Date.now() },
    ]);
    const { container } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    expect(container.querySelectorAll('.typing-indicator-avatar').length).toBe(3);
  });

  it('expires stale typists after 5s', () => {
    const oldTs = Date.now() - 6_000;
    seedTyping('c1', [{ userId: 'u1', username: 'Alice', timestamp: oldTs }]);
    render(<TypingIndicator channelId="c1" currentUserId="me" />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(useMessageStore.getState().typing.get('c1') ?? []).toHaveLength(0);
  });

  it('avatar colour is deterministic for a given userId', () => {
    seedTyping('c1', [
      { userId: 'u1', username: 'Alice', timestamp: Date.now() },
      { userId: 'u1', username: 'Alice', timestamp: Date.now() },
    ]);
    const { container } = render(<TypingIndicator channelId="c1" currentUserId="me" />);
    const avatars = container.querySelectorAll('.typing-indicator-avatar');
    expect(avatars[0].getAttribute('style')).toBe(avatars[1].getAttribute('style'));
  });
});
