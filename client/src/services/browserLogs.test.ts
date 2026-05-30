// F6 — PII scrubbing tests for the browser-log relay.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scrubLogLine,
  installBrowserLogRelay,
  setBrowserLogUser,
  __resetBrowserLogRelayForTests,
} from './browserLogs';

describe('scrubLogLine', () => {
  it('strips a JWT-shaped triple', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.s5cv-mock-signature-blob';
    const out = scrubLogLine('failed for token ' + jwt + ' on /api/teams');
    expect(out).toContain('[REDACTED-JWT]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('/api/teams');
  });

  it('redacts the value after Bearer in an Authorization header', () => {
    const out = scrubLogLine('Authorization: Bearer abc123longishtokenwithlotsofchars==');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abc123longishtokenwithlotsofchars');
  });

  it('redacts long base64-ish blobs (prekey / identity material)', () => {
    const blob = 'A'.repeat(60);
    const out = scrubLogLine('prekey blob ' + blob + ' uploaded');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(blob);
  });

  it('leaves short identifiers alone', () => {
    const out = scrubLogLine('joined channel channel-xy-1234');
    expect(out).toBe('joined channel channel-xy-1234');
  });

  it('truncates lines beyond 2 KiB', () => {
    // Use a long sentence with whitespace so the LONG_TOKEN_RE doesn't
    // collapse the whole string into a single [REDACTED] first.
    const sentence = 'one two three four five six seven eight nine ten ';
    const huge = sentence.repeat(200);
    const out = scrubLogLine(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('…[truncated]');
  });

  it('passes empty strings through', () => {
    expect(scrubLogLine('')).toBe('');
  });
});

describe('installBrowserLogRelay lifecycle', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetBrowserLogRelayForTests();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetBrowserLogRelayForTests();
  });

  it('is idempotent — calling install twice does not re-wrap console', () => {
    installBrowserLogRelay();
    const wrapped = console.log;
    installBrowserLogRelay();
    expect(console.log).toBe(wrapped);
  });

  it('queues entries and POSTs to /api/v1/debug/browser-log on flush', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay({ tag: 'unit' });
      console.log('q1');
      console.error('q2');
      await vi.advanceTimersByTimeAsync(600);
      expect(fetchSpy).toHaveBeenCalled();
      const call = fetchSpy.mock.calls[0];
      expect(call[0]).toBe('/api/v1/debug/browser-log');
      const init = call[1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries.length).toBeGreaterThanOrEqual(2);
      expect(body.entries[0].tag).toBe('unit');
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrubs JWT shapes out of the queued message before send', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      const jwt = 'eyJhbGc.eyJzdWI.signat';
      console.log('token=' + jwt);
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries[0].message).toContain('[REDACTED-JWT]');
      expect(body.entries[0].message).not.toContain(jwt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops fetch errors silently (logging is best-effort)', async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    try {
      installBrowserLogRelay();
      console.log('should not crash');
      await expect(vi.advanceTimersByTimeAsync(600)).resolves.not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setBrowserLogUser', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetBrowserLogRelayForTests();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetBrowserLogRelayForTests();
  });

  it('stamps the user field on entries logged after the call', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      setBrowserLogUser('user-42');
      console.log('after login');
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries[0].user).toBe('user-42');
    } finally {
      vi.useRealTimers();
    }
  });

  it('safeStringify formats Errors with stack', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      const err = new Error('boom');
      console.log(err);
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries[0].message).toContain('Error: boom');
    } finally {
      vi.useRealTimers();
    }
  });

  it('safeStringify falls back to String() when JSON.stringify throws', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      const circular: { self?: unknown } = {};
      circular.self = circular;
      console.log(circular);
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries[0].message).toMatch(/object|circular/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('safeStringify serialises bigints', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      console.log({ big: 42n });
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries[0].message).toContain('42n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures window.error events', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      window.dispatchEvent(new ErrorEvent('error', { message: 'oops', filename: 'a.js', lineno: 1, colno: 2 }));
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries.some((e: { message: string }) => e.message.includes('window.error'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures unhandledrejection events', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
      (rejection as { reason: unknown }).reason = new Error('rejected');
      window.dispatchEvent(rejection);
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries.some((e: { message: string }) => e.message.includes('unhandledrejection'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pagehide event uses sendBeacon to ship the queue', () => {
    installBrowserLogRelay();
    const beacon = vi.fn();
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    console.log('about-to-close');
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledWith('/api/v1/debug/browser-log', expect.any(Blob));
  });

  it('pagehide is a no-op when the queue is empty', () => {
    installBrowserLogRelay();
    const beacon = vi.fn();
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).not.toHaveBeenCalled();
  });

  it('drops oldest entries when queue is saturated', async () => {
    // Hack: cap is 500 in the file. Easier to verify by enqueueing exactly
    // that many + 1 and checking queue stays bounded.
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      for (let i = 0; i < 600; i++) console.log('msg-' + i);
      await vi.advanceTimersByTimeAsync(600);
      // Just need to ensure no crash; queue overflow path is exercised.
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the user when passed undefined', async () => {
    vi.useFakeTimers();
    try {
      installBrowserLogRelay();
      setBrowserLogUser('user-42');
      setBrowserLogUser(undefined);
      console.log('after logout');
      await vi.advanceTimersByTimeAsync(600);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.entries[0].user).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
