// F6 — PII scrubbing tests for the browser-log relay.

import { describe, it, expect } from 'vitest';
import { scrubLogLine } from './browserLogs';

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
