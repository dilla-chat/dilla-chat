// Exercise webauthn.ts — register, authenticate, helpers, RP config fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  registerPasskey,
  authenticatePasskey,
  prfOutputToBase64,
} from './webauthn';

const realFetch = globalThis.fetch;
const realCredentials = (globalThis.navigator as Navigator).credentials;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ rp_id: 'localhost', rp_name: 'Dilla' }),
  })) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true });
  if (realCredentials) {
    Object.defineProperty(globalThis.navigator, 'credentials', { value: realCredentials, configurable: true });
  }
});

function mockCredential(prfFirst: ArrayBuffer | null, enabled = true) {
  return {
    id: 'cred-id-1',
    rawId: new TextEncoder().encode('cred-id-1').buffer,
    type: 'public-key',
    response: {},
    getClientExtensionResults: () => ({
      prf: { enabled, results: prfFirst ? { first: prfFirst } : undefined },
    }),
  };
}

function mockCredentialsApi(create: unknown, get: unknown) {
  Object.defineProperty(globalThis.navigator, 'credentials', {
    value: {
      create: vi.fn(async () => create),
      get: vi.fn(async () => get),
    },
    configurable: true,
    writable: true,
  });
}

describe('prfOutputToBase64', () => {
  it('encodes ArrayBuffer as base64', () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const b64 = prfOutputToBase64(buf);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);
  });

  it('encodes empty buffer to empty string', () => {
    expect(prfOutputToBase64(new ArrayBuffer(0))).toBe('');
  });

  it('encodes 32 random bytes', () => {
    const buf = crypto.getRandomValues(new Uint8Array(32)).buffer;
    const b64 = prfOutputToBase64(buf);
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('registerPasskey', () => {
  it('returns credentialId + prfOutput on success', async () => {
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(mockCredential(prfBuf, true), null);
    const result = await registerPasskey(
      'jonas',
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8]),
    );
    expect(result.credentialId).toBeTruthy();
    expect(result.prfSupported).toBe(true);
    expect(result.prfOutput.byteLength).toBe(32);
    expect(result.credentialName).toBeTruthy();
  });

  it('reports prfSupported=false when no PRF results', async () => {
    mockCredentialsApi(mockCredential(null, false), null);
    const result = await registerPasskey(
      'jonas',
      new Uint8Array([1]),
      new Uint8Array([5]),
    );
    expect(result.prfSupported).toBe(false);
    expect(result.prfOutput.byteLength).toBe(0);
  });

  it('throws when credential creation is cancelled', async () => {
    mockCredentialsApi(null, null);
    await expect(registerPasskey('u', new Uint8Array([1]), new Uint8Array([2]))).rejects.toThrow();
  });

  it('passes serverUrl through to RP config fetch', async () => {
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(mockCredential(prfBuf, true), null);
    const result = await registerPasskey(
      'jonas',
      new Uint8Array([1]),
      new Uint8Array([2]),
      'https://srv.example',
    );
    expect(result.credentialId).toBeTruthy();
  });

  it('falls back to localhost when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }) as never);
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(mockCredential(prfBuf, true), null);
    const result = await registerPasskey('u', new Uint8Array([1]), new Uint8Array([2]));
    expect(result.credentialId).toBeTruthy();
  });

  it('falls back when fetch returns non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })) as never);
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(mockCredential(prfBuf, true), null);
    const r = await registerPasskey('u', new Uint8Array([1]), new Uint8Array([2]));
    expect(r.credentialId).toBeTruthy();
  });
});

describe('authenticatePasskey', () => {
  it('returns prfOutput on successful assertion', async () => {
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(null, mockCredential(prfBuf, true));
    const result = await authenticatePasskey(['Y3JlZC1pZC0x'], new Uint8Array([1, 2, 3]));
    expect(result.prfOutput).toBeTruthy();
    expect(result.prfOutput?.byteLength).toBe(32);
  });

  it('returns null prfOutput when PRF not provided', async () => {
    mockCredentialsApi(null, mockCredential(null, false));
    const result = await authenticatePasskey(['Y3JlZC1pZC0x'], new Uint8Array([1]));
    expect(result.prfOutput).toBeNull();
  });

  it('throws when assertion is cancelled', async () => {
    mockCredentialsApi(null, null);
    await expect(authenticatePasskey(['x'], new Uint8Array([1]))).rejects.toThrow();
  });

  it('handles multiple credential IDs', async () => {
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(null, mockCredential(prfBuf, true));
    const result = await authenticatePasskey(['Y3JlZA', 'YW5vdGhlcg'], new Uint8Array([1]));
    expect(result.prfOutput).toBeTruthy();
  });

  it('passes serverUrl through to RP config fetch', async () => {
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(null, mockCredential(prfBuf, true));
    const result = await authenticatePasskey(['Y3JlZA'], new Uint8Array([1]), 'https://srv.example');
    expect(result.prfOutput).toBeTruthy();
  });

  it('falls back to localhost when serverUrl fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }) as never);
    const prfBuf = new Uint8Array(32).buffer;
    mockCredentialsApi(null, mockCredential(prfBuf, true));
    const result = await authenticatePasskey(['Y3JlZA'], new Uint8Array([1]), 'https://srv.example');
    expect(result.prfOutput).toBeTruthy();
  });
});
