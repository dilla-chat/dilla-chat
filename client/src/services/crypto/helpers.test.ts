import { describe, it, expect } from 'vitest';
import {
  concatBytes,
  bytesEqual,
  randomBytes,
  toBase64,
  fromBase64,
  fromBase64url,
  encoder,
  decoder,
} from './helpers';

describe('crypto/helpers', () => {
  it('encoder/decoder roundtrips utf-8', () => {
    expect(decoder.decode(encoder.encode('héllo 🌍'))).toBe('héllo 🌍');
  });

  it('concatBytes joins multiple buffers in order', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    const c = new Uint8Array([4, 5, 6]);
    expect([...concatBytes(a, b, c)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('concatBytes with zero args returns an empty Uint8Array', () => {
    expect(concatBytes().length).toBe(0);
  });

  it('bytesEqual: equal length + equal content → true', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('bytesEqual: different length → false', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('bytesEqual: same length different content → false', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('bytesEqual is constant-time-style: continues comparing past first mismatch', () => {
    // Property check — we can't observe timing, but we can at least
    // confirm that mismatches at index 0 vs N return the same answer.
    expect(bytesEqual(new Uint8Array([0, 1, 2]), new Uint8Array([1, 1, 2]))).toBe(false);
    expect(bytesEqual(new Uint8Array([0, 1, 1]), new Uint8Array([0, 1, 2]))).toBe(false);
  });

  it('randomBytes returns a buffer of the requested length', () => {
    expect(randomBytes(32).length).toBe(32);
    expect(randomBytes(0).length).toBe(0);
  });

  it('randomBytes produces high-entropy output (two calls differ)', () => {
    expect(bytesEqual(randomBytes(32), randomBytes(32))).toBe(false);
  });

  it('toBase64 → fromBase64 roundtrips all 256 byte values', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const restored = fromBase64(toBase64(bytes));
    expect(bytesEqual(restored, bytes)).toBe(true);
  });

  it('fromBase64url normalises - and _ and adds padding', () => {
    // RFC 4648 §5 — base64url avoids + / = which need percent-encoding
    // in URLs. fromBase64url should still decode the original bytes.
    const bytes = new Uint8Array([0xff, 0xee, 0xdd, 0xcc]);
    const b64 = toBase64(bytes);
    const b64url = b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    expect(bytesEqual(fromBase64url(b64url), bytes)).toBe(true);
  });

  it('toBase64 with empty buffer returns empty string', () => {
    expect(toBase64(new Uint8Array(0))).toBe('');
    expect(fromBase64('').length).toBe(0);
  });
});
