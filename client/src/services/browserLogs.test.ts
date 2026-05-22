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
