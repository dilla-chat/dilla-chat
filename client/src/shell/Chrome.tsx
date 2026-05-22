// @ts-nocheck
// Top/bottom shell chrome + command palette + search palette, ported from
// design_handoff_dilla_mesh/mesh-chrome.jsx. Strict TS types come later.

import React from 'react';
import { useShellDataContext } from './ShellDataContext';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useServerConfig } from '../hooks/useServerConfig';
import { isCryptoInitialized } from '../services/crypto';

const { useState: useStateMC, useEffect: useEffectMC, useRef: useRefMC, useMemo: useMemoMC } = React;

// Mock per-member node/fingerprint tables removed — those values come
// from the team store / server now (member.publicKeyHex, the team's
// node host). Keeping empty stubs here only to avoid touching callers
// that still read them; the real lookups happen via the shell-data
// context (useShellDataContext) at render time.
const MEMBER_NODES = {};
const FINGERPRINTS = {};

// ───────── top bar ─────────
function TopBar({ onCmdK, onSearch, onHelp, federated = true, degraded = false, teamName = '', nodeName = 'local' }) {
  const [_tick, setTick] = useStateMC(0);
  useEffectMC(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  return (
    <div className="mesh-top">
      <div className="mt-left">
        <span className="mt-brand">DILLA</span>
        <span className="mt-sep">─</span>
        <span className="mt-dim">team</span> <span>{teamName}</span>
        <span className="mt-sep">─</span>
        <span className="mt-dim">node</span> <span>{nodeName}</span>
        <span className="mt-sep">─</span>
        {federated ?
        <span className="mt-ok">● MESH OK</span> :
        <span className="mt-ok">● READY</span>}
      </div>
      <div className="mt-center">
        {time}
      </div>
      <div className="mt-right" style={{ padding: "0px" }}>
        <button className="mt-key" onClick={onCmdK}>
          <span className="mt-kbd">⌘K</span> CMD
        </button>
        <button className="mt-key" onClick={onSearch}><span className="mt-kbd">/</span> SEARCH</button>
        <button className="mt-key" onClick={onHelp}><span className="mt-kbd">?</span> HELP</button>
      </div>
    </div>);

}

// ───────── bottom status bar ─────────
function BottomBar({ voiceConnection, peerStatus, federated = true, degraded = false, nodeHost = 'local' }) {
  const [lamport, setLamport] = useStateMC(12944);
  const [latency, setLatency] = useStateMC(14);
  const serverConfig = useServerConfig();
  const dbEncrypted = serverConfig?.db_encrypted ?? null;
  const dbLabel =
    dbEncrypted === null ? 'CHECKING…' :
    dbEncrypted ? 'SQLCIPHER · AES-256' : 'PLAIN SQLITE · UNENCRYPTED';
  const derivedKey = useAuthStore((s) => s.derivedKey);
  const e2eState = derivedKey ? (isCryptoInitialized() ? 'active' : 'initializing') : 'locked';
  const e2eLabel = e2eState === 'active'
    ? 'SIGNAL · X3DH · AES-256-GCM'
    : e2eState === 'initializing' ? 'INITIALIZING…' : 'LOCKED';
  useEffectMC(() => {
    const id = setInterval(() => {
      setLamport((l) => l + Math.floor(Math.random() * 4));
      setLatency(() => 12 + Math.floor(Math.random() * 6));
    }, 1400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mesh-bottom">
      <div className="mb-chunk mb-clickable"
           title="Click for federation settings"
           onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } }))}>
        <span className="mb-k">node</span> {nodeHost}
      </div>
      {federated ?
      <>
          <div className="mb-chunk mb-clickable"
               title="Click for peer status"
               onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } }))}>
            <span className="mb-k">peers</span> {degraded
              ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>1/2 ⚠</span>
              : <span className="mb-ok">2/2 ▲</span>}
          </div>
          <div className="mb-chunk"><span className="mb-k">lamport</span> {lamport.toLocaleString()}↑</div>
          <div className="mb-chunk"><span className="mb-k">latency</span> {degraded ? '—' : latency + 'ms p50'}</div>
        </> :
      null}
      <div className={'mb-chunk mb-clickable' + (e2eState === 'locked' ? ' mb-warn' : '')}
           title={e2eState === 'active'
             ? 'X3DH key agreement + Double Ratchet, AES-256-GCM AEAD. Click for encryption details.'
             : e2eState === 'initializing' ? 'Identity unlocked; crypto manager booting…'
             : 'No derived key in this session — messages cannot be decrypted until you unlock.'}
           onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'privacy' } }))}>
        <span className="mb-k">e2e</span> {e2eLabel}
      </div>
      <div className={'mb-chunk' + (dbEncrypted === false ? ' mb-warn' : '')}
           title={dbEncrypted === false
             ? 'Server is running without DILLA_DB_PASSPHRASE (--insecure). The DB file on disk is plain SQLite.'
             : dbEncrypted ? 'SQLCipher at-rest encryption is active on the server.'
             : 'Waiting for server config…'}>
        <span className="mb-k">db</span> {dbLabel}
      </div>
      {voiceConnection && (
        <div className="mb-chunk mb-voice mb-clickable"
             title="Click for voice settings"
             onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'voice' } }))}>
          <span className="mb-k">voice</span> SFRAME · SRTP · OPUS 48kHz
          <AudioMeter />
        </div>
      )}
      <div className="mb-chunk mb-grow"></div>
      <div className="mb-chunk"><span className="mb-k">v</span> {__APP_VERSION__} · build {__GIT_SHA__}</div>
    </div>);

}

// ───────── audio level meter ─────────
// Renders 12 bars driven by the user's actual mic level. The VAD pump
// writes `voiceLevel` (0..1 RMS) onto the local user's peer entry on
// every audio frame; we subscribe to that here. When muted or before
// joining voice, level is 0 and the bars sit at their resting opacity.
function AudioMeter() {
  const currentTeamId = useVoiceStore((s) => s.currentTeamId);
  const myUserId = useAuthStore((s) =>
    currentTeamId ? s.teams.get(currentTeamId)?.user?.id ?? null : null,
  );
  const level = useVoiceStore((s) =>
    myUserId ? s.peers[myUserId]?.voiceLevel ?? 0 : 0,
  );

  // Shape the 0..1 level into 12 bars. Center bars react slightly
  // earlier than edges so the indicator reads like a typical VU meter.
  const bars = useMemoMC(() => {
    const out: number[] = [];
    for (let i = 0; i < 12; i++) {
      // Distance from center, 0..1
      const d = Math.abs(i - 5.5) / 5.5;
      // Center bars need less signal to light. Edges need more.
      const threshold = 0.05 + d * 0.6;
      const v = Math.max(0, Math.min(1, (level - threshold) / (1 - threshold)));
      out.push(v);
    }
    return out;
  }, [level]);

  return (
    <span className="audio-meter">
      {bars.map((v, i) => (
        <span
          key={i}
          className="am-bar"
          style={{ opacity: 0.25 + v * 0.75, height: 4 + Math.round(v * 8) }}
        />
      ))}
    </span>
  );
}

// ───────── command palette ─────────
const COMMANDS = [
{ sec: 'NAVIGATE', cmd: 'channel #design', hint: '⌘+1', shortcut: 'design' },
{ sec: 'NAVIGATE', cmd: 'channel #general', hint: '⌘+2', shortcut: 'general' },
{ sec: 'NAVIGATE', cmd: 'channel #dev', hint: '⌘+3', shortcut: 'dev' },
{ sec: 'NAVIGATE', cmd: 'channel #mesh-status', hint: '⌘+4', shortcut: 'mesh' },
{ sec: 'NAVIGATE', cmd: 'channel #voice-lounge', hint: '⌘+5', shortcut: 'voice' },
{ sec: 'VOICE', cmd: 'simulate incoming call (from ada)', hint: '', dispatch: 'dilla:incoming-call', payload: { from: 'ada', kind: 'voice' } },
{ sec: 'VOICE', cmd: 'simulate incoming call (from ben)', hint: '', dispatch: 'dilla:incoming-call', payload: { from: 'ben', kind: 'voice' } },
{ sec: 'VOICE', cmd: 'toggle mute', hint: 'M' },
{ sec: 'VOICE', cmd: 'toggle deafen', hint: 'D' },
{ sec: 'VOICE', cmd: 'disconnect', hint: '⌘+⇧+D' },
{ sec: 'FEDERATION',cmd: 'add peer node', hint: '', dispatch: 'dilla:add-peer' },
{ sec: 'FEDERATION',cmd: 'simulate peer drop (degraded)', hint: '', dispatch: 'dilla:connection', payload: 'degraded' },
{ sec: 'FEDERATION',cmd: 'simulate offline', hint: '', dispatch: 'dilla:connection', payload: 'offline' },
{ sec: 'FEDERATION',cmd: 'simulate reconnecting', hint: '', dispatch: 'dilla:connection', payload: 'reconnecting' },
{ sec: 'FEDERATION',cmd: 'show mesh status', hint: '⌘+F' },
{ sec: 'FEDERATION',cmd: 'generate join token', hint: '' },
{ sec: 'ENCRYPTION',cmd: 'verify safety number (with ada)', hint: '', dispatch: 'dilla:verify-safety', payload: 'ada' },
{ sec: 'ENCRYPTION',cmd: 'verify safety number (with mira)', hint: '', dispatch: 'dilla:verify-safety', payload: 'mira' },
{ sec: 'ENCRYPTION',cmd: 'rotate session keys', hint: '' },
{ sec: 'ENCRYPTION',cmd: 'export identity backup', hint: '' },
{ sec: 'ACCOUNT', cmd: 'set custom status', hint: '' },
{ sec: 'ACCOUNT', cmd: 'sign out', hint: '⌘+⇧+Q' },
];


function CommandPalette({ open, onClose, onPickChannel, commands }) {
  const [q, setQ] = useStateMC('');
  const [idx, setIdx] = useStateMC(0);
  const inputRef = useRefMC(null);
  const source = (commands && commands.length) ? commands : COMMANDS;
  const filtered = source.filter((c) => !q || c.cmd.toLowerCase().includes(q.toLowerCase()) || c.sec.toLowerCase().includes(q.toLowerCase()));
  useEffectMC(() => {if (open && inputRef.current) inputRef.current.focus();setIdx(0);setQ('');}, [open]);
  if (!open) return null;

  const sections = [...new Set(filtered.map((c) => c.sec))];

  function pick(c) {
    // Prefer explicit channelId from dynamic commands; fall back to shortcut
    // for backwards compat with the hardcoded handoff COMMANDS list.
    if (c.channelId && onPickChannel) onPickChannel(c.channelId);
    else if (c.shortcut && onPickChannel) onPickChannel(c.shortcut === 'mesh' ? 'mesh' : c.shortcut);
    if (c.dispatch) {
      window.dispatchEvent(new CustomEvent(c.dispatch, { detail: c.payload }));
    }
    onClose();
  }

  return (
    <div className="modal-overlay modal-overlay--top" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">
          <span className="cmdk-prompt">{'>'}</span>
          <input ref={inputRef}
          className="cmdk-input"
          placeholder="type a command…"
          value={q}
          onChange={(e) => {setQ(e.target.value);setIdx(0);}}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {e.preventDefault();setIdx((i) => Math.min(filtered.length - 1, i + 1));}
            if (e.key === 'ArrowUp') {e.preventDefault();setIdx((i) => Math.max(0, i - 1));}
            if (e.key === 'Enter') {if (filtered[idx]) pick(filtered[idx]);}
          }} />
          <span className="cmdk-hint">ESC to close · ↑↓ to navigate · ↵ to run</span>
        </div>
        <div className="cmdk-list">
          {sections.map((sec) =>
          <div key={sec}>
              <div className="cmdk-sec">{sec}</div>
              {filtered.filter((c) => c.sec === sec).map((c) => {
              const i = filtered.indexOf(c);
              return (
                <div key={c.cmd}
                className={'cmdk-row' + (i === idx ? ' selected' : '')}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(c)}>
                    <span className="cmdk-cmd">{c.cmd}</span>
                    <span className="cmdk-kbd">{c.hint}</span>
                  </div>);

            })}
            </div>
          )}
          {filtered.length === 0 && <div className="cmdk-empty">no matches</div>}
        </div>
      </div>
    </div>);

}

// ───────── search palette (opens on /) ─────────
function SearchPalette({ open, onClose, onPickChannel }) {
  const data = useShellDataContext() as any;
  const [q, setQ] = useStateMC('');
  const [idx, setIdx] = useStateMC(0);
  const inputRef = useRefMC(null);
  useEffectMC(() => {if (open && inputRef.current) inputRef.current.focus();setIdx(0);setQ('');}, [open]);

  // Parse query into structured filters. The tips row advertises three
  // operators: from:<author> in:#<channel> has:<image|file|link>. They
  // AND with the remaining free-text. Unknown prefix:value tokens fall
  // through to free-text so a typo doesn't silently mismatch.
  const parsed = (() => {
    const tokens = q.split(/\s+/).filter(Boolean);
    const filters: { from?: string; inChan?: string; has?: 'image' | 'file' | 'link' } = {};
    const free: string[] = [];
    const opRe = /^(from|in|has):(.+)$/i;
    for (const tok of tokens) {
      const m = tok.match(opRe);
      if (!m) { free.push(tok); continue; }
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === 'from') filters.from = val.replace(/^@/, '').toLowerCase();
      else if (key === 'in') filters.inChan = val.replace(/^#/, '').toLowerCase();
      else if (key === 'has' && (val === 'image' || val === 'file' || val === 'link')) filters.has = val;
      else free.push(tok);
    }
    return { filters, text: free.join(' ') };
  })();

  const results = (() => {
    if (!q || q.length < 2) return [];
    if (!data?.MESSAGES) return [];
    const { filters, text } = parsed;
    const ql = text.toLowerCase();
    // Pre-resolve channel id when in: was used; empty set means no
    // match (in:#bogus -> zero results).
    let inChanIds: Set<string> | null = null;
    if (filters.inChan) {
      const channels = (data.CHANNELS ?? []) as Array<{ id: string; name: string }>;
      const matches = channels
        .filter((c) => c.name.toLowerCase() === filters.inChan)
        .map((c) => c.id);
      inChanIds = new Set(matches);
      if (matches.length === 0) return [];
    }
    // Same pre-resolve for from: — match against member display names
    // and username.
    let fromUserIds: Set<string> | null = null;
    if (filters.from) {
      const members = (data.MEMBERS ?? []) as Array<{ id: string; name: string; username?: string }>;
      const matches = members
        .filter((m) =>
          m.name?.toLowerCase() === filters.from ||
          m.username?.toLowerCase() === filters.from,
        )
        .map((m) => m.id);
      fromUserIds = new Set(matches);
      if (matches.length === 0) return [];
    }
    const hits: Array<{ chId: string; msg: any }> = [];
    Object.entries(data.MESSAGES).forEach(([chId, msgs]) => {
      if (inChanIds && !inChanIds.has(chId)) return;
      (msgs as any[]).forEach((m) => {
        if (m.kind === 'system') return;
        if (fromUserIds && !fromUserIds.has(m.author)) return;
        if (filters.has === 'image' && m.kind !== 'image') return;
        if (filters.has === 'file' && m.kind !== 'file') return;
        if (filters.has === 'link') {
          const t = m.text || '';
          if (!/https?:\/\//i.test(t)) return;
        }
        if (ql) {
          const body = (m.text || '').toLowerCase();
          if (!body.includes(ql)) return;
        }
        hits.push({ chId, msg: m });
      });
    });
    return hits.slice(0, 20);
  })();

  function highlight(text, ql) {
    if (!ql) return text;
    const ix = text.toLowerCase().indexOf(ql.toLowerCase());
    if (ix < 0) return text;
    const start = Math.max(0, ix - 30);
    const end = Math.min(text.length, ix + ql.length + 60);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return [
    prefix + text.slice(start, ix),
    <mark key="m">{text.slice(ix, ix + ql.length)}</mark>,
    text.slice(ix + ql.length, end) + suffix];

  }

  function pick(r) {
    if (onPickChannel) onPickChannel(r.chId);
    onClose();
  }

  if (!open) return null;
  return (
    <div className="modal-overlay modal-overlay--top" onClick={onClose}>
      <div className="cmdk srch" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">
          <span className="cmdk-prompt">/</span>
          <input ref={inputRef}
          className="cmdk-input"
          placeholder="search messages across kanals…"
          value={q}
          onChange={(e) => {setQ(e.target.value);setIdx(0);}}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {e.preventDefault();setIdx((i) => Math.min(results.length - 1, i + 1));}
            if (e.key === 'ArrowUp') {e.preventDefault();setIdx((i) => Math.max(0, i - 1));}
            if (e.key === 'Enter') {if (results[idx]) pick(results[idx]);}
          }} />
          <span className="cmdk-hint">{q.length < 2 ? 'type 2+ chars' : `${results.length} match${results.length === 1 ? '' : 'es'}`}</span>
        </div>
        <div className="cmdk-list">
          {q.length < 2 &&
          <div className="srch-tip">
              <div className="cmdk-sec">SEARCH SCOPE</div>
              <div className="srch-tip-row">all kanals · client-side · works on encrypted messages</div>
              <div className="cmdk-sec">TIPS</div>
              <div className="srch-tip-row"><kbd>from:ada</kbd> by author · <kbd>in:#dev</kbd> in channel · <kbd>has:image</kbd> with attachment</div>
            </div>
          }
          {q.length >= 2 && results.length === 0 && <div className="cmdk-empty">no matches in 5 kanals</div>}
          {results.map((r, i) => {
            const author = data.byId[r.msg.author] || { name: r.msg.author, color: '#666', initials: '??' };
            const ch = data.CHANNELS.find((c) => c.id === r.chId);
            return (
              <div key={r.msg.id}
              className={'srch-row' + (i === idx ? ' selected' : '')}
              onMouseEnter={() => setIdx(i)}
              onClick={() => pick(r)}>
                <div className="srch-meta">
                  <span className="srch-ch">#{ch ? ch.name : r.chId}</span>
                  <span className="srch-sep">·</span>
                  <span className="srch-author" style={{ color: author.color }}>{author.name}</span>
                  <span className="srch-sep">·</span>
                  <span className="srch-time">{r.msg.at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="srch-snippet">{highlight(r.msg.text || '', parsed.text || q)}</div>
              </div>);

          })}
        </div>
      </div>
    </div>);

}

export { TopBar, BottomBar, CommandPalette, SearchPalette, MEMBER_NODES, FINGERPRINTS };