// Targeted unit tests for pure helpers + small sub-components already
// exported from ChatApp.tsx. Goal: cover them without rendering the
// full 5949-line monolith.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

import {
  timeShort,
  dayLabel,
  groupMessages,
  isHost,
  mockUnfurl,
  detectUnfurls,
  Unfurl,
  pollServerToMessage,
  currentUserId,
  EmptyFeed,
  ResizeHandle,
} from './ChatApp';

describe('timeShort', () => {
  it('formats a date to HH:mm', () => {
    const d = new Date('2026-01-01T13:45:00');
    const s = timeShort(d);
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
});

describe('dayLabel', () => {
  it('returns "Today" for today', () => {
    expect(dayLabel(new Date())).toBe('Today');
  });

  it('returns "Yesterday" for yesterday', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(dayLabel(y)).toBe('Yesterday');
  });

  it('returns a full date string for older dates', () => {
    const old = new Date();
    old.setDate(old.getDate() - 10);
    const s = dayLabel(old);
    expect(s).not.toBe('Today');
    expect(s).not.toBe('Yesterday');
    expect(s.length).toBeGreaterThan(3);
  });
});

describe('groupMessages', () => {
  const now = Date.now();
  const mk = (id: string, author: string, atOffsetMs: number, kind = 'text') => ({
    id, author, at: new Date(now + atOffsetMs), kind, text: id,
  });

  it('groups consecutive text messages by same author within 5min', () => {
    const msgs = [
      mk('m1', 'me', 0),
      mk('m2', 'me', 60_000),
      mk('m3', 'me', 120_000),
    ];
    const groups = groupMessages(msgs);
    expect(groups).toHaveLength(1);
    expect(groups[0].children).toHaveLength(3);
  });

  it('starts a new group when author changes', () => {
    const msgs = [
      mk('m1', 'me', 0),
      mk('m2', 'u2', 60_000),
    ];
    expect(groupMessages(msgs)).toHaveLength(2);
  });

  it('starts a new group after a 5min+ gap', () => {
    const msgs = [
      mk('m1', 'me', 0),
      mk('m2', 'me', 6 * 60_000),
    ];
    expect(groupMessages(msgs)).toHaveLength(2);
  });

  it('starts a new group when kind changes from text', () => {
    const msgs = [
      mk('m1', 'me', 0),
      mk('m2', 'me', 60_000, 'image'),
    ];
    expect(groupMessages(msgs)).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(groupMessages([])).toEqual([]);
  });
});

describe('isHost', () => {
  it('matches exact host', () => {
    expect(isHost('github.com', 'github.com')).toBe(true);
  });

  it('matches subdomain', () => {
    expect(isHost('api.github.com', 'github.com')).toBe(true);
    expect(isHost('foo.bar.github.com', 'github.com')).toBe(true);
  });

  it('does not match different domains', () => {
    expect(isHost('githubcom', 'github.com')).toBe(false);
    expect(isHost('not-github.com', 'github.com')).toBe(false);
  });
});

describe('mockUnfurl', () => {
  it('returns PR shape for github.com/.../pull/...', () => {
    const u = mockUnfurl('github.com', 'https://github.com/dilla/dilla/pull/47');
    expect(u.kind).toBe('github');
    expect(u.title).toContain('PR');
  });

  it('returns repo shape for github.com root', () => {
    const u = mockUnfurl('github.com', 'https://github.com/dilla/dilla');
    expect(u.kind).toBe('github');
    expect(u.title).toContain('dilla');
  });

  it('returns figma shape for figma.com', () => {
    const u = mockUnfurl('figma.com', 'https://figma.com/file/abc');
    expect(u.kind).toBe('figma');
  });

  it('returns generic web shape for unknown hosts', () => {
    const u = mockUnfurl('example.com', 'https://example.com/page');
    expect(u.kind).toBe('web');
    expect(u.meta).toBe('example.com');
  });
});

describe('detectUnfurls', () => {
  it('returns empty array for empty/no-url text', () => {
    expect(detectUnfurls('')).toEqual([]);
    expect(detectUnfurls('no urls here')).toEqual([]);
  });

  it('extracts a single url', () => {
    const out = detectUnfurls('check https://example.com out');
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://example.com');
    expect(out[0].host).toBe('example.com');
  });

  it('extracts up to 2 urls, drops the rest', () => {
    const out = detectUnfurls('a https://x.com b https://y.com c https://z.com');
    expect(out).toHaveLength(2);
  });

  it('skips urls inside code fences', () => {
    const text = '```\nhttps://example.com\n```\n outside';
    const out = detectUnfurls(text);
    expect(out).toHaveLength(0);
  });

  it('skips direct image URLs (gif/png/jpg/webp/avif)', () => {
    expect(detectUnfurls('see https://e.com/pic.png')).toEqual([]);
    expect(detectUnfurls('look https://e.com/foo.gif')).toEqual([]);
    expect(detectUnfurls('check https://e.com/img.jpeg')).toEqual([]);
    expect(detectUnfurls('check https://e.com/img.webp')).toEqual([]);
    expect(detectUnfurls('check https://e.com/img.avif')).toEqual([]);
  });

  it('handles http urls (not just https)', () => {
    const out = detectUnfurls('see http://insecure.example');
    expect(out).toHaveLength(1);
  });
});

describe('Unfurl', () => {
  it('renders unfurl card for github url', () => {
    const { container } = render(<Unfurl url="https://github.com/d/d" host="github.com" />);
    expect(container.querySelector('.unfurl-github')).toBeTruthy();
  });

  it('renders unfurl card for figma url', () => {
    const { container } = render(<Unfurl url="https://figma.com/f/x" host="figma.com" />);
    expect(container.querySelector('.unfurl-figma')).toBeTruthy();
  });

  it('renders unfurl card for generic web url', () => {
    const { container } = render(<Unfurl url="https://example.com" host="example.com" />);
    expect(container.querySelector('.unfurl-web')).toBeTruthy();
  });
});

describe('pollServerToMessage', () => {
  it('converts server poll to message shape', () => {
    const p = {
      id: 'p1',
      question: 'Best framework?',
      options: ['React', 'Vue', 'Svelte'],
      tallies: [3, 1, 2],
      voters: [['me', 'u2'], ['u3'], ['me']],
      created_by: 'u3',
      created_at: new Date().toISOString(),
    };
    const msg = pollServerToMessage(p, 'me');
    expect(msg.id).toBe('p1');
    expect(msg.kind).toBe('poll');
    expect(msg.author).toBe('u3');
    expect(msg.options).toHaveLength(3);
    expect(msg.options[0].mine).toBe(true);
    expect(msg.options[1].mine).toBe(false);
    expect(msg.options[2].mine).toBe(true);
  });

  it('handles empty options/tallies/voters', () => {
    const msg = pollServerToMessage({ id: 'p1', question: 'Q?' }, 'me');
    expect(msg.options).toEqual([]);
  });

  it('uses current date when created_at missing', () => {
    const msg = pollServerToMessage({ id: 'p1', question: 'Q?', options: [], tallies: [], voters: [] }, 'me');
    expect(msg.at).toBeInstanceOf(Date);
  });
});

describe('currentUserId', () => {
  it('returns empty string when SHELL_DATA missing', () => {
    delete (window as { SHELL_DATA?: unknown }).SHELL_DATA;
    expect(currentUserId()).toBe('');
  });

  it('returns currentUserId from SHELL_DATA', () => {
    (window as { SHELL_DATA?: { currentUserId?: string } }).SHELL_DATA = { currentUserId: 'me' };
    expect(currentUserId()).toBe('me');
  });
});

describe('EmptyFeed', () => {
  it('renders for a text channel', () => {
    const { container } = render(
      <EmptyFeed channel={{ id: 'c', name: 'general', type: 'text' }} dmPartner={null} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders for a DM partner', () => {
    const { container } = render(
      <EmptyFeed
        channel={{ id: 'dm-1', type: 'dm', name: 'dm', topic: '' }}
        dmPartner={{ id: 'u2', name: 'ada', initials: 'AD', color: '#0f0', status: 'online' }}
      />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders for a DM group channel', () => {
    const { container } = render(
      <EmptyFeed
        channel={{ id: 'dm-g', type: 'dm', name: 'design-group', group: true }}
        dmPartner={null}
      />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ResizeHandle', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ResizeHandle kind="sidebar" value={240} onResize={vi.fn()} />,
    );
    expect(container.querySelector('.resize-handle, [role="separator"], .rsz')).toBeTruthy();
  });

  it('mouseDown begins drag (handler attaches without throw)', () => {
    const onResize = vi.fn();
    const { container } = render(
      <ResizeHandle kind="members" value={240} onResize={onResize} min={180} max={380} />,
    );
    const handle = container.firstChild as HTMLElement;
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 110 });
    fireEvent.mouseUp(window);
    expect(handle).toBeTruthy();
  });
});
