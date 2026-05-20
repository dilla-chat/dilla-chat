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

function enqueue(level: Level, message: string, tag?: string) {
  if (suppressed) return;
  if (queue.length >= MAX_QUEUE) {
    // Drop oldest — we'd rather lose backlog than block the console.
    queue.shift();
  }
  queue.push({ level, message, ts: Date.now(), tag, user: currentUser });
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
