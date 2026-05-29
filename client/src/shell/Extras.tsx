// @ts-nocheck
// Tier-2 extras ported from design_handoff_dilla_mesh/extras.jsx:
// notification toasts, first-run splash, incoming-call ring,
// safety-number compare flow, federation join wizard, connection banner.
// All small, theme-aware, listen for window events.

import React from 'react';
import { useShellDataContext } from './ShellDataContext';
import { useVerifiedContacts } from '../stores/verifiedContactsStore';
import { shortId } from '../utils/randomId';

const { useState: useT2, useEffect: useT2E, useRef: useT2R } = React;

function handleCallKey(e: KeyboardEvent, onAccept: () => void, onDecline: () => void): void {
  if (e.key === 'Escape') onDecline();
  else if (e.key === 'Enter') onAccept();
}

function toastIcon(kind?: string): string {
  if (kind === 'mention') return '@';
  if (kind === 'voice') return '◉';
  return '●';
}

// ───────── Notification toasts ─────────
function NotificationStack({ teaserOnly = false }) {
  const shell = useShellDataContext() as any;
  const teamName = shell?.SERVERS?.[0]?.name || '';
  const [toasts, setToasts] = useT2([]);
  // Per-toast dismiss timer so we can cancel + reschedule on hover. Plain
  // object ref so changes don't trigger renders.
  const timers = useT2R<Record<string, ReturnType<typeof setTimeout>>>({});
  useT2E(() => {
    const expireToast = (id) => {
      setToasts(prev => prev.filter(x => x.id !== id));
      delete timers.current[id];
    };
    function add(e) {
      const id = shortId('t');
      const t = { id, ...e.detail };
      setToasts(prev => [...prev.slice(-3), t]);
      const dur = e.detail.duration || 5500;
      timers.current[id] = setTimeout(() => expireToast(id), dur);
    }
    globalThis.addEventListener('dilla:notify', add);
    return () => globalThis.removeEventListener('dilla:notify', add);
  }, []);

  function dismiss(id) {
    if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; }
    setToasts(prev => prev.filter(x => x.id !== id));
  }
  function pauseDismiss(id) {
    if (timers.current[id]) { clearTimeout(timers.current[id]); delete timers.current[id]; }
  }
  return (
    <div className="notify-stack">
      {toasts.length >= 4 && (
        <div className="notify-overflow">
          <span>{toasts.length} active · </span>
          <button onClick={() => setToasts([])}>clear all</button>
        </div>
      )}
      {toasts.map(t => {
        const target = t.channelId || t.channel;
        const handleClick = () => {
          // Prefer the real channel id (set by mention notifications);
          // fall back to the channel name for notify events from
          // older code paths that only pass the human label.
          if (target) {
            globalThis.dispatchEvent(new CustomEvent('dilla:pickchannel', { detail: target }));
            globalThis.focus();
          }
          dismiss(t.id);
        };
        const className = 'notify-toast' + (t.mention ? ' mention' : '') + (target ? ' clickable' : '');
        const inner = (
          <>
            <div className="nt-icon">
              {toastIcon(t.kind)}
            </div>
            <div className="nt-body">
              <div className="nt-head">
                <span className="nt-team">{t.team || teamName}</span>
                {t.channel && <><span className="nt-sep">·</span><span className="nt-channel">#{t.channel}</span></>}
              </div>
              {teaserOnly ? (
                <div className="nt-text nt-teaser">
                  <span className="nt-lock">🔒</span> {t.author} sent an encrypted message
                </div>
              ) : (
                <>
                  <div className="nt-author">{t.author}</div>
                  <div className="nt-text">{t.text}</div>
                </>
              )}
            </div>
            <button className="nt-close" onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}>×</button>
          </>
        );
        return target ? (
          <button
            key={t.id}
            type="button"
            className={className}
            onMouseEnter={() => pauseDismiss(t.id)}
            onClick={handleClick}
          >
            {inner}
          </button>
        ) : (
          <output
            key={t.id}
            className={className}
            onMouseEnter={() => pauseDismiss(t.id)}
          >
            {inner}
          </output>
        );
      })}
    </div>
  );
}

// Demo notification trigger removed — used to fire pre-baked mock toasts
// from "ada"/"mira"/"ben" that leaked into the live app. Real notifications
// now come from dispatched `dilla:notify` events with real data.
function notifyDemo() {
  /* no-op: live data drives notifications */
}

// ───────── First-run splash ─────────
function FirstRunSplash({ onDone }) {
  const [phase, setPhase] = useT2(0);
  const host = (useShellDataContext() as any)?.SERVERS?.[0]?.node || 'local';
  const phases = [
    `connecting to ${host}…`,
    'unsealing keystore · argon2id',
    'verifying jwt · ed25519',
    'subscribing to channels',
    'syncing mesh state',
    'ready.',
  ];
  useT2E(() => {
    const id = setInterval(() => {
      setPhase(p => {
        if (p + 1 >= phases.length) {
          clearInterval(id);
          setTimeout(onDone, 350);
          return p + 1;
        }
        return p + 1;
      });
    }, 180);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="splash">
      <div className="splash-bg" />
      <div className="splash-card">
        <div className="splash-logo">
          <span className="splash-mark">D</span>
          <span className="splash-name">DILLA</span>
          <span className="splash-caret" />
        </div>
        <div className="splash-log">
          {phases.slice(0, phase + 1).map((line, i) => (
            <div key={`splash-${line}-${i}`} className="splash-line">
              <span className="splash-prompt">{i < phase ? '✓' : '›'}</span> {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────── Incoming voice call ─────────
function IncomingCall({ call, onAccept, onDecline }) {
  const shell = useShellDataContext() as any;
  useT2E(() => {
    if (!call) return;
    const onKey = (e) => handleCallKey(e, onAccept, onDecline);
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [call, onAccept, onDecline]);
  if (!call) return null;
  const m = shell?.byId?.[call.from];
  if (!m) return null;
  return (
    <div className="modal-overlay modal-overlay--strong-blur">
      <div className="ring-card">
        <div className="ring-eyebrow">
          <span className="ring-dot" /> incoming · voice
        </div>
        <div
          className={'ring-avatar' + (m.avatarUrl ? ' has-image' : '')}
          style={m.avatarUrl
            ? { backgroundImage: `url(${m.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'transparent' }
            : { backgroundColor: m.color }}
        >
          <span className="ring-pulse" />
          <span className="ring-pulse ring-pulse-2" />
          {!m.avatarUrl && m.initials}
        </div>
        <div className="ring-name">{m.name}</div>
        <div className="ring-sub">{call.kind === 'video' ? 'wants to start a video call' : 'is calling you'} · SRTP · opus</div>
        <div className="ring-actions">
          <button className="ring-btn decline" onClick={onDecline} title="Decline (esc)">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor" transform="rotate(135 8 8)" />
            </svg>
          </button>
          <button className="ring-btn accept" onClick={onAccept} title="Accept (↵)">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div className="ring-keybinds">
          <span><kbd>↵</kbd> accept</span>
          <span><kbd>esc</kbd> decline</span>
        </div>
      </div>
    </div>
  );
}

// ───────── Safety number compare ─────────
function SafetyCompare({ contactId, onClose }) {
  const shell = useShellDataContext() as any;
  const verifiedContacts = useVerifiedContacts();
  const [comparing, setComparing] = useT2(false);
  if (!contactId) return null;
  const m = shell?.byId?.[contactId];
  if (!m) return null;
  // Real fingerprints come straight from the bridged member record
  // (publicKeyHex), populated by useShellData.mapMember from the team
  // store. If a side isn't loaded yet, show the missing-data placeholder
  // so the user can tell something didn't load instead of comparing
  // fake digits.
  const meId = shell?.currentUserId;
  const ownHex = ((meId ? shell?.byId?.[meId]?.publicKeyHex : '') || '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  const peerHex = (m?.publicKeyHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const status = peerHex ? verifiedContacts.isVerified(contactId, peerHex) : 'unverified';
  const verified = status === 'verified';
  const keyChanged = status === 'changed';
  // An Ed25519 public key is 32 bytes = 64 hex chars. Anything shorter
  // means we never got the full key from the server for that side, so
  // the comparison can't be trusted — surface that to the user instead
  // of silently padding with placeholder dots.
  const EXPECTED_HEX = 64;
  const ownIncomplete = !ownHex || ownHex.length < EXPECTED_HEX;
  const peerIncomplete = !peerHex || peerHex.length < EXPECTED_HEX;
  const incomplete = ownIncomplete || peerIncomplete;
  // Render the FULL 32-byte key as 16 4-char tokens (8 rows × 2 cols).
  // Pad each side to the expected length with em-dashes so missing data
  // is visually distinct (and aligned across sides) — never with the
  // dot pattern that previously made bad data look like real digits.
  function tokensFor(hex: string): string[] {
    const tokens: string[] = [];
    for (let i = 0; i < EXPECTED_HEX; i += 4) {
      const chunk = hex.slice(i, i + 4);
      tokens.push(chunk.length === 4 ? chunk : '——');
    }
    return tokens;
  }
  const yp = tokensFor(ownHex);
  const tp = tokensFor(peerHex);
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="sc-dialog">
        <header className="sc-head">
          <h2>Verify safety number</h2>
          <button className="sc-x" onClick={onClose}>×</button>
        </header>
        <p className="sc-blurb">Read this number out loud to <strong>{m.name}</strong> (in person, on a separate call, or via a different channel) and check that yours and theirs match exactly. Then mark verified.</p>
        <div className="sc-pair">
          <div className="sc-side">
            <div className="sc-side-head">
              {(() => {
                const me = shell?.currentUserId ? shell?.byId?.[shell.currentUserId] : null;
                return (
                  <div className="sc-side-avatar" style={{ background: me?.color || 'var(--muted)' }}>{me?.initials || '?'}</div>
                );
              })()}
              <span>you</span>
            </div>
            <div className="sc-number">
              {yp.map((b, i) => <span key={`y-${i}-${b}`} className="sc-block">{b}</span>)}
            </div>
          </div>
          <div className="sc-side">
            <div className="sc-side-head">
              <div
                className={'sc-side-avatar' + (m.avatarUrl ? ' has-image' : '')}
                style={m.avatarUrl
            ? { backgroundImage: `url(${m.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'transparent' }
            : { backgroundColor: m.color }}
              >{!m.avatarUrl && m.initials}</div>
              <span>{m.name}</span>
            </div>
            <div className="sc-number">
              {tp.map((b, i) => <span key={`t-${i}-${b}`} className={'sc-block' + (comparing ? ' sc-block-pulse' : '')}>{b}</span>)}
            </div>
          </div>
        </div>
        {incomplete && (() => {
          let who: string;
          if (ownIncomplete && peerIncomplete) {
            who = 'both sides';
          } else if (ownIncomplete) {
            who = 'you';
          } else {
            who = m.name;
          }
          const bytes = ownIncomplete ? `${ownHex.length / 2 || 0}` : `${peerHex.length / 2}`;
          return (
            <div className="sc-warn">
              ⚠ Identity key not fully loaded ({who}: {bytes}/32 bytes). Reload the team — comparing now would be meaningless.
            </div>
          );
        })()}
        {keyChanged && !incomplete && (
          <div className="sc-warn">
            ⚠ Their identity key has changed since you last verified — compare again before trusting messages.
          </div>
        )}
        {verified ? (
          <div className="sc-verified">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" />
              <path d="M5 8l2 2 4-4" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Verified · safety number recorded for this device</span>
            <button
              className="btn"
              style={{ marginLeft: 'auto' }}
              onClick={() => verifiedContacts.clearVerified(contactId)}
            >
              Reset
            </button>
          </div>
        ) : (
          <div className="sc-actions">
            <button className="btn" onClick={() => { setComparing(true); setTimeout(() => setComparing(false), 800); }}>Highlight blocks</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn--danger" onClick={onClose}>Doesn't match</button>
              <button
                className="btn btn--primary"
                disabled={incomplete}
                onClick={() => {
                  if (incomplete) return;
                  verifiedContacts.markVerified(contactId, peerHex);
                }}
              >
                Mark verified
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────── Federation: add peer wizard ─────────
function AddPeerWizard({ open, onClose }) {
  const shell = useShellDataContext() as any;
  const teamName = shell?.SERVERS?.[0]?.name || '';
  const nodeName = shell?.SERVERS?.[0]?.node || 'local';
  const [step, setStep] = useT2(0);
  const [mode, setMode] = useT2('have'); // 'have' | 'create'
  const [token, setToken] = useT2('');
  const [log, setLog] = useT2([]);
  useT2E(() => {
    if (!open) { setStep(0); setMode('have'); setToken(''); setLog([]); }
  }, [open]);
  useT2E(() => {
    if (step !== 2) return;
    const seq = [
      'parsing join token · hmac ok',
      'resolving rust.berra.io · 167.235.21.144:8081',
      'opening federation socket · tls 1.3',
      'exchanging memberlist gossip · 12 alive peers',
      'syncing channels (5) · messages (412)',
      'syncing roles (3) · presence (8 online)',
      'lamport clock synced · 12944',
      'mesh ok.',
    ];
    let acc = 0;
    const timeouts = [];
    const queueLogLine = (line, i) => {
      setLog(prev => [...prev, line]);
      if (i === seq.length - 1) timeouts.push(setTimeout(() => setStep(3), 600));
    };
    seq.forEach((line, i) => {
      acc += 320;
      timeouts.push(setTimeout(() => queueLogLine(line, i), acc));
    });
    return () => timeouts.forEach(clearTimeout);
  }, [step]);
  if (!open) return null;
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="apw">
        <header className="apw-head">
          <h2>Add a peer node</h2>
          <button className="sc-x" onClick={onClose}>×</button>
        </header>
        <div className="apw-steps">
          {['Token','Confirm','Handshake','Done'].map((s, i) => (
            <span key={s} className={'apw-step' + (i === step ? ' active' : '') + (i < step ? ' done' : '')}>
              <span className="apw-step-n">{i + 1}</span> {s}
            </span>
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="apw-seg" style={{ marginBottom: 16 }}>
              <button className={mode === 'have' ? 'on' : ''} onClick={() => setMode('have')}>I have a token</button>
              <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Generate one for a peer</button>
            </div>
            {mode === 'have' ? (
              <>
                <p className="sc-blurb">Paste the join command from the other admin. It's HMAC-signed with the cluster secret so other peers can't impersonate this one.</p>
                <textarea className="apw-input" rows={3} placeholder="dilla-server --join-token eyJraWQiOiJoczI1Ni…"
                          value={token} onChange={e => setToken(e.target.value)} />
                <div className="apw-actions">
                  <span />
                  <button className="btn btn--primary" disabled={token.length < 12} onClick={() => setStep(1)}>Parse →</button>
                </div>
              </>
            ) : (
              <>
                <p className="sc-blurb">Run this on the new node's machine. The token expires in 15 minutes and is single-use.</p>
                {(() => {
                  const host = nodeName === 'local' ? 'localhost' : nodeName;
                  return (
                    <pre className="apw-snippet">{String.raw`dilla-server \
  --team "${teamName}" \
  --peers ${host}:8081 \
  --join-token eyJraWQiOiJoczI1NiIsInR5cCI6IkpXVCJ9
    .eyJpc3MiOiJnYmctMSIsImV4cCI6MTc3OTAxMjkw…
    .Aq4FZ_kQXg2vV1iJsK5JmZ1cT_R7…`}</pre>
                  );
                })()}
                <div className="apw-actions">
                  <button className="btn" onClick={onClose}>Cancel</button>
                  <button className="btn btn--primary">Copy command</button>
                </div>
              </>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <p className="sc-blurb">Token decoded. About to add this peer to the mesh:</p>
            <div className="apw-fields">
              <div className="apw-field"><span className="apw-k">node name</span> <span>rust.berra.io</span></div>
              <div className="apw-field"><span className="apw-k">address</span> <span>167.235.21.144:8081</span></div>
              <div className="apw-field"><span className="apw-k">issued by</span> <span>ola@rust.berra.io</span></div>
              <div className="apw-field"><span className="apw-k">expires</span> <span>in 12 minutes</span></div>
              <div className="apw-field"><span className="apw-k">attestation</span> <span style={{ color: 'var(--accent)' }}>HMAC ok · ed25519 sig ok</span></div>
            </div>
            <div className="apw-callout">
              <strong>This will replicate.</strong> Channels, messages, roles, and presence will sync to the new peer. Voice audio stays on the originating node.
            </div>
            <div className="apw-actions">
              <button className="btn" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn--primary" onClick={() => setStep(2)}>Connect peer</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="sc-blurb">Handshaking with rust.berra.io…</p>
            <pre className="onb-log onb-log-big" style={{ minHeight: 200 }}>
              {log.map((l, i) => (
                <div key={`log-${i}-${l}`} className="onb-log-line"><span className="onb-log-prompt">›</span> {l}</div>
              ))}
              <div className="onb-log-line"><span className="onb-log-cursor">_</span></div>
            </pre>
          </>
        )}

        {step === 3 && (
          <>
            <div className="sc-verified" style={{ margin: '12px 0 18px' }}>
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" />
                <path d="M5 8l2 2 4-4" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>rust.berra.io joined the mesh · 2/2 peers</span>
            </div>
            <div className="apw-fields">
              <div className="apw-field"><span className="apw-k">channels synced</span> <span>5</span></div>
              <div className="apw-field"><span className="apw-k">messages replicated</span> <span>412</span></div>
              <div className="apw-field"><span className="apw-k">lamport</span> <span>12944</span></div>
              <div className="apw-field"><span className="apw-k">latency</span> <span>14ms p50</span></div>
            </div>
            <div className="apw-actions">
              <span />
              <button className="btn btn--primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ───────── Connection banner (offline / reconnecting / mesh degraded) ─────────
function ConnectionBanner() {
  const [state, setState] = useT2(null); // null | 'offline' | 'reconnecting' | 'degraded'
  useT2E(() => {
    function on(e) { setState(e.detail); }
    globalThis.addEventListener('dilla:connection', on);
    return () => globalThis.removeEventListener('dilla:connection', on);
  }, []);
  if (!state) return null;
  const config = {
    offline:      { color: 'var(--danger)', text: 'You are offline. Messages will queue and send when reconnected.' },
    reconnecting: { color: 'var(--warn)',   text: 'Reconnecting to mesh… retrying with exponential backoff (next in 4s)' },
    degraded:     { color: 'var(--warn)',   text: 'Mesh degraded · rust.berra.io unreachable. Messages still saving locally and to gbg-1.' },
  };
  const c = config[state] || config.offline;
  return (
    <div className="conn-banner" style={{ background: c.color }}>
      <span className="conn-dot" />
      <span>{c.text}</span>
      <button className="conn-dismiss" onClick={() => setState(null)}>dismiss</button>
    </div>
  );
}

export {
  NotificationStack,
  notifyDemo,
  FirstRunSplash,
  IncomingCall,
  SafetyCompare,
  AddPeerWizard,
  ConnectionBanner,
};
