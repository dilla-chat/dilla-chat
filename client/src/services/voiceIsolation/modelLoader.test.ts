import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchManifest,
  loadDfn3Model,
  ManifestError,
  validateChecksum,
  type Dfn3Manifest,
} from './modelLoader';

const SAMPLE_CONFIG = {
  sample_rate: 48000,
  fft_size: 960,
  hop_size: 480,
  nb_erb: 32,
  nb_df: 96,
  df_order: 5,
  lookahead_frames: 4,
  state_shapes: {
    erb_ctx: [1, 1, 2, 32],
    spec_ctx: [1, 2, 2, 96],
    h_enc: [1, 1, 256],
    h_erb: [2, 1, 256],
    c0_ctx: [1, 64, 4, 96],
    h_df: [2, 1, 256],
  },
};

function makeManifest(overrides: Partial<Dfn3Manifest> = {}): Dfn3Manifest {
  return {
    version: 2,
    minClientVersion: 0,
    dfn3: {
      enc: {
        url: '/api/voice/models/dfn3-v1/enc.onnx',
        sha256: 'a'.repeat(64),
      },
      erb_dec: {
        url: '/api/voice/models/dfn3-v1/erb_dec.onnx',
        sha256: 'b'.repeat(64),
      },
      df_dec: {
        url: '/api/voice/models/dfn3-v1/df_dec.onnx',
        sha256: 'c'.repeat(64),
      },
      config: SAMPLE_CONFIG,
    },
    ...overrides,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

beforeEach(async () => {
  vi.restoreAllMocks();
  // Wipe the IDB cache between tests so caching tests start clean.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('dilla-voice-models');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
});

describe('fetchManifest', () => {
  it('parses a valid multi-graph manifest', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(makeManifest()),
    } as Response);

    const m = await fetchManifest('http://localhost:8888');
    expect(m.dfn3.enc.sha256).toBe('a'.repeat(64));
    expect(m.dfn3.erb_dec.sha256).toBe('b'.repeat(64));
    expect(m.dfn3.df_dec.sha256).toBe('c'.repeat(64));
    expect(m.dfn3.config.sample_rate).toBe(48000);
  });

  it('throws ManifestError on HTTP failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(ManifestError);
  });

  it('throws ManifestError on incompatible client version', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve(makeManifest({ minClientVersion: 99 })),
    } as Response);

    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(/incompatible/i);
  });

  it('throws ManifestError if a sub-graph entry is missing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          version: 1,
          minClientVersion: 0,
          dfn3: {
            enc: { url: '/x', sha256: 'a'.repeat(64) },
            // erb_dec missing
            df_dec: { url: '/x', sha256: 'c'.repeat(64) },
            config: SAMPLE_CONFIG,
          },
        }),
    } as Response);

    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(ManifestError);
  });

  it('throws ManifestError on a malformed sha256', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          version: 1,
          minClientVersion: 0,
          dfn3: {
            enc: { url: '/x', sha256: 'not-hex' },
            erb_dec: { url: '/x', sha256: 'b'.repeat(64) },
            df_dec: { url: '/x', sha256: 'c'.repeat(64) },
            config: SAMPLE_CONFIG,
          },
        }),
    } as Response);

    await expect(fetchManifest('http://localhost:8888')).rejects.toThrow(ManifestError);
  });
});

describe('validateChecksum', () => {
  it('passes for matching sha256', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    await expect(validateChecksum(bytes, hash)).resolves.toBeUndefined();
  });

  it('throws on mismatch', async () => {
    await expect(validateChecksum(new Uint8Array([1]), 'a'.repeat(64))).rejects.toThrow(/checksum/i);
  });
});

describe('loadDfn3Model', () => {
  it('fetches all three sub-graphs, validates, caches, and returns them', async () => {
    const enc = new Uint8Array([10, 20, 30]);
    const erbDec = new Uint8Array([40, 50, 60]);
    const dfDec = new Uint8Array([70, 80, 90]);
    const manifest = makeManifest({
      dfn3: {
        enc: { url: '/api/voice/models/dfn3-v1/enc.onnx', sha256: await sha256Hex(enc) },
        erb_dec: { url: '/api/voice/models/dfn3-v1/erb_dec.onnx', sha256: await sha256Hex(erbDec) },
        df_dec: { url: '/api/voice/models/dfn3-v1/df_dec.onnx', sha256: await sha256Hex(dfDec) },
        config: SAMPLE_CONFIG,
      },
    });

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
      if (url.endsWith('enc.onnx')) return new Response(enc);
      if (url.endsWith('erb_dec.onnx')) return new Response(erbDec);
      if (url.endsWith('df_dec.onnx')) return new Response(dfDec);
      throw new Error(`unexpected: ${url}`);
    });

    const result = await loadDfn3Model('http://localhost:8888');
    expect(result.encBytes).toEqual(enc);
    expect(result.erbDecBytes).toEqual(erbDec);
    expect(result.dfDecBytes).toEqual(dfDec);
    expect(result.version).toBe(2);
    expect(result.config.sample_rate).toBe(48000);
  });

  it('serves from IndexedDB cache on second call (only refetches manifest)', async () => {
    const enc = new Uint8Array([1]);
    const erbDec = new Uint8Array([2]);
    const dfDec = new Uint8Array([3]);
    const manifest = makeManifest({
      dfn3: {
        enc: { url: '/api/voice/models/dfn3-v1/enc.onnx', sha256: await sha256Hex(enc) },
        erb_dec: { url: '/api/voice/models/dfn3-v1/erb_dec.onnx', sha256: await sha256Hex(erbDec) },
        df_dec: { url: '/api/voice/models/dfn3-v1/df_dec.onnx', sha256: await sha256Hex(dfDec) },
        config: SAMPLE_CONFIG,
      },
    });

    let manifestFetches = 0;
    let modelFetches = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) {
        manifestFetches += 1;
        return new Response(JSON.stringify(manifest));
      }
      modelFetches += 1;
      if (url.endsWith('enc.onnx')) return new Response(enc);
      if (url.endsWith('erb_dec.onnx')) return new Response(erbDec);
      if (url.endsWith('df_dec.onnx')) return new Response(dfDec);
      throw new Error('unexpected');
    });

    await loadDfn3Model('http://localhost:8888');
    expect(manifestFetches).toBe(1);
    expect(modelFetches).toBe(3);

    await loadDfn3Model('http://localhost:8888');
    // Second call: manifest re-fetched (for version/checksum check) but model
    // bytes served from IndexedDB cache.
    expect(manifestFetches).toBe(2);
    expect(modelFetches).toBe(3);
  });

  it('refetches a sub-graph if its cached bytes fail checksum', async () => {
    const enc = new Uint8Array([1]);
    const erbDec = new Uint8Array([2]);
    const dfDec = new Uint8Array([3]);
    const manifest = makeManifest({
      dfn3: {
        enc: { url: '/api/voice/models/dfn3-v1/enc.onnx', sha256: await sha256Hex(enc) },
        erb_dec: { url: '/api/voice/models/dfn3-v1/erb_dec.onnx', sha256: await sha256Hex(erbDec) },
        df_dec: { url: '/api/voice/models/dfn3-v1/df_dec.onnx', sha256: await sha256Hex(dfDec) },
        config: SAMPLE_CONFIG,
      },
    });

    let serveCorrupt = true;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
      if (url.endsWith('enc.onnx')) {
        if (serveCorrupt) {
          serveCorrupt = false;
          return new Response(new Uint8Array([99])); // wrong bytes
        }
        return new Response(enc);
      }
      if (url.endsWith('erb_dec.onnx')) return new Response(erbDec);
      if (url.endsWith('df_dec.onnx')) return new Response(dfDec);
      throw new Error('unexpected');
    });

    await expect(loadDfn3Model('http://localhost:8888')).rejects.toThrow(/checksum/i);
    // Second call should now succeed (server is serving the correct bytes).
    const result = await loadDfn3Model('http://localhost:8888');
    expect(result.encBytes).toEqual(enc);
  });
});
