// CSPRNG-backed short identifier helper.
//
// All call sites in the shell tree used `Math.random().toString(36)` to
// build a per-event id (upload rows, toast keys, mock invite codes,
// fake lamport ticks for the mesh bar). None of those are security-
// sensitive — but Sonar flags Math.random under S2245 regardless. The
// honest "no NOSONAR needed" fix is to source the entropy from
// `crypto.getRandomValues`, which costs nothing at this cardinality and
// makes the call site read defensively at a glance.
//
// Defaults to a 6-character base36 tail, matching the legacy
// `Math.random().toString(36).slice(2, 6)` shape so the on-screen ids
// stay roughly the same length.

const RADIX = 36;
const TAIL_LEN = 6;

export function randomTail(length: number = TAIL_LEN): string {
  const source = globalThis.crypto ?? (typeof window !== 'undefined' ? globalThis.crypto : undefined);
  if (!source?.getRandomValues) {
    // SSR / pre-secure-context fallback — still avoid Math.random by
    // hashing the current time, which is enough for a UI id.
    return Date.now().toString(RADIX).slice(-length).padStart(length, '0');
  }
  // 4 bytes -> 32 random bits -> up to ~6 base36 chars. Generate a
  // little extra so very-rare leading-zero strips don't shorten below
  // the requested length.
  const bytes = new Uint32Array(1);
  source.getRandomValues(bytes);
  return bytes[0].toString(RADIX).padStart(length, '0').slice(0, length);
}

/**
 * Build a short identifier of the form `<prefix>-<timestamp>-<rand>`.
 * Used for upload rows, toast keys, and other collision-tolerant UI ids.
 */
export function shortId(prefix: string): string {
  return prefix + '-' + Date.now() + '-' + randomTail();
}

/**
 * Return an integer in the closed range [0, max). CSPRNG-backed
 * replacement for `Math.floor(Math.random() * max)` at the handful of
 * mock-ticker sites in the mesh shell (lamport jitter, latency
 * jitter). Caller is responsible for keeping `max` small enough that
 * modulo bias is irrelevant — these are UI animations.
 */
export function randomInt(max: number): number {
  if (max <= 0) return 0;
  const source = globalThis.crypto ?? (typeof window !== 'undefined' ? globalThis.crypto : undefined);
  if (!source?.getRandomValues) return 0;
  const bytes = new Uint32Array(1);
  source.getRandomValues(bytes);
  return bytes[0] % max;
}
