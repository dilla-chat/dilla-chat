// modelLoader — fetch the DFN3 manifest, validate SHA-256 checksums for
// each of the three sub-graphs (encoder, ERB decoder, deep-filter decoder),
// and cache them in IndexedDB so subsequent calls don't re-download a few
// megabytes of model data on every page load.
//
// Adapted from the original single-file plan: DFN3 actually ships as three
// ONNX sub-graphs, so the loader returns three Uint8Arrays and caches each
// under a separate IndexedDB key.

import type { Dfn3StateShapes } from './types';

const SUPPORTED_MANIFEST_VERSION = 2;
const DB_NAME = 'dilla-voice-models';
const STORE_NAME = 'models';

export class ManifestError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

export interface Dfn3SubGraphEntry {
  url: string;
  sha256: string;
}

export interface Dfn3Config {
  sample_rate: number;
  fft_size: number;
  hop_size: number;
  nb_erb: number;
  nb_df: number;
  df_order: number;
  lookahead_frames: number;
  /**
   * Streaming-state tensor shapes (v2 manifest only). Mirrors the JSON
   * manifest's `dfn3.config.state_shapes` object verbatim. Present when the
   * server ships the v2 re-exported ONNX sub-graphs with explicit state I/O.
   */
  state_shapes: Dfn3StateShapes;
}

export interface Dfn3Manifest {
  version: number;
  minClientVersion: number;
  dfn3: {
    enc: Dfn3SubGraphEntry;
    erb_dec: Dfn3SubGraphEntry;
    df_dec: Dfn3SubGraphEntry;
    config: Dfn3Config;
  };
}

export interface LoadedDfn3Model {
  encBytes: Uint8Array;
  erbDecBytes: Uint8Array;
  dfDecBytes: Uint8Array;
  version: number;
  config: Dfn3Config;
}

const SUB_GRAPHS = ['enc', 'erb_dec', 'df_dec'] as const;
type SubGraphName = (typeof SUB_GRAPHS)[number];

const SHA256_HEX = /^[a-f0-9]{64}$/;

function isSubGraphEntry(value: unknown): value is Dfn3SubGraphEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.url === 'string' &&
    typeof v.sha256 === 'string' &&
    SHA256_HEX.test(v.sha256)
  );
}

const STATE_SHAPE_KEYS = [
  'erb_ctx',
  'spec_ctx',
  'h_enc',
  'h_erb',
  'c0_ctx',
  'h_df',
] as const;

function isStateShapes(value: unknown): value is Dfn3StateShapes {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  for (const k of STATE_SHAPE_KEYS) {
    const dim = v[k];
    if (!Array.isArray(dim) || dim.length === 0) return false;
    for (const d of dim) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d <= 0) return false;
    }
  }
  return true;
}

function isDfn3Config(value: unknown): value is Dfn3Config {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sample_rate === 'number' &&
    typeof v.fft_size === 'number' &&
    typeof v.hop_size === 'number' &&
    typeof v.nb_erb === 'number' &&
    typeof v.nb_df === 'number' &&
    typeof v.df_order === 'number' &&
    typeof v.lookahead_frames === 'number' &&
    isStateShapes(v.state_shapes)
  );
}

export async function fetchManifest(serverUrl: string): Promise<Dfn3Manifest> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/voice/models/manifest.json`);
  } catch (err) {
    throw new ManifestError('Network error fetching voice model manifest', err);
  }

  if (!response.ok) {
    throw new ManifestError(`Manifest HTTP ${response.status}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new ManifestError('Manifest is not valid JSON', err);
  }

  if (typeof json !== 'object' || json === null) {
    throw new ManifestError('Manifest is not an object');
  }

  const m = json as Record<string, unknown>;
  const version = m.version;
  const minClient = (m.minClientVersion ?? 0) as number;
  if (typeof version !== 'number') {
    throw new ManifestError('Manifest version is missing or not a number');
  }
  if (typeof minClient !== 'number' || minClient > SUPPORTED_MANIFEST_VERSION) {
    throw new ManifestError(
      `Manifest version incompatible (minClientVersion=${minClient}, supported=${SUPPORTED_MANIFEST_VERSION})`,
    );
  }

  const dfn3 = m.dfn3 as Record<string, unknown> | undefined;
  if (!dfn3 || typeof dfn3 !== 'object') {
    throw new ManifestError('Manifest entry "dfn3" missing or not an object');
  }

  for (const sub of SUB_GRAPHS) {
    if (!isSubGraphEntry(dfn3[sub])) {
      throw new ManifestError(`Manifest dfn3.${sub} missing or invalid`);
    }
  }
  if (!isDfn3Config(dfn3.config)) {
    throw new ManifestError('Manifest dfn3.config missing or invalid');
  }

  return m as unknown as Dfn3Manifest;
}

export async function validateChecksum(
  bytes: Uint8Array,
  expectedHex: string,
): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== expectedHex) {
    throw new ManifestError(
      `Checksum mismatch (expected ${expectedHex.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    );
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const cacheKey = (sub: SubGraphName, version: number) => `dfn3-v${version}/${sub}`;

async function getCached(sub: SubGraphName, version: number): Promise<Uint8Array | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(cacheKey(sub, version));
      req.onsuccess = () => {
        const result = req.result as Uint8Array | undefined;
        resolve(result ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function putCached(sub: SubGraphName, version: number, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(bytes, cacheKey(sub, version));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function loadSubGraph(
  serverUrl: string,
  sub: SubGraphName,
  entry: Dfn3SubGraphEntry,
  version: number,
): Promise<Uint8Array> {
  const cached = await getCached(sub, version);
  if (cached) {
    try {
      await validateChecksum(cached, entry.sha256);
      return cached;
    } catch {
      // Cached bytes don't match the manifest digest — fall through and refetch.
    }
  }

  const response = await fetch(`${serverUrl}${entry.url}`);
  if (!response.ok) {
    throw new ManifestError(`Failed to fetch dfn3.${sub} (HTTP ${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await validateChecksum(bytes, entry.sha256);
  await putCached(sub, version, bytes);
  return bytes;
}

/**
 * Fetch and validate all three DFN3 sub-graphs, returning the raw ONNX bytes
 * along with the version and DFN3 hyperparameters from the manifest.
 *
 * Sub-graphs are fetched in parallel. Each is cached in IndexedDB under a
 * version-scoped key so subsequent calls only re-fetch the manifest.
 */
export async function loadDfn3Model(serverUrl: string): Promise<LoadedDfn3Model> {
  const manifest = await fetchManifest(serverUrl);
  const { version } = manifest;
  const [encBytes, erbDecBytes, dfDecBytes] = await Promise.all([
    loadSubGraph(serverUrl, 'enc', manifest.dfn3.enc, version),
    loadSubGraph(serverUrl, 'erb_dec', manifest.dfn3.erb_dec, version),
    loadSubGraph(serverUrl, 'df_dec', manifest.dfn3.df_dec, version),
  ]);

  return {
    encBytes,
    erbDecBytes,
    dfDecBytes,
    version,
    config: manifest.dfn3.config,
  };
}
