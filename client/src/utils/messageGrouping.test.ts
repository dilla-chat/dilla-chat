import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { groupMessages, formatTime } from './messageGrouping';
import type { Message } from '../stores/messageStore';

function msg(overrides: Partial<Message> & { id: string; authorId: string; createdAt: string }): Message {
  return {
    channelId: 'ch-1',
    username: overrides.authorId,
    content: 'hi',
    type: 'text',
    deleted: false,
    ...overrides,
  } as Message;
}

describe('groupMessages', () => {
  it('returns [] for an empty list', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('keeps a single message as its own group', () => {
    const groups = groupMessages([msg({ id: 'm1', authorId: 'u1', createdAt: '2026-01-01T00:00:00Z' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].authorId).toBe('u1');
    expect(groups[0].messages).toHaveLength(1);
  });

  it('groups consecutive messages from the same author within 7 minutes', () => {
    const groups = groupMessages([
      msg({ id: 'm1', authorId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ id: 'm2', authorId: 'u1', createdAt: '2026-01-01T00:03:00Z' }),
      msg({ id: 'm3', authorId: 'u1', createdAt: '2026-01-01T00:06:00Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(3);
  });

  it('starts a new group when the gap exceeds 7 minutes', () => {
    const groups = groupMessages([
      msg({ id: 'm1', authorId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ id: 'm2', authorId: 'u1', createdAt: '2026-01-01T00:08:00Z' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('starts a new group when the author changes', () => {
    const groups = groupMessages([
      msg({ id: 'm1', authorId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ id: 'm2', authorId: 'u2', createdAt: '2026-01-01T00:01:00Z' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('system messages always open a new group', () => {
    // The next regular message can attach to the system entry's group
    // (since `isSystem` is only checked for the incoming message —
    // last.authorId still matches), but the system entry itself never
    // joins the previous group.
    const groups = groupMessages([
      msg({ id: 'm1', authorId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ id: 'm2', authorId: 'u1', createdAt: '2026-01-01T00:01:00Z', type: 'system' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('deleted messages start their own group', () => {
    const groups = groupMessages([
      msg({ id: 'm1', authorId: 'u1', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ id: 'm2', authorId: 'u1', createdAt: '2026-01-01T00:01:00Z', deleted: true }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('formatTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns time only for today', () => {
    const out = formatTime('2026-05-15T08:30:00Z');
    // Format may include locale-specific colon; match the time digits.
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });

  it('prepends Yesterday for yesterday', () => {
    const out = formatTime('2026-05-14T12:00:00Z');
    expect(out).toMatch(/^Yesterday \d{2}:\d{2}$/);
  });

  it('prepends a date for older messages', () => {
    const out = formatTime('2026-05-10T10:00:00Z');
    expect(out).not.toMatch(/^Yesterday/);
    // Should contain a digit somewhere (date) followed by HH:MM.
    expect(out).toMatch(/\d.*\d{2}:\d{2}$/);
  });
});
