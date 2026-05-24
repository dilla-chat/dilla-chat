// ChatApp.tsx is a 5949-LOC handoff port whose React render path
// triggers an infinite re-render loop in jsdom (one of its deeply
// subscribed Zustand selectors returns a fresh reference per call).
// Untangling the upstream selector is out of scope for the test
// pass — instead we cover the file's pure helpers via direct
// imports, plus the Avatar re-exports.

import { describe, it, expect } from 'vitest';
import * as ChatAppModule from './ChatApp';

const {
  default: ChatApp,
  memberAvatarStyle,
  memberAvatarClass,
  timeShort,
  dayLabel,
  groupMessages,
  isHost,
  mockUnfurl,
  detectUnfurls,
  pollServerToMessage,
} = ChatAppModule;

describe('ChatApp module exports', () => {
  it('exposes a default ChatApp component', () => {
    expect(typeof ChatApp).toBe('function');
  });

  it('re-exports memberAvatarStyle from ./Avatar', () => {
    expect(typeof memberAvatarStyle).toBe('function');
    expect(typeof memberAvatarStyle({ color: '#f00' })).toBe('object');
  });

  it('memberAvatarClass returns the base class for avatar-less members', () => {
    expect(memberAvatarClass({ avatarUrl: '' }, 'avatar')).toBe('avatar');
  });

  it('memberAvatarClass appends has-image when avatarUrl is set', () => {
    expect(memberAvatarClass({ avatarUrl: '/img.png' }, 'avatar')).toContain('has-image');
  });
});

describe('timeShort', () => {
  it('formats a date with hour and minute (locale-aware)', () => {
    const d = new Date('2026-05-24T14:35:00Z');
    const out = timeShort(d);
    // We can't assert exact locale output without freezing timezone,
    // but it must be a string containing a digit.
    expect(typeof out).toBe('string');
    expect(/\d/.test(out)).toBe(true);
  });
});

describe('dayLabel', () => {
  it('returns "Today" for today', () => {
    expect(dayLabel(new Date())).toBe('Today');
  });

  it('returns "Yesterday" for one day ago', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(dayLabel(y)).toBe('Yesterday');
  });

  it('returns a weekday/month/day formatted string for older dates', () => {
    const past = new Date('2024-01-15T12:00:00Z');
    const out = dayLabel(past);
    expect(out).not.toBe('Today');
    expect(out).not.toBe('Yesterday');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('groupMessages', () => {
  function msg(author: string, atOffsetMs: number, kind = 'text') {
    return { id: `m${atOffsetMs}`, author, at: new Date(2026, 0, 1, 12, 0, 0, atOffsetMs), kind };
  }

  it('returns an empty array for empty input', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('stacks two consecutive same-author text messages into one group', () => {
    const m1 = msg('alice', 0);
    const m2 = msg('alice', 1_000); // 1s later
    const out = groupMessages([m1, m2]);
    expect(out).toHaveLength(1);
    expect(out[0].author).toBe('alice');
    expect(out[0].children).toHaveLength(2);
  });

  it('splits when author changes', () => {
    const out = groupMessages([msg('alice', 0), msg('bob', 1_000)]);
    expect(out).toHaveLength(2);
    expect(out[0].author).toBe('alice');
    expect(out[1].author).toBe('bob');
  });

  it('splits when the gap exceeds 5 minutes', () => {
    const out = groupMessages([msg('alice', 0), msg('alice', 6 * 60 * 1000)]);
    expect(out).toHaveLength(2);
  });

  it('does not stack non-text kinds', () => {
    const out = groupMessages([
      { id: 'i1', author: 'alice', at: new Date(), kind: 'image' },
      { id: 'i2', author: 'alice', at: new Date(), kind: 'image' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not stack across non-text-to-text boundary', () => {
    const out = groupMessages([
      { id: 'x1', author: 'a', at: new Date(2026, 0, 1, 12, 0, 0, 0), kind: 'system' },
      { id: 'x2', author: 'a', at: new Date(2026, 0, 1, 12, 0, 0, 100), kind: 'text' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('isHost', () => {
  it('exact host match', () => {
    expect(isHost('github.com', 'github.com')).toBe(true);
  });

  it('subdomain match', () => {
    expect(isHost('media.giphy.com', 'giphy.com')).toBe(true);
  });

  it('non-match returns false', () => {
    expect(isHost('evil.com', 'github.com')).toBe(false);
  });

  it('lookalike host does NOT match', () => {
    expect(isHost('github.com.evil.example', 'github.com')).toBe(false);
  });

  it('empty suffix does not match a real host', () => {
    expect(isHost('example.com', '')).toBe(false);
  });
});

describe('mockUnfurl', () => {
  it('classifies a github.com URL as kind="github"', () => {
    const u = mockUnfurl('github.com', 'https://github.com/dilla-chat/dilla-chat');
    expect(u.kind).toBe('github');
  });

  it('classifies a github.com/.../pull/* URL as a PR card', () => {
    const u = mockUnfurl('github.com', 'https://github.com/foo/bar/pull/47');
    expect(u.kind).toBe('github');
    expect(u.title).toContain('PR');
  });

  it('classifies figma.com as kind="figma"', () => {
    const u = mockUnfurl('figma.com', 'https://figma.com/file/x');
    expect(u.kind).toBe('figma');
  });

  it('falls back to a generic web card', () => {
    const u = mockUnfurl('example.com', 'https://example.com/path');
    expect(u.kind).toBe('web');
    expect(u.title).toBe('example.com/path');
  });

  it('subdomain of github still resolves via isHost', () => {
    const u = mockUnfurl('api.github.com', 'https://api.github.com/x');
    expect(u.kind).toBe('github');
  });
});

describe('detectUnfurls', () => {
  it('returns no unfurls for empty/null text', () => {
    expect(detectUnfurls('')).toEqual([]);
    expect(detectUnfurls(null as never)).toEqual([]);
  });

  it('extracts a single URL', () => {
    const out = detectUnfurls('check https://example.com/page out');
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe('example.com');
  });

  it('extracts up to 2 URLs', () => {
    const out = detectUnfurls('first https://a.example second https://b.example third https://c.example');
    expect(out).toHaveLength(2);
  });

  it('skips URLs inside triple-backtick code fences', () => {
    const out = detectUnfurls('```\nhttps://hidden.example\n```\nlook https://visible.example');
    expect(out).toHaveLength(1);
    expect(out[0].host).toBe('visible.example');
  });

  it('skips direct image URLs (handled inline by renderText)', () => {
    const out = detectUnfurls('https://media.giphy.com/cat.gif');
    expect(out).toEqual([]);
  });

  it('returns nothing for plain text without URLs', () => {
    expect(detectUnfurls('just plain words here')).toEqual([]);
  });
});

describe('pollServerToMessage', () => {
  it('maps a basic poll payload into the handoff poll shape', () => {
    const payload = {
      id: 'p1',
      question: 'Best language?',
      options: ['Rust', 'TypeScript'],
      tallies: [3, 1],
      voters: [['u1', 'u2'], []],
      created_by: 'u1',
      created_at: '2026-01-01T00:00:00Z',
    };
    const m = pollServerToMessage(payload, 'u1');
    expect(m.kind).toBe('poll');
    expect(m.id).toBe('p1');
    expect(m.question).toBe('Best language?');
    expect(m.author).toBe('u1');
    expect(m.options).toHaveLength(2);
    expect(m.options[0]).toEqual({ label: 'Rust', votes: 3, mine: true });
    expect(m.options[1]).toEqual({ label: 'TypeScript', votes: 1, mine: false });
  });

  it('falls back to empty arrays + Date.now when fields are missing', () => {
    const m = pollServerToMessage({ id: 'p1', question: '?' }, 'u1');
    expect(m.options).toEqual([]);
    expect(m.author).toBe('');
    expect(m.at).toBeInstanceOf(Date);
  });

  it('aligns tallies / voters by index, not by length', () => {
    const m = pollServerToMessage({
      id: 'p1', question: 'q', options: ['a', 'b', 'c'],
      tallies: [5], voters: [['me']],
      created_by: 'x', created_at: '2026-01-01',
    }, 'me');
    expect(m.options[0]).toEqual({ label: 'a', votes: 5, mine: true });
    expect(m.options[1]).toEqual({ label: 'b', votes: 0, mine: false });
    expect(m.options[2]).toEqual({ label: 'c', votes: 0, mine: false });
  });
});
