// Browser-side console relay.
//
// Wraps console.{log,info,warn,error,debug} so each call is also
// queued for delivery to the server's `/api/v1/debug/browser-log`
// endpoint. The endpoint no-ops on the server unless
// `DILLA_BROWSER_LOG_FORWARD=true` (or `DILLA_INSECURE=true`), so
// installing this in dev is free.
//
// Why this lives outside any framework code: it patches console
// BEFORE the rest of the app runs so early-boot errors (theme load,
// initial route, OTel setup) get captured too. install() must run
// once, very early — see main.tsx.

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';

interface QueuedEntry {
  level: Level;
  message: string;
  ts: number;
  tag?: string;
  user?: string;
}

const ENDPOINT = '/api/v1/debug/browser-log';
const FLUSH_INTERVAL_MS = 500;
const MAX_QUEUE = 500;
// F6 — per-line ceiling sent to the server. JWTs, prekey blobs, or
// runaway error stacks otherwise inflate the relay request to multi-MB
// payloads. 2 KiB is plenty for human-readable diagnostics; anything
// bigger gets truncated.
const MAX_LINE_BYTES = 2048;
// F6 — regex matching base64ish blobs of 40+ characters. Catches JWTs
// (which routinely run to 200+ chars), Ed25519 sigs (88 b64 chars),
// AES-GCM ciphertext, refresh tokens, identity blobs. We deliberately
// pick 40 as the threshold so short strings like "channel-abc-1234"
// pass through.
const LONG_TOKEN_RE = /[A-Za-z0-9_+/=-]{40,}/g;
// F6 — JWT-shaped triples (`header.payload.signature`) — catches the
// common case even when the segments themselves are < 40 chars.
const JWT_SHAPE_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// F6 — Authorization-style header blobs that leak the bearer token.
const BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._\-+/=]+)/gi;

let installed = false;
let queue: QueuedEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let session = '';
let currentUser: string | undefined;
let suppressed = false;

function genSession(): string {
  // Short, human-readable per-tab identifier so server logs from
  // different browsers/tabs are easy to disentangle.
  const r = Math.random().toString(36).slice(2, 8);
  const t = Date.now().toString(36).slice(-4);
  return `${r}-${t}`;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? '\n' + value.stack : ''}`;
  }
  try {
    return JSON.stringify(value, (_k, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === 'bigint') return v.toString() + 'n';
      return v;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function format(args: unknown[]): string {
  return args.map(safeStringify).join(' ');
}

/**
 * F6 — strip PII / secret-shaped substrings from a forwarded log line
 * and cap the result at MAX_LINE_BYTES.
 *
 * Order matters: JWT shapes first (so the substring `eyJ...` is replaced
 * intact before LONG_TOKEN_RE would split it on the dots), then the
 * Bearer header pattern (to keep the `Bearer ` literal but redact the
 * value), then the generic long-token regex for everything else.
 */
export function scrubLogLine(input: string): string {
  if (!input) return input;
  let out = input
    .replace(JWT_SHAPE_RE, '[REDACTED-JWT]')
    .replace(BEARER_RE, '$1[REDACTED]')
    .replace(LONG_TOKEN_RE, '[REDACTED]');
  // Length cap. We count UTF-16 code units (string.length); a multi-byte
  // UTF-8 measurement would be more precise but slower, and the server
  // applies its own length guard too.
  if (out.length > MAX_LINE_BYTES) {
    out = out.slice(0, MAX_LINE_BYTES) + ' …[truncated]';
  }
  return out;
}

function enqueue(level: Level, message: string, tag?: string) {
  if (suppressed) return;
  if (queue.length >= MAX_QUEUE) {
    // Drop oldest — we'd rather lose backlog than block the console.
    queue.shift();
  }
  // F6 — scrub long tokens + JWT shapes + Bearer headers + cap length
  // BEFORE the entry hits the queue, so a flush failure can't leak the
  // pre-scrub copy.
  queue.push({ level, message: scrubLogLine(message), ts: Date.now(), tag, user: currentUser });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const entries = queue;
  queue = [];
  const body = JSON.stringify({ session, entries });
  // Suppress while sending so our own fetch errors don't loop back
  // into the queue and pin the CPU.
  suppressed = true;
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Keepalive lets the request survive a tab close so the last
      // batch (e.g. an error right before unload) makes it through.
      keepalive: body.length < 60_000,
      credentials: 'same-origin',
    });
  } catch {
    // Network blip — drop this batch silently. Logs are best-effort.
  } finally {
    suppressed = false;
  }
}

/**
 * Patch console.* and capture global errors. Idempotent.
 * Call this as early as possible during boot.
 */
export function installBrowserLogRelay(opts?: { tag?: string }): void {
  if (installed) return;
  installed = true;
  session = genSession();
  const bootTag = opts?.tag;

  const levels: Level[] = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    const original = (console[level] as (...args: unknown[]) => void).bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        enqueue(level, format(args), bootTag);
      } catch {
        // never let logging crash the app
      }
      original(...args);
    };
  }

  window.addEventListener('error', (ev) => {
    const msg = ev.error
      ? safeStringify(ev.error)
      : `${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`;
    enqueue('error', `[window.error] ${msg}`, bootTag);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    enqueue('error', `[unhandledrejection] ${safeStringify(ev.reason)}`, bootTag);
  });

  // Make sure the last batch ships when the tab closes.
  window.addEventListener('pagehide', () => {
    if (queue.length === 0) return;
    try {
      const body = JSON.stringify({ session, entries: queue });
      queue = [];
      navigator.sendBeacon?.(
        ENDPOINT,
        new Blob([body], { type: 'application/json' }),
      );
    } catch {
      // ignore
    }
  });
}

/**
 * Tag subsequent log entries with a user identifier so multi-tab
 * server logs stay readable once login completes.
 */
export function setBrowserLogUser(user: string | undefined): void {
  currentUser = user || undefined;
}

/**
 * Test/cleanup hook — not used in production.
 */
export function __resetBrowserLogRelayForTests(): void {
  installed = false;
  queue = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  currentUser = undefined;
  suppressed = false;
  session = '';
}
