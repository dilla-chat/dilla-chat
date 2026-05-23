import { describe, it, expect } from 'vitest';
import { generateSafetyNumber } from './safetyNumbers';
import { randomBytes } from './helpers';

describe('crypto/safetyNumbers', () => {
  it('returns a 60-character decimal string (12 × 5-digit chunks)', async () => {
    const me = randomBytes(32);
    const them = randomBytes(32);
    const num = await generateSafetyNumber(me, 'alice', them, 'bob');
    expect(num.length).toBe(60);
    expect(/^[0-9]+$/.test(num)).toBe(true);
  });

  it('is deterministic for the same inputs', async () => {
    const me = randomBytes(32);
    const them = randomBytes(32);
    const a = await generateSafetyNumber(me, 'alice', them, 'bob');
    const b = await generateSafetyNumber(me, 'alice', them, 'bob');
    expect(a).toBe(b);
  });

  it('is identical from either side of the conversation (swap order of args)', async () => {
    // Signal-style safety numbers must agree regardless of who computed
    // them — they're sorted by stable id before combining.
    const ourKey = randomBytes(32);
    const theirKey = randomBytes(32);
    const fromAlice = await generateSafetyNumber(ourKey, 'alice', theirKey, 'bob');
    const fromBob = await generateSafetyNumber(theirKey, 'bob', ourKey, 'alice');
    expect(fromAlice).toBe(fromBob);
  });

  it('changes if the identity key changes', async () => {
    const them = randomBytes(32);
    const a = await generateSafetyNumber(randomBytes(32), 'me', them, 'them');
    const b = await generateSafetyNumber(randomBytes(32), 'me', them, 'them');
    expect(a).not.toBe(b);
  });

  it('changes if either stable id changes', async () => {
    const me = randomBytes(32);
    const them = randomBytes(32);
    const a = await generateSafetyNumber(me, 'alice', them, 'bob');
    const b = await generateSafetyNumber(me, 'alice', them, 'bob2');
    expect(a).not.toBe(b);
  });

  it('every 5-digit chunk fits in [0, 99999]', async () => {
    const num = await generateSafetyNumber(randomBytes(32), 'a', randomBytes(32), 'b');
    for (let i = 0; i < 12; i++) {
      const chunk = Number.parseInt(num.slice(i * 5, i * 5 + 5), 10);
      expect(chunk).toBeGreaterThanOrEqual(0);
      expect(chunk).toBeLessThanOrEqual(99_999);
    }
  });
});
