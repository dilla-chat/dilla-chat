// @ts-nocheck
// Dilla chat refinement — main React app, ported verbatim from
// design_handoff_dilla_mesh/chat-app.jsx. Strict TS types come later — for
// now we just want this rendering inside Vite at /mesh.

import React from 'react';
import { Icon } from './icons';
import MessageMarkdown from '../components/MessageMarkdown/MessageMarkdown';
import { MOCK_DATA } from './data';
import { THEMES } from './themes';
import { useShellDataContext } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useDMStore } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useVoiceConnection } from '../hooks/useVoiceConnection';
import { ws } from '../services/websocket';
import { usePollStore, normalizePoll } from '../stores/pollStore';
import { useChannelMuteStore } from '../stores/channelMuteStore';
import { usePinStore } from '../stores/pinStore';
import { useBlockStore } from '../stores/blockStore';
import { dillaConfirm } from '../stores/confirmStore';
import { resolvePermissions, PERM_MANAGE_CHANNELS, PERM_MANAGE_MEMBERS, PERM_MANAGE_MESSAGES, PERM_CREATE_INVITES, PERM_MANAGE_TEAM } from '../hooks/usePermissions';
import { api } from '../services/api';
import { tryEncrypt } from '../hooks/useMessageDecryption';
import { useChannelLazyLoad } from '../hooks/useChannelLazyLoad';
import { isMockSession } from '../services/mockSession';

const { useState, useEffect, useLayoutEffect, useRef, useMemo } = React;
// chat-app.jsx originally read window.SHELL_DATA / window.THEMES / window.Icon
// — keep that contract until the bindings get rewired through Zustand.
const w = window as unknown as Record<string, unknown>;
w.SHELL_DATA = MOCK_DATA;
w.THEMES = THEMES;
w.Icon = Icon;

// Helper: current user id. This is the ONE remaining `window.SHELL_DATA`
// reader in the file — it's called from non-React utility helpers (eg.
// renderText, sharingId calc, mention/peer matching) where threading a
// React hook through every call site would be invasive. AppShell writes
// `window.SHELL_DATA = useShellData()` on every render so the value is
// always in sync. NO `'thim'` fallback — falling through to a hardcoded
// mock id was the cause of every "thim is admin" / "messages marked as
// mine when they aren't" bug on /app. An empty string means "no user
// known", and downstream code treats that as "no match".
function currentUserId(): string {
  return (window as any).SHELL_DATA?.currentUserId || '';
}

// Stable empty array reference for zustand selectors that may fall back
// to "no entries" — using a fresh `[]` from the selector triggers a new
// reference on every render and creates a feedback loop with the
// component's own state updates.
const EMPTY_LIST: any[] = [];

// ───────────── helpers ─────────────
// Convert a server-side poll payload to the local kind:'poll' message
// shape that the timeline renderer expects. Uses the poll's id as the
// message id so vote updates can find and patch it in place.
function pollServerToMessage(p: any, me: string) {
  const labels: string[] = p.options || [];
  const tallies: number[] = p.tallies || [];
  const voters: string[][] = p.voters || [];
  return {
    id: p.id,
    kind: 'poll',
    author: p.created_by || '',
    at: p.created_at ? new Date(p.created_at) : new Date(),
    question: p.question,
    options: labels.map((label, i) => ({
      label,
      votes: tallies[i] || 0,
      mine: (voters[i] || []).includes(me),
    })),
  };
}

function timeShort(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function groupMessages(msgs) {
  // Group consecutive messages by the same author within ~5min into stacks.
  const out = [];
  let last = null;
  msgs.forEach(m => {
    if (last && last.author === m.author && m.kind === 'text' && last.kind === 'text'
        && (m.at - last.at) < 5 * 60e3) {
      last.children.push(m);
    } else {
      const group = { author: m.author, at: m.at, kind: m.kind, base: m, children: [m] };
      out.push(group);
      last = group;
    }
  });
  return out;
}

// ───────────── small bits ─────────────
// Single source of truth for rendering an avatar tile (image OR initials).
// Used by Avatar/PlainAvatar below AND by the half-dozen custom avatar
// sites (mention picker, voice peer, new-DM picker, etc.) so a profile
// picture set in User Settings shows up everywhere immediately.
//
// Uses backgroundColor (longhand) NOT background (shorthand) — the
// shorthand resets background-size to `auto` inline, which beats the
// .has-image { background-size: cover } CSS rule on specificity and
// the image ended up cropped to its top-left corner.
export function memberAvatarStyle(member: { color?: string; avatarUrl?: string }, size?: number): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (size) {
    style.width = size;
    style.height = size;
    style.fontSize = size * 0.4;
  }
  if (member.avatarUrl) {
    style.backgroundImage = `url(${member.avatarUrl})`;
    style.backgroundSize = 'cover';
    style.backgroundPosition = 'center';
    style.backgroundRepeat = 'no-repeat';
    style.color = 'transparent';
  } else {
    style.backgroundColor = member.color || 'var(--muted)';
  }
  return style;
}
export function memberAvatarClass(member: { avatarUrl?: string }, base: string): string {
  return member.avatarUrl ? base + ' has-image' : base;
}

function Avatar({ member, size }) {
  // Render the uploaded image when present; otherwise the username-coloured
  // initials tile. Either way the presence dot lives on top.
  return (
    <div className={memberAvatarClass(member, 'avatar')} style={memberAvatarStyle(member, size)}>
      {!member.avatarUrl && member.initials}
      {member.status && <span className={`presence ${member.status}`}></span>}
    </div>
  );
}

function PlainAvatar({ member, size }) {
  return (
    <div className={memberAvatarClass(member, 'avatar')} style={memberAvatarStyle(member, size)}>
      {!member.avatarUrl && member.initials}
    </div>
  );
}

function MiniMeter() {
  // tiny 4-bar audio meter that updates on a timer
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(x => x + 1), 140);
    return () => clearInterval(id);
  }, []);
  function v(i) { return 0.3 + Math.abs(Math.sin(t * 0.7 + i * 1.3)) * 0.7; }
  return (
    <span className="mini-meter">
      {[0,1,2,3].map(i => (
        <span key={i} className="mm-bar" style={{ height: 3 + Math.round(v(i) * 6) }} />
      ))}
    </span>
  );
}

// Modal: forward a message to another channel or DM
function ForwardModal({ sourceMsg, members, onClose, onForward }) {
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const [q, setQ] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const targets = [
    ...data.CHANNELS.filter(c => c.type === 'text').map(c => ({ id: c.id, label: '#' + c.name, sub: c.topic || '', kind: 'channel' })),
    ...data.DMS.map(d => {
      const m = d.group ? null : data.byId[d.with];
      return { id: d.id, label: d.group ? d.name : (m?.name || 'Unknown'), sub: d.group ? 'group' : (m?.custom || 'direct message'), kind: 'dm', color: m?.color };
    }),
  ].filter(t => !q || (t.label || '').toLowerCase().includes(q.toLowerCase()));
  const author = data.byId[sourceMsg.author] || { name: sourceMsg.author };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ width: 'min(540px, 100%)' }}>
        <header className="modal-head">
          <h2>Forward message</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="fwd-preview">
            <div className="fwd-author">{author.name}</div>
            <div className="fwd-text">{(sourceMsg.text || '').slice(0, 140)}{(sourceMsg.text||'').length > 140 ? '…' : ''}</div>
          </div>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                 placeholder="search kanals & DMs…"
                 style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--hairline-2)', borderRadius: 'var(--r-sm)', color: 'var(--fg)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }} />
          <div className="ndm-list">
            {targets.map(t => (
              <button key={t.id} className="ndm-row" onClick={() => onForward(t.id)}>
                <div className="ndm-av" style={{ background: t.color || 'var(--accent-soft)', color: t.color ? '#111' : 'var(--accent)' }}>
                  {t.kind === 'channel' ? '#' : (t.label || '?').slice(0,2).toUpperCase()}
                </div>
                <div>
                  <div className="ndm-name">{t.label}</div>
                  <div className="ndm-sub">{t.sub}</div>
                </div>
              </button>
            ))}
            {targets.length === 0 && <div className="pin-empty">no kanals or DMs match.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Modal: pick a member to start a new DM with
function NewDmModal({ members, onClose, onPick }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const list = (members.MEMBERS || []).filter(m => m.id !== currentUserId() && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ width: 'min(480px, 100%)' }}>
        <header className="modal-head">
          <h2>New direct message</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                 placeholder="filter by name…"
                 style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--hairline-2)', borderRadius: 'var(--r-sm)', color: 'var(--fg)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }} />
          <div className="ndm-list">
            {list.map(m => (
              <button key={m.id} className="ndm-row" onClick={() => onPick(m.id)}>
                <div className={memberAvatarClass(m, 'ndm-av')} style={memberAvatarStyle(m)}>{!m.avatarUrl && m.initials}<span className={'presence ' + m.status}></span></div>
                <div>
                  <div className="ndm-name">{m.name}</div>
                  <div className="ndm-sub">{m.custom || m.status}</div>
                </div>
              </button>
            ))}
            {list.length === 0 && <div className="pin-empty">no members match.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Combobox/chip input for selecting (or creating) a channel group.
// When `value` is set it renders as a removable pill at the start of the
// field; when empty an input takes over and a popover lists existing
// groups filtered by the typed query. Enter on a unique match commits;
// Enter on a fresh query creates a new group; backspace on an empty
// input clears the pill so keyboard-only users don't get stuck.
function GroupCombobox({ value, onChange, existing }: {
  value: string;
  onChange: (next: string) => void;
  existing: string[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!value) setDraft(''); }, [value]);

  const q = draft.trim().toLowerCase();
  const matches = q ? existing.filter((g) => g.toLowerCase().includes(q)) : existing;
  const exact = existing.find((g) => g.toLowerCase() === q);
  const canCreate = q.length > 0 && !exact;

  function commit(next: string) {
    const trimmed = next.trim();
    onChange(trimmed);
    setDraft('');
    setOpen(false);
  }

  return (
    <div className="grp-combo">
      {value ? (
        <span className="grp-pill">
          {value}
          <button type="button" className="grp-pill-x" onClick={() => { commit(''); setTimeout(() => inputRef.current?.focus(), 0); }} aria-label="Clear group">×</button>
        </span>
      ) : (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (matches.length === 1) commit(matches[0]);
              else if (canCreate) commit(draft);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder="pick or create a group…"
        />
      )}
      {open && !value && (matches.length > 0 || canCreate) && (
        <div className="grp-pop">
          {matches.map((g) => (
            <div key={g} className="grp-opt" onMouseDown={(e) => { e.preventDefault(); commit(g); }}>
              <span className="grp-pill grp-pill-static">{g}</span>
            </div>
          ))}
          {canCreate && (
            <div className="grp-opt grp-opt-new" onMouseDown={(e) => { e.preventDefault(); commit(draft); }}>
              <span className="grp-opt-new-label">+ Create</span>
              <span className="grp-pill grp-pill-static">{draft.trim()}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Modal: create a new kanal (channel)
// Picker for /giphy results. Opens after the user runs /giphy <query>
// and the server returns N candidates; clicking a tile dispatches
// dilla:giphy-pick which TextChannel routes through its sendRawText
// (same code path as a normal text message). Esc / overlay click /
// Cancel button all close without posting.
function GiphyPicker({
  query,
  results,
  onPick,
  onClose,
}: Readonly<{ query: string; results: Array<{ url: string; preview: string }>; onPick: (url: string) => void; onClose: () => void }>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card giphy-picker" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>/giphy · {query}</h2>
          <button className="modal-x" onClick={onClose} aria-label="Cancel">×</button>
        </header>
        <div className="modal-body">
          <div className="giphy-grid">
            {results.map((r, i) => (
              <button
                key={r.url}
                type="button"
                className="giphy-tile"
                onClick={() => onPick(r.url)}
                title={'Send this gif (' + (i + 1) + ' of ' + results.length + ')'}
              >
                <img src={r.preview} alt="" loading="lazy" />
              </button>
            ))}
          </div>
          <p className="modal-hint">Pick a gif to send to #{'<active channel>'}. Esc cancels.</p>
        </div>
      </div>
    </div>
  );
}

function NewChannelModal({ onClose, onCreate }) {
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const nodeHost = data?.SERVERS?.[0]?.node || 'local';
  const [name, setName] = useState('');
  const [kind, setKind] = useState('text');
  const [priv, setPriv] = useState(false);
  const [topic, setTopic] = useState('');
  const [group, setGroup] = useState('');
  // Distinct categories already in use for this team, surfaced as
  // autocomplete suggestions so users don't fragment their own naming.
  const existingGroups = useMemo(() => {
    const seen = new Set<string>();
    for (const c of (data?.CHANNELS ?? []) as Array<{ category?: string }>) {
      const g = (c.category ?? '').trim();
      if (g) seen.add(g);
    }
    return [...seen];
  }, [data]);
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const ok = slug.length >= 2;
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>New kanal</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>Type</label>
            <div className="onb-seg">
              <button className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}><Icon.Hash size={11} /> Text</button>
              <button className={kind === 'voice' ? 'on' : ''} onClick={() => setKind('voice')}><Icon.Speaker size={11} /> Voice</button>
            </div>
          </div>
          <div className="modal-row">
            <label>Name</label>
            <div className="modal-input-pre">
              <span className="pre-glyph">{kind === 'voice' ? '🔊' : '#'}</span>
              <input value={name} autoFocus
                     onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9 -]/g, ''))}
                     placeholder="ship-talk" />
            </div>
            {slug && <div className="modal-hint">URL: <code>dilla://{nodeHost}/k/{slug}</code></div>}
          </div>
          <div className="modal-row">
            <label>Topic <span className="modal-opt">optional</span></label>
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="what's this kanal for?" />
          </div>
          <div className="modal-row">
            <label>Group <span className="modal-opt">optional</span></label>
            <GroupCombobox value={group} onChange={setGroup} existing={existingGroups} />
            <div className="modal-hint">Groups collapse together in the sidebar. Leave blank for the default list.</div>
          </div>
          <div className="modal-row modal-row-h">
            <div>
              <label>Private kanal</label>
              <div className="modal-hint">{priv ? 'only invited members can see this.' : 'anyone on the team can join.'}</div>
            </div>
            <button className="set-toggle" data-on={priv ? '1' : '0'} onClick={() => setPriv(p => !p)}><i /></button>
          </div>
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={!ok} onClick={() => onCreate({ id: slug, name: slug, kind, topic, category: group.trim(), private: priv })}>Create kanal</button>
        </footer>
      </div>
    </div>
  );
}

// Modal: edit an existing channel's topic + slow mode (admin/maintainer).
// Patches the live record via api.updateChannel; useTeamSync's broadcast
// echoes back to the store so other clients pick up the change.
function ChannelAccessModal({ channel, onClose }) {
  const teamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const roles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? [] : []));
  const [selected, setSelected] = useState<Set<string>>(new Set(channel?.accessRoleIds ?? []));
  const [hidden, setHidden] = useState<boolean>(!!channel?.hidden_if_restricted || !!channel?.hiddenIfRestricted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
      return next;
    });
  }

  async function save() {
    setErr('');
    if (!teamId || !channel?.id) { onClose(); return; }
    if (isMockSession()) { onClose(); return; }
    setBusy(true);
    const newRoleIds = Array.from(selected);
    try {
      await api.setChannelAccess(teamId, channel.id, newRoleIds);
      await api.updateChannel(teamId, channel.id, { hidden_if_restricted: hidden });
      // Optimistic local update — patch the channel in the teamStore so
      // the sidebar reflects the new gate even if the WS echo races the
      // close (or the user is the only listener on a mesh of one).
      const store = useTeamStore.getState();
      const list = store.channels.get(teamId) ?? [];
      const idx = list.findIndex((c) => c.id === channel.id);
      if (idx >= 0) {
        const next = list.map((c, i) => i === idx ? { ...c, accessRoleIds: newRoleIds, locked: hidden } : c);
        store.setChannels(teamId, next);
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Failed — manage-channels permission required.');
    } finally {
      setBusy(false);
    }
  }

  // Sort: default ("everyone") first, then descending position.
  const ordered = [...roles].sort((a: any, b: any) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (b.position ?? 0) - (a.position ?? 0);
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>#{channel?.name} access</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>Roles that can access this channel</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {ordered.map((r: any) => (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color || 'var(--fg-3)' }} />
                  <span>{r.name}</span>
                  {r.isDefault && <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', border: '1px solid var(--hairline)', padding: '1px 5px', borderRadius: 3 }}>default · everyone</span>}
                </label>
              ))}
            </div>
            <div className="modal-hint">Include the default role to keep the channel open. Remove it to restrict.</div>
          </div>
          <div className="modal-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
              <span>Hide from members who can't access</span>
            </label>
            <div className="modal-hint">When on, restricted members won't see this channel at all instead of a padlock.</div>
          </div>
          {err && <div className="modal-hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

// Group-level access modal. Same role-checkbox pattern as ChannelAccessModal,
// but persists via api.setGroupAccess and the WS broadcasts a
// group:access-update event that every channel in the group reads through
// its inherited resolveAccessRoles — one change ripples to N channels.
function GroupAccessModal({ group, onClose }: { group: { id: string; name: string; accessRoleIds: string[]; hiddenIfRestricted: boolean }; onClose: () => void }) {
  const teamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const roles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? [] : []));
  const [selected, setSelected] = useState<Set<string>>(new Set(group.accessRoleIds ?? []));
  const [hidden, setHidden] = useState<boolean>(!!group.hiddenIfRestricted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
      return next;
    });
  }

  async function save() {
    setErr('');
    if (!teamId) { onClose(); return; }
    if (isMockSession()) {
      // /mesh: skip the API and patch the store directly so the demo
      // shows the change. The real path below does both.
      const next = Array.from(selected);
      useTeamStore.getState().upsertGroup(teamId, { ...group, accessRoleIds: next, hiddenIfRestricted: hidden });
      onClose();
      return;
    }
    setBusy(true);
    const next = Array.from(selected);
    try {
      // setGroupAccess now accepts hidden_if_restricted in the same body
      // so the access list + visibility flag move together. The server
      // echoes both in group:access-update; our optimistic patch keeps
      // the sidebar in sync if the modal closes before the broadcast.
      await api.setGroupAccess(teamId, group.id, next, hidden);
      useTeamStore.getState().upsertGroup(teamId, { ...group, accessRoleIds: next, hiddenIfRestricted: hidden });
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Failed — manage-channels permission required.');
    } finally {
      setBusy(false);
    }
  }

  const ordered = [...roles].sort((a: any, b: any) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (b.position ?? 0) - (a.position ?? 0);
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{group.name} · access</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>Roles that can see channels in this group</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {ordered.map((r: any) => (
                <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.color || 'var(--fg-3)' }} />
                  <span>{r.name}</span>
                  {r.isDefault && <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', border: '1px solid var(--hairline)', padding: '1px 5px', borderRadius: 3 }}>default · everyone</span>}
                </label>
              ))}
            </div>
            <div className="modal-hint">Every channel in <strong>{group.name}</strong> inherits this list. Include the default role to keep them open; remove it to restrict.</div>
          </div>
          <div className="modal-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
              <span>Hide group from members who can't access</span>
            </label>
            <div className="modal-hint">When on, restricted members won't see <strong>{group.name}</strong> at all — every channel inside disappears with it, instead of showing a padlock.</div>
          </div>
          {err && <div className="modal-hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

// Rename + delete a group. Lives next to GroupAccessModal so the right-
// click context menu can hand off cleanly.
function GroupSettingsModal({ group, onClose }: { group: { id: string; name: string }; onClose: () => void }) {
  const teamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setErr('');
    if (!teamId) { onClose(); return; }
    const trimmed = name.trim();
    if (!trimmed) { setErr('Name cannot be empty.'); return; }
    if (trimmed === group.name) { onClose(); return; }
    setBusy(true);
    try {
      if (!isMockSession()) {
        await api.updateGroup(teamId, group.id, { name: trimmed });
      }
      const existing = (useTeamStore.getState().groups.get(teamId) ?? []).find((g) => g.id === group.id);
      if (existing) useTeamStore.getState().upsertGroup(teamId, { ...existing, name: trimmed });
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Rename failed — manage-channels required, or that name is taken.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setErr('');
    if (!teamId) { onClose(); return; }
    setBusy(true);
    try {
      if (!isMockSession()) await api.deleteGroup(teamId, group.id);
      // Clear group_id on every channel that pointed at this group, then
      // remove the group itself. Mirrors the server's ON DELETE SET NULL.
      const ts = useTeamStore.getState();
      const list = ts.channels.get(teamId) ?? [];
      const next = list.map((c) => (c.groupId === group.id ? { ...c, groupId: null } : c));
      ts.setChannels(teamId, next);
      ts.removeGroup(teamId, group.id);
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Delete failed — manage-channels permission required.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{group.name} · settings</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>Group name</label>
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            <div className="modal-hint">Channels stay in the group — only the header label changes.</div>
          </div>
          {confirmDelete ? (
            <div className="modal-row" style={{ border: '1px solid var(--danger)', padding: '0.75rem', borderRadius: 'var(--r-sm)' }}>
              <label style={{ color: 'var(--danger)' }}>Delete group</label>
              <div className="modal-hint">Channels in <strong>{group.name}</strong> won't be deleted — they'll just lose the group. Restricted-by-group channels will become open.</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="sc-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="sc-btn danger" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete group'}</button>
              </div>
            </div>
          ) : (
            <div className="modal-row">
              <button className="sc-btn danger" onClick={() => setConfirmDelete(true)}>Delete group…</button>
            </div>
          )}
          {err && <div className="modal-hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

function ChannelSettingsModal({ channel, onClose }) {
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [slow, setSlow] = useState(String(channel?.slowModeSeconds ?? channel?.slow_mode_seconds ?? 0));
  const [group, setGroup] = useState(channel?.category ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const existingGroups = useMemo(() => {
    const seen = new Set<string>();
    for (const c of (data?.CHANNELS ?? []) as Array<{ category?: string }>) {
      const g = (c.category ?? '').trim();
      if (g) seen.add(g);
    }
    return [...seen];
  }, [data]);
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function save() {
    setErr('');
    const teamId = useTeamStore.getState().activeTeamId;
    if (!teamId || !channel?.id) { onClose(); return; }
    if (isMockSession()) { onClose(); return; }
    setBusy(true);
    try {
      const slowN = Number.parseInt(slow, 10);
      const updates: Record<string, unknown> = { topic, category: group.trim() };
      if (!Number.isNaN(slowN) && slowN >= 0) updates.slow_mode_seconds = slowN;
      await api.updateChannel(teamId, channel.id, updates);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setErr('');
    const teamId = useTeamStore.getState().activeTeamId;
    if (!teamId || !channel?.id) { onClose(); return; }
    setBusy(true);
    try {
      if (!isMockSession()) await api.deleteChannel(teamId, channel.id);
      // Local removal mirrors the server cascade. The team-wide
      // channel:deleted broadcast (if/when added) would do the same,
      // but patching here means the sidebar advances even on /mesh.
      const ts = useTeamStore.getState();
      ts.removeChannel(teamId, channel.id);
      // If the user was sitting on the deleted channel, send them
      // somewhere safe — first remaining channel, otherwise nowhere.
      if (ts.activeChannelId === channel.id) {
        const list = ts.channels.get(teamId) ?? [];
        ts.setActiveChannel(list[0]?.id ?? '');
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message || 'Delete failed — manage-channels permission required.');
      setBusy(false);
    }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>#{channel?.name} settings</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>Topic</label>
            <input value={topic} autoFocus onChange={e => setTopic(e.target.value)} placeholder="what's this kanal for?" />
            <div className="modal-hint">Shown at the top of the channel. Anyone with permission to send can see this.</div>
          </div>
          <div className="modal-row">
            <label>Group <span className="modal-opt">optional</span></label>
            <GroupCombobox value={group} onChange={setGroup} existing={existingGroups} />
            <div className="modal-hint">Channels in the same group collapse together in the sidebar. Leave blank for the default list.</div>
          </div>
          <div className="modal-row">
            <label>Slow mode (seconds)</label>
            <input value={slow} onChange={e => setSlow(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" />
            <div className="modal-hint">Minimum interval between messages per member. 0 disables.</div>
          </div>
          {confirmDelete ? (
            <div className="modal-row" style={{ border: '1px solid var(--danger)', padding: '0.75rem', borderRadius: 'var(--r-sm)' }}>
              <label style={{ color: 'var(--danger)' }}>Delete kanal</label>
              <div className="modal-hint">Permanently removes <strong>#{channel?.name}</strong> and every message in it. This can't be undone.</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="sc-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="sc-btn danger" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete kanal'}</button>
              </div>
            </div>
          ) : (
            <div className="modal-row">
              <button className="sc-btn danger" onClick={() => setConfirmDelete(true)}>Delete kanal…</button>
            </div>
          )}
          {err && <div className="modal-hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

// Modal: create-or-join team
function NewServerModal({ onClose, onCreate }) {
  const [mode, setMode] = useState('create'); // create | join
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const ok = mode === 'create' ? slug.length >= 2 : token.length >= 12;
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Add a team</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="onb-seg" style={{ marginBottom: 18 }}>
            <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Create a new team</button>
            <button className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>Join with an invite</button>
          </div>
          {mode === 'create' ? (
            <>
              <div className="modal-row">
                <label>Team name</label>
                <input value={name} autoFocus
                       onChange={e => setName(e.target.value)}
                       placeholder="Team name" />
                <div className="modal-hint">A team is hosted on a node you run. You'll be the admin.</div>
              </div>
              <div className="modal-row">
                <label>Server URL <span className="modal-opt">optional</span></label>
                <input defaultValue="http://localhost:8080" />
                <div className="modal-hint">Where your <code>dilla-server</code> binary is running.</div>
              </div>
            </>
          ) : (
            <>
              <div className="modal-row">
                <label>Invite link or token</label>
                <textarea rows={3} value={token} onChange={e => setToken(e.target.value)}
                          placeholder="dilla.gbg/invite/4F7A · or paste a full URL"></textarea>
                <div className="modal-hint">Single-use or capped invites. The server validates this before binding your identity.</div>
              </div>
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={!ok} onClick={() => onCreate({
            id: mode === 'create' ? slug : 'joined-' + Date.now(),
            name: mode === 'create' ? name : 'New team',
            short: (mode === 'create' ? name : 'NT').slice(0, 1).toUpperCase() || 'N',
            node: mode === 'create' ? 'your-node.local' : 'peer.remote',
            kind: mode,
            token: mode === 'join' ? token.trim() : undefined,
            federated: false,
            members: 1,
          })}>
            {mode === 'create' ? 'Create team' : 'Join team'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// Empty state shown when a channel or DM has no messages yet.
function EmptyFeed({ channel, dmPartner }) {
  if (channel.type === 'dm' && dmPartner) {
    return (
      <div className="empty-feed">
        <div className="ef-avatar" style={{ background: dmPartner.color }}>
          {dmPartner.initials}
          <span className={'presence ' + dmPartner.status}></span>
        </div>
        <h2 className="ef-title">{dmPartner.name}</h2>
        <div className="ef-sub">This is your first private conversation with {dmPartner.name}.</div>
        <div className="ef-pills">
          <span className="ef-pill"><Icon.Shield size={11} /> Signal · X3DH</span>
          <span className="ef-pill">double-ratchet</span>
          <span className="ef-pill">server sees ciphertext only</span>
        </div>
      </div>
    );
  }
  if (channel.type === 'dm' && channel.group) {
    return (
      <div className="empty-feed">
        <div className="ef-glyph"><Icon.People size={28} /></div>
        <h2 className="ef-title">{channel.name}</h2>
        <div className="ef-sub">Group conversation, end-to-end encrypted via sender keys.</div>
      </div>
    );
  }
  return (
    <div className="empty-feed">
      <div className="ef-glyph"><Icon.Hash size={28} /></div>
      <h2 className="ef-title">Welcome to #{channel.name}</h2>
      <div className="ef-sub">This is the start of the <strong>#{channel.name}</strong> kanal. {channel.topic && <em>· {channel.topic}</em>}</div>
      <div className="ef-pills">
        {channel.encrypted && <span className="ef-pill"><Icon.Shield size={11} /> end-to-end encrypted</span>}
        <span className="ef-pill">messages sync via mesh</span>
      </div>
    </div>
  );
}

// Profile popover — anchored to click coords.
function ProfilePopover({ pop, onClose, onDM, federated }) {
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const ref = useRef(null);
  useEffect(() => {
    if (!pop) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pop, onClose]);
  if (!pop) return null;
  const m = data?.byId?.[pop.memberId];
  if (!m) return null;
  const nodes = (window.MeshChrome && window.MeshChrome.MEMBER_NODES) || {};
  const fps = (window.MeshChrome && window.MeshChrome.FINGERPRINTS) || {};
  const node = nodes[m.id] || '';
  const fed = federated && node && !node.includes('gbg-1');
  // Clamp position to viewport
  const W = 260, H = 240;
  const x = Math.min(window.innerWidth - W - 8, Math.max(8, pop.x));
  const y = Math.min(window.innerHeight - H - 8, Math.max(8, pop.y));
  return (
    <div className="pop-profile" ref={ref} style={{ position: 'fixed', left: x, top: y, width: W }}>
      <div className="pp-banner" style={{ background: m.color }} />
      <div className="pp-body">
        <div className={memberAvatarClass(m, 'pp-avatar')} style={memberAvatarStyle(m)}>
          {!m.avatarUrl && m.initials}
          <span className={`presence ${m.status}`}></span>
        </div>
        <div className="pp-name">{m.name}</div>
        <div className="pp-sub">
          {m.role && <span className="pp-role">{m.role}</span>}
          {m.custom && <span className="pp-status">· {m.custom}</span>}
        </div>
        {federated && node && (
          <div className="pp-meta">
            <span className="pp-k">node</span> {node.replace('.io','')}
            {fed && <span className="pp-fed">federated</span>}
          </div>
        )}
        {fps[m.id] && (
          <div className="pp-meta">
            <span className="pp-k">safety</span> {fps[m.id]}
          </div>
        )}
        <div className="pp-actions">
          <button className="pp-btn primary" onClick={() => { onDM(m.id); onClose(); }}>Send message</button>
          <button className="pp-btn" onClick={onClose}>View profile</button>
        </div>
      </div>
    </div>
  );
}

// Emoji picker — small grid of common emojis.
const EMOJIS = [
  '👍','👎','❤️','😄','😂','😢','😡','😍',
  '🎉','🔥','💯','✨','🙏','👀','🤔','😴',
  '🛠','🚀','✅','❌','💡','📌','🐛','📦',
  '☕','🍕','🌮','🎨','🎵','🌙','☀️','🦀',
];
function EmojiPicker({ open, onClose, onPick, anchorRect }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  const W = 252, H = 200;
  const r = anchorRect || { left: 100, top: 100, bottom: 100 };
  // Position above the button, right-aligned
  const x = Math.min(window.innerWidth - W - 8, Math.max(8, r.left + r.width - W));
  const y = Math.max(8, r.top - H - 6);
  return (
    <div className="emoji-pick" ref={ref} style={{ position: 'fixed', left: x, top: y, width: W }}>
      <div className="ep-head">
        <span>Frequently used</span>
        <button className="ep-x" onClick={onClose}>×</button>
      </div>
      <div className="ep-grid">
        {EMOJIS.map(e => (
          <button key={e} className="ep-btn" onClick={() => onPick(e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}

// Drag-to-resize handle for the sidebar and members columns.
function ResizeHandle({ kind, value, onResize, min = 180, max = 380 }) {
  const startX = useRef(0);
  const startW = useRef(0);
  const draggingRef = useRef(false);
  function onDown(e) {
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = value;
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function move(ev) {
      const dx = ev.clientX - startX.current;
      const newW = kind === 'sidebar' ? startW.current + dx : startW.current - dx;
      onResize(Math.max(min, Math.min(max, Math.round(newW))));
    }
    function up() {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  return <div className={'resize-handle resize-' + kind} onMouseDown={onDown} title="drag to resize" />;
}

// Thread panel — opens when clicking a thread-preview on a message.
function ThreadPanel({ channelId, messageId, members, onClose, onReact }) {
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const channel = data?.CHANNELS?.find(c => c.id === channelId);
  const original = (data?.MESSAGES?.[channelId] || []).find(m => m.id === messageId);
  const liveReplies = data?.THREAD_REPLIES?.[messageId] || [];
  const [replies, setReplies] = useState(liveReplies);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  // Re-sync replies whenever the context re-derives THREAD_REPLIES from
  // the store (incoming thread:message:new events from useThreadEvents).
  useEffect(() => {
    setReplies(liveReplies);
  }, [liveReplies]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [replies.length]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    // Optimistic local push.
    setReplies(prev => [...prev, {
      id: 'tr-' + Date.now(),
      author: currentUserId(),
      at: new Date(),
      text,
    }]);
    setDraft('');
    // Real send: if the thread doesn't exist yet (first reply), create it
    // via api.createThread; then ws.sendThreadMessage with the encrypted
    // body. The server echoes via thread:message:new → useThreadEvents →
    // useThreadStore → useShellData → THREAD_REPLIES, picked up by the
    // useEffect above to reconcile.
    const teamId = useTeamStore.getState().activeTeamId;
    const derivedKey = useAuthStore.getState().derivedKey;
    if (!teamId || isMockSession()) return;
    try {
      // Find existing thread for this parent message, or create.
      const threads = useThreadStore.getState().threads;
      const existing = (threads[channelId] || []).find((t: any) => t.parent_message_id === messageId);
      let threadId: string;
      if (existing) {
        threadId = existing.id;
      } else {
        const created = (await api.createThread(teamId, channelId, messageId)) as { id: string };
        threadId = created.id;
        useThreadStore.getState().addThread(channelId, created as any);
      }
      const encrypted = await tryEncrypt(text, channelId, derivedKey);
      ws.sendThreadMessage(teamId, threadId, encrypted);
    } catch (err) {
      console.warn('[ThreadPanel] send failed', err);
    }
  }

  if (!original) {
    return (
      <aside className="thread-panel">
        <header className="tp-head">
          <div><span className="tp-title">Thread</span></div>
          <button className="icon-btn" title="Close" onClick={onClose}>×</button>
        </header>
        <div className="tp-empty">thread not found</div>
      </aside>
    );
  }

  const author = members.byId[original.author];

  return (
    <aside className="thread-panel">
      <header className="tp-head">
        <div>
          <span className="tp-title">Thread</span>
          <span className="tp-channel">· #{channel?.name}</span>
        </div>
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </header>

      <div className="tp-feed" ref={scrollRef}>
        <div className="tp-original">
          <div className="tp-msg">
            <Avatar member={author} />
            <div>
              <div className="head">
                <span className="author">{author.name}</span>
                <span className="at">{timeShort(original.at)}</span>
              </div>
              <div className="body">{renderText(original.text, members)}</div>
            </div>
          </div>
          <div className="tp-meta">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</div>
        </div>

        {replies.map(r => {
          const a = members.byId[r.author];
          return (
            <div key={r.id} className="tp-msg">
              <Avatar member={a} />
              <div>
                <div className="head">
                  <span className="author">{a.name}</span>
                  <span className="at">{timeShort(r.at)}</span>
                </div>
                <div className="body">{renderText(r.text, members)}</div>
                {r.reactions && (
                  <div className="rxns">
                    {r.reactions.map((rx, i) => (
                      <span key={i}
                            className={'rxn' + (rx.mine ? ' mine' : '')}
                            onClick={() => {
                              setReplies(prev => prev.map(rr => {
                                if (rr.id !== r.id) return rr;
                                const list = [...(rr.reactions || [])];
                                const idx = list.findIndex(x => x.e === rx.e);
                                if (idx >= 0) {
                                  const cur = list[idx];
                                  if (cur.mine) {
                                    if (cur.n <= 1) list.splice(idx, 1);
                                    else list[idx] = { ...cur, n: cur.n - 1, mine: false };
                                  } else {
                                    list[idx] = { ...cur, n: cur.n + 1, mine: true };
                                  }
                                }
                                return { ...rr, reactions: list };
                              }));
                            }}>
                        <span>{rx.e}</span><span>{rx.n}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="tp-composer">
        <div className="composer">
          <div className="composer-input">
            <textarea
              placeholder={`Reply in thread…`}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={1}
            />
            <button className="send-btn" disabled={!draft.trim()} onClick={send} title="Send (↵)">
              <Icon.Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

// Renders a real <video> element bound to a MediaStream. Used for local +
// remote camera and screen-share tiles. Falls back to null when no stream
// is available — callers render the CamTile/ScreenTile placeholder in
// that case.
function VideoTile({ stream, fit = 'cover', mirror }: { stream: MediaStream; fit?: 'cover' | 'contain'; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [stats, setStats] = useState<{ w: number; h: number; fps: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    // autoplay needs muted; the SFU mixes remote audio separately
    el.muted = true;
    el.play().catch(() => { /* ignore — autoplay policy */ });
  }, [stream]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let frameCount = 0;
    let cancelled = false;
    const rvfc = (el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { width: number; height: number }) => void) => number;
    }).requestVideoFrameCallback;

    const onFrame = (_now: number, meta: { width: number; height: number }) => {
      if (cancelled) return;
      frameCount++;
      if (meta.width > 0 && meta.height > 0) {
        setStats((prev) => (prev && prev.w === meta.width && prev.h === meta.height ? prev : { ...(prev ?? { fps: 0 }), w: meta.width, h: meta.height }));
      }
      rvfc?.call(el, onFrame);
    };
    rvfc?.call(el, onFrame);

    const id = window.setInterval(() => {
      const w = el.videoWidth;
      const h = el.videoHeight;
      if (w === 0 || h === 0) return;
      const fps = frameCount;
      frameCount = 0;
      setStats({ w, h, fps });
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [stream]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={'vid-tile' + (mirror ? ' mirror' : '')}
        style={{
          width: '100%',
          height: '100%',
          objectFit: fit,
          // Letterbox-aware tiles want a black backdrop so the bars don't
          // show through the stage background.
          background: fit === 'contain' ? '#000' : undefined,
          transform: mirror ? 'scaleX(-1)' : undefined,
          display: 'block',
        }}
      />
      {stats && (
        <div
          style={{
            position: 'absolute',
            bottom: 6,
            left: 6,
            padding: '2px 6px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: 1.4,
            color: '#fff',
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 4,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        >
          {stats.w}×{stats.h} · {stats.fps}fps
        </div>
      )}
    </div>
  );
}

function CamTile({ member, mini }) {
  // Pick the real webcam stream if available — local user reads from
  // useVoiceStore.localWebcamStream, peers from remoteWebcamStreams[user_id].
  // Falls back to the SVG silhouette when no stream exists yet.
  const isSelf = member.id === currentUserId();
  const localStream = useVoiceStore((s) => s.localWebcamStream);
  const remoteStream = useVoiceStore((s) => s.remoteWebcamStreams?.[member.id] ?? null);
  const stream = isSelf ? localStream : remoteStream;
  const tone = '#c89770';
  if (stream) {
    return (
      <div className={'cam-tile' + (mini ? ' mini' : '')} style={{ overflow: 'hidden', borderRadius: 'inherit' }}>
        {/* Webcam tiles: `cover` for the full-size tile (people are used
            to face-cropped video calls), `contain` for the mini PIP so
            the whole frame is visible at a glance. */}
        <VideoTile stream={stream} fit={mini ? 'contain' : 'cover'} mirror={isSelf} />
        {!mini && <span className="cam-tile-label">{member.name}</span>}
      </div>
    );
  }
  return (
    <div className={'cam-tile' + (mini ? ' mini' : '')} style={{ '--cam-skin': tone }}>
      <svg className="cam-tile-head" viewBox="0 0 100 100" preserveAspectRatio="xMidYMax meet">
        <circle cx="50" cy="40" r="14" fill="rgba(0,0,0,0.22)" />
        <path d="M20 100 C 22 76, 78 76, 80 100 Z" fill="rgba(0,0,0,0.22)" />
      </svg>
      {!mini && <span className="cam-tile-label">{member.name}</span>}
    </div>
  );
}

// Screen-share tile. Real getDisplayMedia stream when available, otherwise
// the stylized terminal/editor placeholder (kept for tests + offline UX).
function ScreenTile({ member, pip }) {
  const isSelf = member.id === currentUserId();
  const localScreen = useVoiceStore((s) => s.localScreenStream);
  const remoteScreen = useVoiceStore((s) => s.remoteScreenStream);
  const stream = isSelf ? localScreen : remoteScreen;
  if (stream) {
    return (
      <div className="screen-tile" style={{ overflow: 'hidden' }}>
        {/* Screen-share ALWAYS uses `contain` — cropping a desktop screen
            (top/bottom of a long window, or sides of a wide one) defeats
            the purpose of sharing it. Black letterbox bars are fine. */}
        <VideoTile stream={stream} fit="contain" />
        <div className="screen-foot">
          <span>{member.name}'s screen</span>
        </div>
        {pip && (
          <div className="screen-pip">
            <CamTile member={pip} mini />
          </div>
        )}
      </div>
    );
  }
  // pre-computed line widths so they don't reshuffle every render
  const lines = [
    72, 56, 38, 84, 28, 64, 48, 90,
    34, 70, 58, 26, 80, 44, 60, 36, 78,
  ];
  return (
    <div className="screen-tile">
      <div className="screen-titlebar">
        <span className="screen-dot r" />
        <span className="screen-dot y" />
        <span className="screen-dot g" />
        <span className="screen-title">~/dilla/server-rs/src/voice/sfu.rs</span>
      </div>
      <div className="screen-body">
        <div className="screen-sidebar">
          {Array.from({ length: 7 }).map((_, i) => (
            <span key={i} className="screen-side-line" style={{ width: (50 + ((i * 17) % 40)) + '%' }} />
          ))}
        </div>
        <div className="screen-editor">
          {lines.map((w, i) => (
            <div key={i} className="screen-row">
              <span className="screen-num">{i + 1}</span>
              <span className="screen-line" style={{ width: w + '%' }} />
            </div>
          ))}
        </div>
      </div>
      <div className="screen-foot">
        <span>{member.name}'s screen · 1920×1080 · 8fps</span>
      </div>
      {pip && (
        <div className="screen-pip">
          <CamTile member={pip} mini />
        </div>
      )}
    </div>
  );
}

// ───────────── server rail ─────────────
function ServerRail({ servers, activeServer, onPick }) {
  const [serverOrder, setServerOrder] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const ordered = serverOrder
    ? serverOrder.map(id => servers.find(s => s.id === id)).filter(Boolean).concat(servers.filter(s => !serverOrder.includes(s.id)))
    : servers;
  function reorder(srcId, targetId) {
    const ids = ordered.map(s => s.id);
    const from = ids.indexOf(srcId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, srcId);
    setServerOrder(next);
  }
  return (
    <aside className="rail">
      {ordered.map(s => (
        <div key={s.id}
             className={'rail-item' + (s.id === activeServer ? ' active' : '') + (overId === s.id && dragId && dragId !== s.id ? ' drop-target' : '') + (dragId === s.id ? ' dragging' : '')}
             draggable
             onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
             onDragOver={(e) => { e.preventDefault(); setOverId(s.id); }}
             onDragLeave={() => { if (overId === s.id) setOverId(null); }}
             onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== s.id) reorder(dragId, s.id); setDragId(null); setOverId(null); }}
             onDragEnd={() => { setDragId(null); setOverId(null); }}
             onClick={() => onPick(s.id)}
             onContextMenu={(e) => {
               e.preventDefault();
               window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                 { label: s.name, icon: null, onClick: () => {} },
                 { sep: true },
                 { label: 'Team settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'team' } })) },
                 { label: 'Invites', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4l6 5 6-5M2 4v8h12V4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'invites' } })) },
                 { label: 'Federation', icon: <Icon.Lightning size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } })) },
                 { label: 'Mark all read', icon: null, onClick: () => {
                   // Local clear via useUnreadStore, then ws.markChannelRead for
                   // every channel in this team so other devices reconcile via
                   // the channel:read echo. On /mesh the ws call is a no-op.
                   const teamId = useTeamStore.getState().activeTeamId;
                   const unread = useUnreadStore.getState();
                   const list = data?.CHANNELS ?? [];
                   for (const ch of list) {
                     unread.markRead(ch.id);
                     if (teamId && !isMockSession()) {
                       try {
                         const msgs = data?.MESSAGES?.[ch.id] ?? [];
                         const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
                         if (lastId) ws.markChannelRead(teamId, ch.id, lastId);
                       } catch { /* ignore per-channel failures */ }
                     }
                   }
                   window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'All kanals in ' + s.name + ' marked as read.', duration: 2500 } }));
                 } },
                 { sep: true },
                 { label: 'Leave team', danger: true, icon: null, onClick: async () => {
                   if (!(await dillaConfirm({
                     title: 'Leave ' + s.name + '?',
                     body: 'You\'ll lose access to channels and DMs in this team until you re-join with an invite.',
                     confirmLabel: 'Leave team',
                     danger: true,
                   }))) return;
                   const teamId = useTeamStore.getState().activeTeamId;
                   const myId = useAuthStore.getState().teams.get(teamId || '')?.user?.id;
                   if (teamId && myId && !isMockSession()) {
                     // Real self-leave via the dedicated endpoint (server
                     // enforces the sole-admin guard and audit-logs
                     // member.leave). member:left is broadcast so other
                     // clients drop us + rotate channel keys.
                     api.leaveTeam(teamId).then(() => {
                       useAuthStore.getState().removeTeam?.(teamId);
                       window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Left ' + s.name + '.', duration: 3000 } }));
                       window.location.assign('/');
                     }).catch((err: unknown) => {
                       console.warn('[ChatApp] leave team failed', err);
                       window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Leave failed: ' + (err as Error).message, duration: 4000 } }));
                     });
                   } else {
                     window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Demo only — leave would propagate across the mesh on a live server.', duration: 3000 } }));
                   }
                 } },
               ] } }));
             }}
             title={s.name}>
          {s.short}
          {!s.federated && <span className="rail-dot" style={{ background: 'var(--warn)' }}></span>}
        </div>
      ))}
      <button className="rail-add" title="Add team" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-add-server'))}><Icon.Plus /></button>
    </aside>
  );
}

// ───────────── channel sidebar ─────────────
function ChannelSidebar({ team, tab, onTab, channels, activeChannel, onPickChannel,
                          voiceConnection, members, dms, activeDM, onPickDM,
                          onLeaveVoice, onJoinVoice, mute, setMute, deaf, setDeaf, cam, setCam, screen, setScreen,
                          mutedChannels = new Set(), toggleMuteChannel, onNewDm }) {
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const nodeHost = data?.SERVERS?.[0]?.node || 'local';
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [orderOverride, setOrderOverride] = useState(null); // [ids…]
  const isAdminHere = !!(members && members.byId && members.byId[currentUserId()]?.isAdmin);
  // Pull the team's role catalog so we can identify the implicit
  // "everyone" role and resolve which channels the current user can enter.
  // activeTeamId isn't a prop here — read it from the store directly.
  const sidebarTeamId = useTeamStore((s) => s.activeTeamId);
  const teamRoles = useTeamStore((s) => (sidebarTeamId ? s.roles.get(sidebarTeamId) ?? [] : [])) as any[];
  const teamMembers = useTeamStore((s) => (sidebarTeamId ? s.members.get(sidebarTeamId) ?? [] : [])) as any[];
  // Resolved permissions bitmask for the current user in this team.
  // Components read perms.has(bit) so admin-only menu items disappear
  // for users who lack that bit — matches the server's require_permission
  // gates so the UI doesn't dangle actions that would 403.
  const perms = useMemo(() => resolvePermissions(teamMembers, currentUserId()), [teamMembers]);
  const teamGroups = useTeamStore((s) => (sidebarTeamId ? s.groups.get(sidebarTeamId) : undefined)) ?? EMPTY_LIST;
  const groupsById = useMemo(() => new Map<string, { name: string; accessRoleIds: string[]; hiddenIfRestricted: boolean }>(teamGroups.map((g) => [g.id, g])), [teamGroups]);
  const everyoneRoleId = teamRoles.find((r) => r.isDefault)?.id;
  const myRoleIds = (teamMembers.find((m) => m.userId === currentUserId())?.roleIds ?? []) as string[];
  // Pure-inheritance access: when a channel sits in a group, the group's
  // role list is the source of truth and the channel's own list is
  // ignored. resolveAccessRoles centralizes that so isRestricted /
  // canJoinChannel can stay in sync with the server's resolver.
  const resolveAccessRoles = (c: { groupId?: string | null; accessRoleIds?: string[] }): string[] => {
    if (c.groupId) {
      const g = groupsById.get(c.groupId);
      return g?.accessRoleIds ?? [];
    }
    return c.accessRoleIds ?? [];
  };
  const canJoinChannel = (c: { groupId?: string | null; accessRoleIds?: string[] }) => {
    if (isAdminHere) return true;
    const access = resolveAccessRoles(c);
    if (access.length === 0) return true; // back-compat: no access list = open
    if (everyoneRoleId && access.includes(everyoneRoleId)) return true;
    return access.some((rid) => myRoleIds.includes(rid));
  };
  // Channel is "restricted" (padlock icon) whenever its access list is
  // non-empty AND doesn't include the everyone role. Inherited from the
  // channel's group when applicable, so a single group-level restriction
  // surfaces the lock on every channel inside it.
  const isRestricted = (c: { groupId?: string | null; accessRoleIds?: string[] }) => {
    const access = resolveAccessRoles(c);
    return access.length > 0 && everyoneRoleId !== undefined && !access.includes(everyoneRoleId);
  };
  // Sidebar groups are stored as a Set of collapsed-category names in
  // localStorage, keyed per team. Empty string is the implicit "no
  // category" bucket and gets rendered as "Kanals" / "Voice". The hook
  // returns a Set + toggler; we read the persisted state once per teamId
  // change so switching teams shows that team's collapsed set.
  const collapsedKey = sidebarTeamId ? `dilla:groups:${sidebarTeamId}:collapsed` : '';
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    if (typeof window === 'undefined' || !collapsedKey) return new Set();
    try {
      const raw = window.localStorage.getItem(collapsedKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    if (!collapsedKey) return;
    try {
      const raw = window.localStorage.getItem(collapsedKey);
      setCollapsedGroups(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch { setCollapsedGroups(new Set()); }
  }, [collapsedKey]);
  const toggleGroupCollapsed = (cat: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      if (collapsedKey) {
        try { window.localStorage.setItem(collapsedKey, JSON.stringify([...next])); }
        catch { /* quota or private-mode — collapse state is best-effort */ }
      }
      return next;
    });
  };
  // Group a flat channel list by its owning group (preferred) or, for
  // ungrouped channels, by the legacy `category` string. Empty bucket
  // collapses to a default labeled by the caller (Kanals for text,
  // Voice for voice). Group lookups use teamGroups so renames flow
  // through without a re-sync; the legacy fallback covers any channel
  // created before migration 020 (none should exist on a clean db).
  const groupByCategory = (
    chs: Array<{ id: string; category?: string; groupId?: string | null }>,
    defaultLabel: string,
  ): Array<{ key: string; label: string; channels: typeof chs }> => {
    const map = new Map<string, { key: string; label: string; channels: typeof chs }>();
    for (const c of chs) {
      let key = '';
      let label = defaultLabel;
      if (c.groupId) {
        const g = groupsById.get(c.groupId);
        key = 'g:' + c.groupId;
        label = g?.name ?? defaultLabel;
      } else if ((c.category ?? '').trim()) {
        const raw = (c.category as string).trim();
        key = 'c:' + raw;
        label = raw;
      }
      if (!map.has(key)) map.set(key, { key, label, channels: [] });
      map.get(key)!.channels.push(c);
    }
    // Default bucket first, then user-defined groups in insertion order
    // (which mirrors the channel position order from the server).
    const out: Array<{ key: string; label: string; channels: typeof chs }> = [];
    if (map.has('')) out.push(map.get('')!);
    for (const [k, v] of map) if (k !== '') out.push(v);
    return out;
  };
  // Mirror the server-side filter: channels marked hidden_if_restricted
  // are hidden from members who can't access them. The server applies the
  // same rule at sync time, but channels can become restricted live (via
  // channel:access-update / channel:updated) without a re-sync, so we
  // need to re-check on every render too.
  const hiddenForMe = (c: { accessRoleIds?: string[]; hiddenIfRestricted?: boolean; hidden_if_restricted?: boolean; groupId?: string | null }) => {
    // Group inherits hidden_if_restricted to its channels — when set on the
    // group, the channel's own flag is ignored. Mirrors the server filter.
    const group = c.groupId ? groupsById.get(c.groupId) : undefined;
    const hidden = group
      ? group.hiddenIfRestricted
      : !!(c.hiddenIfRestricted ?? c.hidden_if_restricted);
    return hidden && !canJoinChannel(c);
  };
  const visibleChannels = channels.filter((c) => !hiddenForMe(c));
  const voiceChs = visibleChannels.filter(c => c.type === 'voice' && (c.participants || []).length > 0);
  const textChsRaw = visibleChannels.filter(c => c.type === 'text');
  const textChs = orderOverride
    ? orderOverride.map(id => textChsRaw.find(c => c.id === id)).filter(Boolean).concat(textChsRaw.filter(c => !orderOverride.includes(c.id)))
    : textChsRaw;
  function reorderTextCh(srcId, targetId) {
    const ids = textChs.map(c => c.id);
    const from = ids.indexOf(srcId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, srcId);
    setOrderOverride(next);
  }
  const otherVoice = visibleChannels.filter(c => c.type === 'voice' && !voiceChs.includes(c));

  return (
    <aside className="side">
      <div className="side-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="team-name">{team.name}{team.federated && <Icon.Lightning size={11} />}</div>
          <div className="team-node">{team.node} · {team.federated ? 'mesh ok' : 'ready'}</div>
        </div>
        <button className="icon-btn" title="Team settings" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'team' }))}>
          <Icon.Cog size={14} />
        </button>
      </div>

      <div className="tabs">
        <button className={'tab' + (tab === 'kanals' ? ' active' : '')} onClick={() => onTab('kanals')}>
          <Icon.Hash size={12} /> Kanals
          {(() => {
            const total = channels
              .filter((c) => c.type === 'text' && !mutedChannels.has(c.id))
              .reduce((a, c) => a + (c.unread || 0), 0);
            if (total <= 0) return null;
            return (
              <span className="unread-pill mention" style={{ marginLeft: 4, padding: '0 5px' }}>
                {total}
              </span>
            );
          })()}
        </button>
        <button className={'tab' + (tab === 'pms' ? ' active' : '')} onClick={() => onTab('pms')}>
          <Icon.Chat size={12} /> PMs {dms.reduce((a,b) => a + b.unread, 0) > 0 && (
            <span className="unread-pill mention" style={{ marginLeft: 4, padding: '0 5px' }}>
              {dms.reduce((a,b) => a + b.unread, 0)}
            </span>
          )}
        </button>
      </div>

      {tab === 'kanals' ? (
        <div className="side-scroll">
          {voiceChs.length > 0 && (
            <>
              <div className="cat">
                <span>Active voice</span>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>● live</span>
              </div>
              {voiceChs.map(c => (
                <div key={c.id}>
                  <div
                    className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.locked && !canJoinChannel(c) ? ' locked' : '')}
                    onClick={() => onPickChannel(c.id)}
                    onDoubleClick={() => { if (canJoinChannel(c)) onJoinVoice?.(c.id); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // "Active voice" lists every channel that has
                      // *someone* in it — not necessarily us. Show
                      // Join when we're not connected to this channel
                      // (or not in voice at all); show Disconnect
                      // only when this is the channel we're in.
                      const inThisChannel = voiceConnection?.channelId === c.id;
                      const joinAllowed = canJoinChannel(c);
                      window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                        inThisChannel
                          ? { label: 'Disconnect from voice', danger: true, icon: <Icon.Mic size={13} off />, onClick: onLeaveVoice }
                          : { label: joinAllowed ? 'Join voice' : 'Locked', disabled: !joinAllowed, icon: joinAllowed ? <Icon.Speaker size={13} /> : <Icon.Lock size={13} />, onClick: () => { if (joinAllowed) onJoinVoice?.(c.id); } },
                        { label: 'Copy link', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>, onClick: () => { navigator.clipboard?.writeText(('dilla://' + nodeHost + '/k/') + c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal link copied.', duration: 2000 } })); } },
                        ...(perms.has(PERM_MANAGE_CHANNELS) ? [
                          { sep: true },
                          c.groupId
                            ? { label: 'Access is handled by group', icon: <Icon.Lock size={12} />, disabled: true, onClick: () => {} }
                            : { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: c.id })) },
                          { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: c.id })) },
                        ] : []),
                      ] } }));
                    }}>
                    <span className="ch-glyph"><Icon.Speaker size={14} /></span>
                    <span className="ch-name">{c.name}</span>
                    {isRestricted(c) && <span style={{ color: 'var(--fg-3)' }} title="restricted access"><Icon.Lock size={11} /></span>}
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-3)' }}>
                      {(c.participants||[]).length}
                    </span>
                  </div>
                  <div className="voice-participants">
                    {(c.participants || []).map(pid => {
                      const m = members.byId[pid];
                      const peer = c.voicePeers && c.voicePeers[pid];
                      // Voice activity (speaking ring + level meter) is
                      // intentionally NOT shown in the left-sidebar
                      // participants — it pushed a Zustand update every
                      // VAD tick and re-rendered this whole section
                      // many times per second. Speaking visualization
                      // lives in the main voice-channel UI instead, where
                      // it has somewhere meaningful to display. We still
                      // surface the static toggles (muted/deafened/cam/
                      // screen) since those only change on user action.
                      const muted = peer ? !!peer.muted : (pid === currentUserId() && mute);
                      const deafened = peer ? !!peer.deafened : (pid === currentUserId() && deaf);
                      const screenOn = peer ? !!peer.screen_sharing : false;
                      const camOn = peer ? !!peer.webcam_sharing : (pid === currentUserId() && cam);
                      return (
                        <div key={pid} className={'voice-participant' + (muted ? ' muted' : '')}
                             onContextMenu={(e) => {
                               e.preventDefault();
                               window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                                 { label: 'Adjust volume', icon: <Icon.Headphones size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'voice', author: 'mixer', text: 'Per-user volume slider for ' + m.name + ' (drag to set).', duration: 3500 } })) },
                                 { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: pid, x: 200, y: 200 } })) },
                                 { sep: true },
                                 { label: 'Mute for me only', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'mixer', text: 'Muted ' + m.name + ' for this session only.', duration: 2500 } })) },
                                 { label: 'Server-mute (admin)', danger: true, icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Server-mute requires admin role. Propagates across the mesh.', duration: 3500 } })) },
                                 { label: 'Disconnect from voice', danger: true, icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Disconnect ' + m.name + ' from #voice-lounge (admin only).', duration: 3000 } })) },
                               ] } }));
                             }}>
                          <div className={memberAvatarClass(m, 'vp-avatar')} style={memberAvatarStyle(m)}>{!m.avatarUrl && m.initials}</div>
                          <span className="vp-name">{m.name}</span>
                          <div className="vp-state">
                            {camOn && <span className="vp-icon screen" title="camera on"><Icon.Video size={11} /></span>}
                            {screenOn && <span className="vp-icon screen" title="sharing screen"><Icon.Screen size={11} /></span>}
                            {deafened && <span className="vp-icon mute" title="deafened"><Icon.Headphones size={11} off /></span>}
                            {muted && <span className="vp-icon mute" title="muted"><Icon.Mic size={11} off /></span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

          {groupByCategory(textChs, 'Kanals').map((grp, gi) => (
            <React.Fragment key={'tg-' + grp.key}>
              <div
                className="cat cat-collapsible"
                onClick={() => toggleGroupCollapsed(grp.key)}
                title={collapsedGroups.has(grp.key) ? 'Expand' : 'Collapse'}
                onContextMenu={(e) => {
                  // Real groups have key 'g:<id>'. The default and legacy
                  // category buckets don't have backing entities, so they
                  // get no settings menu — admins create a real group via
                  // Kanal Settings → Group on a channel.
                  if (!grp.key.startsWith('g:')) return;
                  // Group settings exist for admins only — no point opening a
                  // ctx menu that's all-empty for a regular member.
                  if (!perms.has(PERM_MANAGE_CHANNELS)) return;
                  e.preventDefault();
                  const groupId = grp.key.slice(2);
                  window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                    { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-group-access', { detail: groupId })) },
                    { label: 'Group settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-group-settings', { detail: groupId })) },
                  ] } }));
                }}
              >
                <span className="cat-chev" style={{ transform: collapsedGroups.has(grp.key) ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                <span>{grp.label}</span>
                {gi === 0 && (
                  <div className="cat-actions"><button className="icon-btn" title="New kanal" onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('dilla:open-new-channel')); }}><Icon.Plus size={12} /></button></div>
                )}
              </div>
              {!collapsedGroups.has(grp.key) && grp.channels.map(c => (
            <div key={c.id}
                 draggable
                 onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
                 onDragOver={(e) => { e.preventDefault(); setOverId(c.id); }}
                 onDragLeave={(e) => { if (overId === c.id) setOverId(null); }}
                 onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== c.id) reorderTextCh(dragId, c.id); setDragId(null); setOverId(null); }}
                 onDragEnd={() => { setDragId(null); setOverId(null); }}
                 className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.unread > 0 ? ' unread' : '') + (mutedChannels.has(c.id) ? ' muted' : '') + (overId === c.id && dragId && dragId !== c.id ? ' drop-target' : '') + (dragId === c.id ? ' dragging' : '')}
                 onClick={() => onPickChannel(c.id)}
                 onContextMenu={(e) => {
                   e.preventDefault();
                   window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                   { label: 'Mark as read', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>, onClick: () => {
                     useUnreadStore.getState().markRead(c.id);
                     const teamId = useTeamStore.getState().activeTeamId;
                     if (teamId && !isMockSession()) {
                       const msgs = data?.MESSAGES?.[c.id] ?? [];
                       const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
                       if (lastId) {
                         try { ws.markChannelRead(teamId, c.id, lastId); } catch { /* ignore */ }
                       }
                     }
                     window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Marked all messages in #' + c.name + ' as read.', duration: 2500 } }));
                   } },
                   { label: (mutedChannels.has(c.id) ? 'Unmute kanal' : 'Mute kanal'), icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 6h2l3-3v10l-3-3H2zM10 5l3 3-3 3M13 5l-3 3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>, onClick: () => { toggleMuteChannel(c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: (mutedChannels.has(c.id) ? 'Unmuted ' : 'Muted ') + '#' + c.name + '.', duration: 2500 } })); } },
                   { label: 'Copy link', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>, onClick: () => { navigator.clipboard?.writeText(('dilla://' + nodeHost + '/k/') + c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Link copied.', duration: 2000 } })); } },
                   ...(perms.has(PERM_MANAGE_CHANNELS) ? [
                     { sep: true },
                     c.groupId
                       ? { label: 'Access is handled by group', icon: <Icon.Lock size={12} />, disabled: true, onClick: () => {} }
                       : { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: c.id })) },
                     { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: c.id })) },
                   ] : []),
                 ] } }));
                 }}>
              <span className="ch-glyph"><Icon.Hash size={14} /></span>
              <span className="ch-name">{c.name}</span>
              {isRestricted(c) && <span style={{ color: 'var(--fg-3)' }} title="restricted access"><Icon.Lock size={11} /></span>}
              {mutedChannels.has(c.id) && <span className="ch-muted" title="muted"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M2 6h2l3-3v10l-3-3H2zM10 5l3 3-3 3M13 5l-3 3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>}
              {c.unread > 0 && !mutedChannels.has(c.id) && (
                <span className={'unread-pill' + (c.mention ? ' mention' : '')}>{c.unread}</span>
              )}
            </div>
          ))}
            </React.Fragment>
          ))}

          {otherVoice.length > 0 && groupByCategory(otherVoice, 'Voice').map((grp) => (
            <React.Fragment key={'vg-' + grp.key}>
              <div
                className="cat cat-collapsible"
                onClick={() => toggleGroupCollapsed('voice:' + grp.key)}
                title={collapsedGroups.has('voice:' + grp.key) ? 'Expand' : 'Collapse'}
                onContextMenu={(e) => {
                  if (!grp.key.startsWith('g:')) return;
                  if (!perms.has(PERM_MANAGE_CHANNELS)) return;
                  e.preventDefault();
                  const groupId = grp.key.slice(2);
                  window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                    { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-group-access', { detail: groupId })) },
                    { label: 'Group settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-group-settings', { detail: groupId })) },
                  ] } }));
                }}
              >
                <span className="cat-chev" style={{ transform: collapsedGroups.has('voice:' + grp.key) ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                <span>{grp.label}</span>
              </div>
              {!collapsedGroups.has('voice:' + grp.key) && grp.channels.map(c => (
                <div key={c.id}
                     className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.locked && !canJoinChannel(c) ? ' locked' : '')}
                     onClick={() => onPickChannel(c.id)}
                     onDoubleClick={() => { if (canJoinChannel(c)) onJoinVoice?.(c.id); }}
                     onContextMenu={(e) => {
                       e.preventDefault();
                       const joinAllowed = canJoinChannel(c);
                       window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                         { label: joinAllowed ? 'Join voice' : 'Locked', disabled: !joinAllowed, icon: joinAllowed ? <Icon.Speaker size={13} /> : <Icon.Lock size={13} />, onClick: () => { if (joinAllowed) { onPickChannel(c.id); onJoinVoice?.(c.id); } } },
                         { label: 'Copy link', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>, onClick: () => { navigator.clipboard?.writeText(('dilla://' + nodeHost + '/k/') + c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal link copied.', duration: 2000 } })); } },
                         ...(perms.has(PERM_MANAGE_CHANNELS) ? [
                           { sep: true },
                           c.groupId
                             ? { label: 'Access is handled by group', icon: <Icon.Lock size={12} />, disabled: true, onClick: () => {} }
                             : { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: c.id })) },
                           { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: c.id })) },
                         ] : []),
                       ] } }));
                     }}>
                  <span className="ch-glyph"><Icon.Speaker size={14} /></span>
                  <span className="ch-name">{c.name}</span>
                  {isRestricted(c) && <span style={{ color: 'var(--fg-3)' }} title="restricted access"><Icon.Lock size={11} /></span>}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div className="side-scroll">
          <div className="cat"><span>Direct Messages</span>
            <div className="cat-actions"><button className="icon-btn" title="New DM" onClick={() => onNewDm && onNewDm()}><Icon.Plus size={12} /></button></div>
          </div>
          {dms.map(d => {
            const isGroup = d.group;
            // `other` is the per-user record from members.byId. It can legitimately
            // be missing — e.g. a DM that arrived before the team's member roster
            // synced (cross-session case), or the peer left the team. Fall back to
            // a placeholder so the sidebar still renders instead of crashing.
            const other = isGroup ? null : (members.byId[d.with] || { name: 'Unknown', color: 'var(--muted)', initials: '?' });
            const name = isGroup ? d.name : other.name;
            return (
              <div key={d.id}
                   className={'channel-row' + (d.id === activeDM ? ' active' : '') + (d.unread > 0 ? ' unread' : '')}
                   onClick={() => onPickDM(d.id)}
                   onContextMenu={(e) => {
                     e.preventDefault();
                     window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                       { label: 'Mark as read', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>, onClick: () => {
                         // DMs share the unread store with channels; the dm.id is
                         // the same key the store uses. Server-side mark-read is
                         // ws.markChannelRead too (server treats both the same).
                         useUnreadStore.getState().markRead(d.id);
                         const teamId = useTeamStore.getState().activeTeamId;
                         if (teamId && !isMockSession()) {
                           const msgs = data?.DM_MESSAGES?.[d.id] ?? [];
                           const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
                           if (lastId) {
                             try { ws.markChannelRead(teamId, d.id, lastId); } catch { /* ignore */ }
                           }
                         }
                         window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Marked DM as read.', duration: 2000 } }));
                       } },
                       { label: 'Mute notifications', icon: <Icon.Mic size={13} off />, onClick: () => {
                         // Mute uses the same per-channel mute set as channels —
                         // DM ids are stored alongside channel ids.
                         toggleMuteChannel(d.id);
                         window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: mutedChannels.has(d.id) ? 'Unmuted DM.' : 'DM muted.', duration: 2000 } }));
                       } },
                       { sep: true },
                       { label: 'Close DM', danger: true, icon: null, onClick: () => {
                         window.dispatchEvent(new CustomEvent('dilla:close-dm', { detail: d.id }));
                         window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Closed DM. Re-open it from a member profile.', duration: 2500 } }));
                       } },
                     ] } }));
                   }}>
                {isGroup ? (
                  <span className="ch-glyph"><Icon.People size={14} /></span>
                ) : (
                  <div className="vp-avatar" style={{ background: other.color, width: 20, height: 20, fontSize: 10 }}>{other.initials}</div>
                )}
                <span className="ch-name">{name}</span>
                {d.unread > 0 && <span className="unread-pill mention">{d.unread}</span>}
              </div>
            );
          })}
        </div>
      )}

      {voiceConnection && (
        <div className="voice-dock">
          <div className="voice-dock-top">
            <div className="voice-dock-status">Voice</div>
            <div className="voice-dock-name">{voiceConnection.channel} · {team.name}</div>
          </div>
          <div className="voice-dock-controls">
            <button className={'vctrl' + (mute ? ' active' : '')} title={mute ? "Unmute" : "Mute"} onClick={() => setMute(!mute)}>
              <Icon.Mic size={14} off={mute} />
            </button>
            <button className={'vctrl' + (deaf ? ' active' : '')} title={deaf ? "Undeafen" : "Deafen"} onClick={() => setDeaf(!deaf)}>
              <Icon.Headphones size={14} off={deaf} />
            </button>
            <button className={'vctrl' + (cam ? ' on' : '')} title={cam ? "Stop camera" : "Start camera"} onClick={() => setCam(!cam)}>
              <Icon.Video size={14} off={!cam} />
            </button>
            <button className={'vctrl' + (screen ? ' on' : '')} title={screen ? "Stop sharing" : "Share screen"} onClick={() => setScreen(!screen)}>
              <Icon.Screen size={14} off={!screen} />
            </button>
            <button className="vctrl danger" title="Disconnect" onClick={onLeaveVoice}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
      )}

      <UserPanel member={members.byId[currentUserId()]} />
    </aside>
  );
}

function UserPanel({ member }) {
  // `member` can legitimately be undefined for a beat after sign-in —
  // currentUserId() reads from window.SHELL_DATA which AppShell refreshes
  // every render, but between an auth-store update and the next shell-data
  // re-derive there's a window where byId[currentUserId()] returns
  // undefined. Render nothing rather than crash on `member.status`.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState(member?.status ?? 'online');
  const [custom, setCustom] = useState(member?.custom || '');
  const [draftCustom, setDraftCustom] = useState(custom);
  const popRef = useRef(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e) { if (popRef.current && !popRef.current.contains(e.target)) setPickerOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setPickerOpen(false); }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const statuses = [
    { id: 'online',  label: 'Online',  hint: 'available' },
    { id: 'idle',    label: 'Idle',    hint: 'away · auto after 10 min' },
    { id: 'dnd',     label: 'Do not disturb', hint: 'suppress notifications' },
    { id: 'offline', label: 'Invisible', hint: 'appears offline · still receive messages' },
  ];

  // Persist presence changes via api.updatePresence so other team members
  // see the new status/custom message live (server broadcasts presence:changed
  // → usePresenceEvents → store → UI).
  function persistPresence(nextStatus: string, nextCustom: string) {
    const teamId = useTeamStore.getState().activeTeamId;
    if (!teamId || isMockSession()) return;
    api.updatePresence(teamId, nextStatus, nextCustom || undefined).catch((err) =>
      console.warn('[UserPanel] updatePresence failed', err),
    );
  }

  // No identity yet (data still loading, or post-sign-in race) — render
  // an empty slot rather than crashing on `member.name`.
  if (!member) return <div className="user-panel" />;

  return (
    <div className="user-panel" style={{ position: 'relative' }}>
      <PlainAvatar member={{ ...member, status }} />
      <div className="meta">
        <div className="name">{member.name}</div>
        <div className="sub">{custom || status}</div>
      </div>
      <div className="actions">
        <button className="icon-btn" title="Set status" onClick={() => setPickerOpen(o => !o)}><Icon.Emoji size={13} /></button>
        <button className="icon-btn" title="Preferences" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'user' }))}>
          <Icon.Cog size={14} />
        </button>
      </div>
      {pickerOpen && (
        <div ref={popRef} className="status-pop">
          <div className="sp-head">Set your status</div>
          {statuses.map(s => (
            <button key={s.id}
                    className={'sp-row' + (s.id === status ? ' on' : '')}
                    onClick={() => {
                      setStatus(s.id);
                      setPickerOpen(false);
                      persistPresence(s.id, custom);
                    }}>
              <span className={'presence ' + s.id}></span>
              <span className="sp-label">{s.label}</span>
              <span className="sp-hint">{s.hint}</span>
            </button>
          ))}
          <div className="sp-divider" />
          <div className="sp-custom">
            <div className="sp-custom-label">Custom message</div>
            <div className="sp-custom-row">
              <input value={draftCustom} onChange={(e) => setDraftCustom(e.target.value)} placeholder="pushing pixels" maxLength={42} />
              <button className="sp-btn" onClick={() => {
                setCustom(draftCustom);
                setPickerOpen(false);
                persistPresence(status, draftCustom);
              }}>Set</button>
            </div>
            {custom && (
              <button className="sp-clear" onClick={() => {
                setCustom('');
                setDraftCustom('');
                persistPresence(status, '');
              }}>clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── main pane: text channel ─────────────
function TextChannel({ channel, messages, members, dmPartner, draft, setDraft, onSend, onReact, onVote, onEdit, onDelete, onAttach, replyTo, onSetReply, typing, onJoinVoice, membersOpen, onToggleMembers, slowModeLock }) {
  // Viewer permissions for this team, used to gate the message context
  // menu (pin / unpin / delete-others). Mirrors the server's
  // require_permission gates so we don't dangle an action that 403s.
  const tcTeamId = useTeamStore((s) => s.activeTeamId);
  const tcTeamMembers = useTeamStore((s) => (tcTeamId ? s.members.get(tcTeamId) ?? [] : [])) as any[];
  const msgPerms = useMemo(
    () => resolvePermissions(tcTeamMembers, currentUserId()),
    [tcTeamMembers],
  );
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const feedRef = useRef(null);
  // Scroll-up to fetch older messages. The hook is a no-op on /mesh
  // (mock sessions) since there's no server to page against.
  useChannelLazyLoad(channel.id, feedRef);
  const emojiBtnRef = useRef(null);
  const textareaRef = useRef(null);
  const [picker, setPicker] = useState({ open: false, anchor: null, target: 'draft' });
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [forwardId, setForwardId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // Close lightbox on Escape.
  useEffect(() => {
    if (!lightboxSrc) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setLightboxSrc(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxSrc]);
  const [unreadAt, setUnreadAt] = useState(null);
  const [mention, setMention] = useState(null); // { query }
  const [mentionIdx, setMentionIdx] = useState(0);
  const [slash, setSlash] = useState(null); // { query }
  const [slashIdx, setSlashIdx] = useState(0);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, msgId }
  const [savedMsgs, setSavedMsgs] = useState(new Set());
  const [savedOpen, setSavedOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);

  // Pinned message ids come from pinStore now — sync:init seeds it and
  // message:pin-update keeps it live across clients. Resolve to actual
  // message records the renderer expects, dropping ids we don't have
  // locally (the message hasn't paged in yet) instead of crashing.
  const pinnedSet = usePinStore((s) => s.pinned.get(channel.id));
  const pinnedMsgs = useMemo(() => {
    if (!pinnedSet || pinnedSet.size === 0) return [];
    return [...pinnedSet]
      .map((id) => messages.find((m) => m.id === id))
      .filter(Boolean);
  }, [pinnedSet, messages]);
  function saveEdit() {
    if (onEdit && editingId) onEdit(editingId, editDraft.trim());
    setEditingId(null);
  }
  const deleteTarget = deleteConfirm ? messages.find(m => m.id === deleteConfirm) : null;

  const mentionMatches = mention
    ? (members.MEMBERS || []).filter(m => m.name.toLowerCase().startsWith(mention.query) && m.id !== currentUserId()).slice(0, 6)
    : [];

  const SLASH_COMMANDS = [
    { cmd: '/me',      args: '<action>',  desc: 'narrate an action in italics' },
    { cmd: '/code',    args: '<language>', desc: 'start a code block' },
    { cmd: '/shrug',   args: '',          desc: "appends ¯\\_(ツ)_/¯" },
    { cmd: '/poll',    args: '<question> | <opt1> | <opt2>', desc: 'post a poll · react with numbers to vote' },
    { cmd: '/giphy',   args: '<search>',  desc: 'post a giphy search link' },
    { cmd: '/topic',   args: '<text>',    desc: "set the channel topic (needs manage-channels)" },
    { cmd: '/lock',    args: '',          desc: 'lock this voice channel (needs manage-channels)' },
    { cmd: '/unlock',  args: '',          desc: 'unlock this voice channel (needs manage-channels)' },
    { cmd: '/nick',    args: '<name>',    desc: 'set your nickname for this team' },
    { cmd: '/invite',  args: '<user>',    desc: 'open Invites to create a link' },
    { cmd: '/w',       args: '<user>',    desc: 'open a private message (whisper)' },
    { cmd: '/help',    args: '',          desc: 'show keyboard shortcuts' },
  ];
  const slashMatches = slash
    ? SLASH_COMMANDS.filter(s => s.cmd.startsWith('/' + slash.query))
    : [];

  function applyMention(name) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = draft.slice(0, pos);
    const after = draft.slice(pos);
    const newBefore = before.replace(/@\w*$/, '@' + name + ' ');
    const next = newBefore + after;
    setDraft(next);
    setMention(null);
    setMentionIdx(0);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newPos = newBefore.length;
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }
  function applySlash(cmd) {
    const next = cmd.cmd + (cmd.args ? ' ' : '');
    setDraft(next);
    setSlash(null);
    setSlashIdx(0);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newPos = next.length;
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }

  // Hidden file input + ref so the paperclip button can open the OS picker.
  // Selecting one or more files calls handleFiles → real File objects flow
  // to onAttach which uploads via api.uploadFile.
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: File[]) {
    if (files.length === 0) return;
    for (const file of files) {
      // Animated upload-progress strip — visual stub; actual progress isn't
      // exposed by api.uploadFile yet so we show the staged phases until
      // the await resolves, then hide the row.
      const id = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const upload = { id, name: file.name, size: file.size, progress: 0, phase: 'reading' };
      setUploads(prev => [...prev, upload]);
      const phases = [
        { ms: 100, p: 25, phase: 'reading' },
        { ms: 100, p: 55, phase: 'encrypting' },
        { ms: 200, p: 85, phase: 'uploading' },
      ];
      let acc = 0;
      phases.forEach((ph) => {
        acc += ph.ms;
        setTimeout(() => {
          setUploads(prev => prev.map(u => u.id === id ? { ...u, progress: ph.p, phase: ph.phase } : u));
        }, acc);
      });
      // Hand the real File off to the parent's onAttach (uploads via
      // api.uploadFile). When that resolves the strip disappears.
      Promise.resolve(onAttach?.(file)).finally(() => {
        setUploads(prev => prev.filter(u => u.id !== id));
      });
    }
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    handleFiles(files);
  }
  // Sticky-bottom strategy:
  //   `userPagedUpRef` mirrors the scroll position. Whenever a
  //   `scroll` event fires we set it based on distance from the
  //   bottom — > 30px = paged up, ≤ 30px = at the live edge. This
  //   catches every kind of user-initiated scroll (wheel, scrollbar
  //   drag, touch, keyboard) since they all fire `scroll`. It does
  //   NOT flip false-positive on async content growth because
  //   scrollTop staying constant means no scroll event fires.
  const userPagedUpRef = useRef(false);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    function onScroll() {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      userPagedUpRef.current = dist > 30;
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [channel.id]);

  // Reset follow state whenever we switch channels.
  useLayoutEffect(() => {
    userPagedUpRef.current = false;
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel.id]);

  // Stick to bottom after any commit that changed the messages array.
  // useLayoutEffect runs synchronously after DOM mutations and before
  // paint, so the user never sees a half-scrolled feed.
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (!userPagedUpRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Late-loading media: when an image (or any child's intrinsic size)
  // arrives after the layout that triggered our useLayoutEffect, re-
  // snap to bottom unless the user has paged up in the meantime.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    let raf = 0;
    const snap = () => {
      raf = 0;
      if (!el) return;
      if (!userPagedUpRef.current) el.scrollTop = el.scrollHeight;
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(snap);
    };
    const ro = new ResizeObserver(schedule);
    const observed = new Set<Element>();
    const observeChildren = () => {
      for (const c of Array.from(el.children)) {
        if (!observed.has(c)) {
          ro.observe(c);
          observed.add(c);
        }
      }
    };
    observeChildren();
    const mo = new MutationObserver(observeChildren);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [channel.id]);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    function onScroll() {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJump(dist > 120);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [channel.id]);

  function scrollToBottom() {
    if (feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
    }
  }

  // Compute day dividers
  const dividers = useMemo(() => {
    const map = {};
    groups.forEach((g, i) => {
      const k = g.at.toDateString();
      if (!map[k]) map[k] = i;
    });
    return map;
  }, [groups]);
  const seenDays = new Set();

  return (
    <div className="main">
      <div className="main-head">
        <div className="ch-title">
          {channel.type === 'dm' ? (
            channel.group ? (
              <><Icon.People size={15} /><span>{channel.name}</span></>
            ) : dmPartner ? (
              <>
                <span className="dm-avatar" style={{ background: dmPartner.color }}>
                  {dmPartner.initials}
                  <span className={'presence ' + dmPartner.status}></span>
                </span>
                <span>{dmPartner.name}</span>
              </>
            ) : (
              <><Icon.Chat size={15} /><span>{channel.name}</span></>
            )
          ) : (
            <>
              <Icon.Hash size={15} />
              <span>{channel.name}</span>
            </>
          )}
          {channel.encrypted && <span className="enc-badge"><Icon.Shield size={10} /> E2E</span>}
        </div>
        <div className="ch-topic">{channel.topic}</div>
        <div className="head-actions">
          {channel.type !== 'dm' && (
            <div style={{ position: 'relative' }}>
              <button className={'icon-btn' + (threadsOpen ? ' active' : '')}
                      title="Threads in this kanal"
                      onClick={() => setThreadsOpen(o => !o)}>
                <Icon.Thread size={14} />
              </button>
              {threadsOpen && (() => {
                const threads = messages.filter(m => m.thread);
                return (
                  <div className="pin-pop">
                    <div className="pin-head">
                      <span>Threads in #{channel.name}</span>
                      <button className="pin-x" onClick={() => setThreadsOpen(false)}>×</button>
                    </div>
                    {threads.length === 0 ? (
                      <div className="pin-empty">no active threads yet · click the thread icon on any message to start one</div>
                    ) : (
                      <div className="pin-list">
                        {threads.map(tm => {
                          const a = members.byId[tm.author] || { name: tm.author, color: '#666', initials: '??' };
                          return (
                            <div key={tm.id} className="pin-row"
                                 onClick={() => {
                                   setThreadsOpen(false);
                                   window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: channel.id, messageId: tm.id } }));
                                 }}>
                              <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                              <div>
                                <div className="pin-meta">
                                  <span className="pin-author">{a.name}</span>
                                  <span className="pin-time">· {timeShort(tm.at)}</span>
                                </div>
                                <div className="pin-text">{tm.text}</div>
                                <div className="th-foot">
                                  <span className="th-count">↪ {tm.thread.count} replies</span>
                                  <span className="th-sep">·</span>
                                  <span className="th-last">last {timeShort(tm.thread.lastReplyAt)}</span>
                                  <div className="th-avs">
                                    {(tm.thread.participants || []).map(pid => {
                                      const p = members.byId[pid];
                                      if (!p) return null;
                                      return <div key={pid} className="rr-av" style={{ background: p.color, marginLeft: -4 }}>{p.initials}</div>;
                                    })}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          {channel.type !== 'dm' && (
            <div style={{ position: 'relative' }}>
              <button className={'icon-btn' + (savedOpen ? ' active' : '')}
                      title={`Saved messages${savedMsgs.size ? ' (' + savedMsgs.size + ')' : ''}`}
                      onClick={() => setSavedOpen(o => !o)}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l4-3 4 3V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              </button>
              {savedOpen && (
                <div className="pin-pop">
                  <div className="pin-head">
                    <span>Saved messages · all kanals</span>
                    <button className="pin-x" onClick={() => setSavedOpen(false)}>×</button>
                  </div>
                  {savedMsgs.size === 0 ? (
                    <div className="pin-empty">no saved messages yet · right-click a message to bookmark it</div>
                  ) : (
                    <div className="pin-list">
                      {Array.from(savedMsgs).map(sid => {
                        let msg = null, chanName = '';
                        for (const [chId, list] of Object.entries(data.MESSAGES)) {
                          const f = list.find(x => x.id === sid);
                          if (f) { msg = f; chanName = chId; break; }
                        }
                        if (!msg) return null;
                        const a = data.byId[msg.author] || { name: msg.author, color: '#666', initials: '??' };
                        return (
                          <div key={sid} className="pin-row" onClick={() => { setSavedOpen(false); setActiveChannel(chanName); setActiveView({ kind: 'channel', id: chanName }); }}>
                            <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                            <div>
                              <div className="pin-meta"><span className="pin-author">{a.name}</span> <span className="pin-time">· #{chanName} · {timeShort(msg.at)}</span></div>
                              <div className="pin-text">{msg.text}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {channel.type !== 'dm' && (
            <div style={{ position: 'relative' }}>
              <button className={'icon-btn' + (pinnedOpen ? ' active' : '')}
                      title={`Pinned messages${pinnedMsgs.length ? ' (' + pinnedMsgs.length + ')' : ''}`}
                      onClick={() => setPinnedOpen(o => !o)}>
                <Icon.Pin />
              </button>
              {pinnedOpen && (
                <div className="pin-pop" onMouseLeave={() => {}}>
                  <div className="pin-head">
                    <span>Pinned in #{channel.name}</span>
                    <button className="pin-x" onClick={() => setPinnedOpen(false)}>×</button>
                  </div>
                  {pinnedMsgs.length === 0 ? (
                    <div className="pin-empty">no pinned messages yet · pin one via the message menu</div>
                  ) : (
                    <div className="pin-list">
                      {pinnedMsgs.map(pm => {
                        const a = members.byId[pm.author] || { name: pm.author, color: '#666', initials: '??' };
                        return (
                          <div
                            key={pm.id}
                            className="pin-row"
                            onClick={() => {
                              // Same scroll+flash pattern as the reply-ref
                              // jump above. Close the pop first so the
                              // flash isn't obscured.
                              setPinnedOpen(false);
                              // setState is async — wait a tick for the
                              // pop to unmount before scrolling, otherwise
                              // its layout shift can race with the smooth
                              // scroll and land the target off-screen.
                              setTimeout(() => {
                                const el = feedRef.current && feedRef.current.querySelector('[data-msg-id="' + pm.id + '"]');
                                if (el) {
                                  el.classList.add('msg-flash');
                                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                  setTimeout(() => el.classList.remove('msg-flash'), 1400);
                                }
                              }, 0);
                            }}
                          >
                            <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                            <div>
                              <div className="pin-meta"><span className="pin-author">{a.name}</span> <span className="pin-time">· {timeShort(pm.at)}</span></div>
                              <div className="pin-text">{pm.text}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {channel.type !== 'dm' && <button className={'icon-btn' + (membersOpen ? '' : ' off')}
                  title={membersOpen ? 'Hide members' : 'Show members'}
                  onClick={onToggleMembers}>
            <Icon.People size={14} />
          </button>}
          <div className="search-box" role="button" tabIndex={0}
               onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-search', { detail: { scopeChannel: channel.id, scopeName: channel.name } }))}>
            <Icon.Search size={13} />
            <span>{channel.type === 'dm' ? 'Search this DM…' : 'Search in #' + channel.name + '…'}</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.7 }}>/</span>
          </div>
        </div>
      </div>

      <div className="feed" ref={feedRef}>
        {groups.length === 0 ? (
          <EmptyFeed channel={channel} dmPartner={dmPartner} />
        ) : groups.map((g, i) => {
          const dayKey = g.at.toDateString();
          const showDay = !seenDays.has(dayKey);
          seenDays.add(dayKey);
          const showUnreadAbove = unreadAt && g.children && g.children[0] && g.children[0].id === unreadAt;
          const author = members.byId[g.author] || { name: g.author, color: '#666', initials: '??' };
          if (g.base.kind === 'system') {
            return (
              <React.Fragment key={i}>
                {showDay && <div className="day-divider">{dayLabel(g.at)}</div>}
                <div className="msg system">
                  <div></div>
                  <div>
                    <div className="body">— {g.base.text}</div>
                    {g.base.meta && <div className="meta">{g.base.meta}</div>}
                  </div>
                </div>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={i}>
              {showDay && <div className="day-divider">{dayLabel(g.at)}</div>}
              {showUnreadAbove && (
                <div className="unread-divider"><span>new</span></div>
              )}
              {g.children.map((m, idx) => {
                const isFirst = idx === 0;
                const hasMention = (m.mentions || []).includes(currentUserId());
                const isPinned = pinnedSet?.has(m.id) ?? false;
                return (
                  <div key={m.id}
                       className={'msg' + (isFirst ? '' : ' compact') + (hasMention ? ' has-mention' : '') + (m.replyTo ? ' has-reply' : '') + (isPinned ? ' is-pinned' : '')}
                       data-msg-id={m.id}
                       onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, msgId: m.id, isMine: m.author === currentUserId() }); }}>
                    {m.replyTo && (() => {
                      const orig = messages.find(om => om.id === m.replyTo);
                      // When the original isn't in the loaded window
                      // (older message paged out), render a stub so the
                      // reply doesn't appear context-less. Clicking it
                      // doesn't try to scroll (we don't have the target);
                      // a future enhancement can fetch-and-jump.
                      if (!orig) {
                        return (
                          <div className="reply-ref reply-ref-missing" title="Original message not loaded">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            <span className="rr-text rr-text-missing">original message not loaded</span>
                          </div>
                        );
                      }
                      const oa = members.byId[orig.author] || { name: orig.author, color: '#666', initials: '??' };
                      return (
                        <div className="reply-ref"
                             onClick={() => {
                               const el = feedRef.current && feedRef.current.querySelector('[data-msg-id="' + orig.id + '"]');
                               if (el) {
                                 el.classList.add('msg-flash');
                                 el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                 setTimeout(() => el.classList.remove('msg-flash'), 1400);
                               }
                             }}>
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          <span className="rr-av" style={{ background: oa.color }}>{oa.initials}</span>
                          <span className="rr-author">{oa.name}</span>
                          <span className="rr-text">{(orig.text || '').slice(0, 80)}{(orig.text||'').length > 80 ? '…' : ''}</span>
                        </div>
                      );
                    })()}
                    {isFirst ? (
                      <span style={{ cursor: 'pointer' }} onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        window.dispatchEvent(new CustomEvent('dilla:open-profile', {
                          detail: { memberId: author.id || g.author, x: r.right + 8, y: r.top }
                        }));
                      }}><Avatar member={author} /></span>
                    ) : (
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', right: 6, top: 4, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-3)', opacity: 0 }}
                              className="hover-time">{timeShort(m.at)}</span>
                      </div>
                    )}
                    <div>
                      {isFirst && (
                        <div className="head">
                          <span className="author"
                                onClick={(e) => {
                                  const r = e.currentTarget.getBoundingClientRect();
                                  window.dispatchEvent(new CustomEvent('dilla:open-profile', {
                                    detail: { memberId: author.id || g.author, x: r.left, y: r.bottom + 4 }
                                  }));
                                }}>{author.name}</span>
                          <span className="at">{timeShort(m.at)}</span>
                          {m.author === currentUserId() && (() => {
                            // Render a real tooltip on the ack glyph. We
                            // don't have per-user read receipts yet, but
                            // we DO know the message reached the server
                            // (echoed back with a server-assigned id —
                            // optimistic locals are prefixed 'new-'). Show
                            // "Sending…" for optimistic, "Delivered" once
                            // the echo lands, with the server timestamp.
                            const isLocal = typeof m.id === 'string' && m.id.startsWith('new-');
                            const tip = isLocal
                              ? 'Sending…'
                              : `Delivered · ${m.at instanceof Date ? m.at.toLocaleString() : ''}`;
                            return (
                              <span className="msg-seen" title={tip}>
                                <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
                                  <title>{tip}</title>
                                  <path d="M1 5l3 3 6-6M5 5l3 3 5-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </span>
                            );
                          })()}
                          {author.role === 'admin' && <span className="enc-badge" style={{ fontSize: 9, padding: '1px 5px' }}>admin</span>}
                          {isPinned && (
                            <span
                              className="msg-pin-chip"
                              title="Pinned to this channel — open the pin pop to see all pins"
                              onClick={() => setPinnedOpen(true)}
                            >
                              <Icon.Pin size={11} />
                            </span>
                          )}
                        </div>
                      )}
                      {isPinned && !isFirst && (
                        <span
                          className="msg-pin-chip msg-pin-chip-compact"
                          title="Pinned to this channel"
                          onClick={() => setPinnedOpen(true)}
                        >
                          <Icon.Pin size={11} />
                        </span>
                      )}
                      <div className="body">
                        {editingId === m.id ? (
                          <div className="msg-edit">
                            <textarea autoFocus value={editDraft}
                                      onChange={e => setEditDraft(e.target.value)}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                                        if (e.key === 'Escape') setEditingId(null);
                                      }}
                                      rows={Math.min(6, (editDraft.match(/\n/g) || []).length + 1)} />
                            <div className="msg-edit-actions">
                              <button onClick={() => setEditingId(null)}>Cancel · esc</button>
                              <button className="primary" onClick={saveEdit} disabled={!editDraft.trim()}>Save · ↵</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {m.kind === 'image' && m.text && <div style={{ marginBottom: 4 }}>{renderText(m.text, members)}</div>}
                            {m.kind === 'image' && (
                              <div className="attach">
                                {m.attachment?.src ? (
                                  <img
                                    className="attach-img"
                                    src={m.attachment.src}
                                    alt={m.attachment.label || ''}
                                    onClick={() => setLightboxSrc(m.attachment.src)}
                                    style={{ display: 'block', maxWidth: 360, maxHeight: 280, objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
                                  />
                                ) : (
                                  <div className="attach-img" style={{ background: m.attachment?.tint }}></div>
                                )}
                                <div className="attach-name">
                                  {m.attachment?.label}
                                  {m.attachment?.size != null && ` · ${Math.max(1, Math.round(m.attachment.size / 1024))} KB`}
                                </div>
                              </div>
                            )}
                            {m.kind === 'file' && (
                              // Compact one-row card for non-image attachments.
                              // The 360×280 placeholder we had before looked
                              // identical to a 4K photo's tile — confusing for
                              // small files. <a download> triggers the browser
                              // download path against the existing attachment
                              // URL (already authorized for team members).
                              <a
                                className="attach-file"
                                href={m.attachment?.src}
                                download={m.attachment?.label || 'file'}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span className="attach-file-icon"><Icon.File size={16} /></span>
                                <span className="attach-file-meta">
                                  <span className="attach-file-name">{m.attachment?.label || 'file'}</span>
                                  {m.attachment?.size != null && (
                                    <span className="attach-file-size">{Math.max(1, Math.round(m.attachment.size / 1024))} KB</span>
                                  )}
                                </span>
                                <span className="attach-file-action" title="Download">
                                  <Icon.Download size={14} />
                                </span>
                              </a>
                            )}
                            {m.kind === 'text' && renderText(m.text, members)}
                            {m.kind === 'action' && (
                              <span className="msg-action">
                                <em>* {author.name} {m.text}</em>
                              </span>
                            )}
                            {m.kind === 'poll' && (
                              <div className="msg-poll">
                                <div className="poll-q">{m.question}</div>
                                {(() => {
                                  const total = m.options.reduce((s, o) => s + (o.votes || 0), 0) || 1;
                                  // Seed each poll's color sequence from a
                                  // hash of its id so colors stay stable
                                  // across reloads and matching options.
                                  const seed = [...String(m.id || '')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 0);
                                  return m.options.map((o, oi) => {
                                    const hue = (seed + Math.round((360 / m.options.length) * oi)) % 360;
                                    const dot = `hsl(${hue} 65% 55%)`;
                                    const bar = `hsl(${hue} 60% 50% / 0.5)`;
                                    return (
                                      <div key={oi}
                                           className={'poll-opt' + (o.mine ? ' mine' : '')}
                                           onClick={() => onVote && onVote(m.id, oi)}>
                                        <div className="poll-bar" style={{ width: ((o.votes || 0) / total * 100) + '%', background: bar }} />
                                        <span className="poll-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: '0 0 auto' }} />
                                          {o.label}
                                        </span>
                                        <span className="poll-count">{o.votes || 0}</span>
                                      </div>
                                    );
                                  });
                                })()}
                                <div className="poll-foot">click to vote · {m.options.reduce((s, o) => s + (o.votes || 0), 0)} votes</div>
                              </div>
                            )}
                            {m.kind === 'text' && detectUnfurls(m.text).map((u, ui) => (
                              <Unfurl key={ui} url={u.url} host={u.host} />
                            ))}
                            {m.edited && <span className="msg-edited" title={'edited ' + (m.editedAt ? timeShort(new Date(m.editedAt)) : '')}>(edited)</span>}
                          </>
                        )}
                      </div>
                      {m.reactions && m.reactions.length > 0 && (
                        <div className="rxns">
                          {m.reactions.map((r, ri) => (
                            <span key={ri}
                                  className={'rxn' + (r.mine ? ' mine' : '')}
                                  title={r.mine ? 'click to remove' : 'click to add yours'}
                                  onClick={() => onReact && onReact(m.id, r.e)}>
                              <span>{r.e}</span><span>{r.n}</span>
                            </span>
                          ))}
                          <span className="rxn rxn-add"
                                title="Add reaction"
                                onClick={(e) => {
                                  const anchor = e.currentTarget.getBoundingClientRect();
                                  setPicker({ open: true, anchor, target: 'react:' + m.id });
                                }}>
                            <Icon.Emoji size={11} />
                          </span>
                        </div>
                      )}
                      {m.thread && (
                        <div className="thread-preview"
                             onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-thread', {
                               detail: { channelId: channel.id, messageId: m.id }
                             }))}>
                          <div className="thread-stack">
                            {m.thread.participants.map(pid => {
                              const p = members.byId[pid];
                              return <div key={pid} className={memberAvatarClass(p, 'avatar')} style={memberAvatarStyle(p)}>{!p.avatarUrl && p.initials}</div>;
                            })}
                          </div>
                          <span style={{ fontWeight: 600 }}>{m.thread.count} replies</span>
                          <span style={{ color: 'var(--fg-3)' }}>· last {timeShort(m.thread.lastReplyAt)}</span>
                        </div>
                      )}
                    </div>
                    <div className="msg-tools">
                      <button title="Add reaction"
                              onClick={(e) => {
                                const anchor = e.currentTarget.getBoundingClientRect();
                                setPicker({ open: true, anchor, target: 'react:' + m.id });
                              }}>
                        <Icon.Emoji size={13} />
                      </button>
                      <button title="Reply"
                              onClick={() => {
                                if (onSetReply) onSetReply(m.id);
                                if (textareaRef.current) textareaRef.current.focus();
                              }}>
                        <Icon.Reply size={12} />
                      </button>
                      <button title="Open thread"
                              onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-thread', {
                                detail: { channelId: channel.id, messageId: m.id }
                              }))}>
                        <Icon.Thread size={13} />
                      </button>
                      {m.author === currentUserId() && (
                        <button title="Edit"
                                onClick={() => { setEditingId(m.id); setEditDraft(m.text || ''); }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M11.5 1.5l3 3L5 14H2v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                      {m.author === currentUserId() && (
                        <button title="Delete"
                                onClick={() => setDeleteConfirm(m.id)}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>

      <div className="composer-wrap">
        {showJump && (
          <button className="jump-btn" onClick={scrollToBottom} title="Jump to latest">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            scroll to latest
          </button>
        )}
        {replyTo && (() => {
          const orig = messages.find(om => om.id === replyTo);
          if (!orig) return null;
          const oa = members.byId[orig.author] || { name: orig.author, color: '#666', initials: '??' };
          return (
            <div className="reply-chip">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              <span className="rc-label">Replying to</span>
              <span className="rc-av" style={{ background: oa.color }}>{oa.initials}</span>
              <span className="rc-author">{oa.name}</span>
              <span className="rc-text">{(orig.text || '').slice(0, 90)}{(orig.text||'').length > 90 ? '…' : ''}</span>
              <button className="rc-x" onClick={() => onSetReply && onSetReply(null)} title="Cancel reply (esc)">×</button>
            </div>
          );
        })()}
        {uploads.length > 0 && (
          <div className="upload-tray">
            {uploads.map(u => (
              <div key={u.id} className="upload-row">
                <div className="up-icon"><Icon.Shield size={12} /></div>
                <div className="up-body">
                  <div className="up-name">{u.name}</div>
                  <div className="up-bar">
                    <div className="up-fill" style={{ width: u.progress + '%' }} />
                  </div>
                  <div className="up-meta">
                    <span className="up-phase">{u.phase}</span>
                    <span>·</span>
                    <span>{Math.round((u.size / 1024) * (u.progress / 100))} / {Math.round(u.size / 1024)} KB</span>
                    <span>·</span>
                    <span>{u.progress}%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="composer">
          <div className="composer-input">
            <button className="icon-btn comp-btn" title="Attach a file or image" onClick={openFilePicker}><Icon.Attach size={15} /></button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                handleFiles(files);
                // Reset so re-selecting the same file fires onChange again.
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            />
            <div className="composer-textwrap">
              {mention && mentionMatches.length > 0 && (
                <div className="mention-pop">
                  <div className="mention-head">members in this kanal · ↑↓ navigate · ⇥/↵ pick · esc cancel</div>
                  {mentionMatches.map((m, i) => (
                    <div key={m.id}
                         className={'mention-row' + (i === mentionIdx ? ' selected' : '')}
                         onMouseEnter={() => setMentionIdx(i)}
                         onMouseDown={(e) => { e.preventDefault(); applyMention(m.name); }}>
                      <div className={memberAvatarClass(m, 'mention-av')} style={memberAvatarStyle(m)}>{!m.avatarUrl && m.initials}</div>
                      <div className="mention-name">{m.name}</div>
                      {m.custom && <div className="mention-status">{m.custom}</div>}
                      <div className="mention-presence"><span className={'presence ' + m.status}></span></div>
                    </div>
                  ))}
                </div>
              )}
              {slash && slashMatches.length > 0 && (
                <div className="mention-pop slash-pop" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <div className="mention-head">slash commands · ↑↓ navigate · ⇥/↵ pick · esc cancel</div>
                  {slashMatches.map((s, i) => (
                    <div key={s.cmd}
                         ref={(el) => { if (el && i === slashIdx) el.scrollIntoView({ block: 'nearest' }); }}
                         className={'slash-row' + (i === slashIdx ? ' selected' : '')}
                         onMouseEnter={() => setSlashIdx(i)}
                         onMouseDown={(e) => { e.preventDefault(); applySlash(s); }}>
                      <div className="slash-cmd">{s.cmd}</div>
                      {s.args && <div className="slash-args">{s.args}</div>}
                      <div className="slash-desc">{s.desc}</div>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                placeholder={slowModeLock
                  ? `Slow mode — wait ${slowModeLock.secondsLeft}s before posting again`
                  : (channel.type === 'dm' ? `Message ${channel.name}` : `Message #${channel.name}`)}
                disabled={!!slowModeLock}
                value={draft}
                onChange={e => {
                  const v = e.target.value;
                  setDraft(v);
                  const pos = e.target.selectionStart;
                  const before = v.slice(0, pos);
                  const mm = before.match(/(?:^|\s)@(\w*)$/);
                  const sm = before.match(/^\/(\w*)$/);
                  if (mm) { setMention({ query: mm[1].toLowerCase() }); setMentionIdx(0); setSlash(null); }
                  else if (sm) { setSlash({ query: sm[1].toLowerCase() }); setSlashIdx(0); setMention(null); }
                  else { setMention(null); setSlash(null); }
                }}
                onKeyDown={e => {
                  if (mention && mentionMatches.length > 0) {
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault();
                      applyMention(mentionMatches[mentionIdx].name);
                      return;
                    }
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => Math.min(mentionMatches.length - 1, i + 1)); return; }
                    if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIdx(i => Math.max(0, i - 1)); return; }
                    if (e.key === 'Escape')    { e.preventDefault(); setMention(null); return; }
                  }
                  if (slash && slashMatches.length > 0) {
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault();
                      applySlash(slashMatches[slashIdx]);
                      return;
                    }
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => Math.min(slashMatches.length - 1, i + 1)); return; }
                    if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx(i => Math.max(0, i - 1)); return; }
                    if (e.key === 'Escape')    { e.preventDefault(); setSlash(null); return; }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (draft.trim()) onSend();
                  }
                  // Empty-draft ArrowUp loads the most recent message you
                  // sent in this channel for editing — matches the Slack /
                  // Discord pattern. Skip when the autocomplete popups are
                  // active (they own ArrowUp above) or when there's already
                  // text the user might be navigating.
                  if (e.key === 'ArrowUp' && !mention && !slash && !draft) {
                    const mine = currentUserId();
                    for (let i = messages.length - 1; i >= 0; i--) {
                      const m: any = messages[i];
                      if (m.author === mine && (m.kind === 'text' || m.kind === 'action' || !m.kind) && typeof m.text === 'string') {
                        e.preventDefault();
                        setEditingId(m.id);
                        setEditDraft(m.text);
                        return;
                      }
                    }
                  }
                }}
                rows={1}
              />
            </div>
            <div className="composer-tools">
              <button ref={emojiBtnRef} className="icon-btn comp-btn" title="Add an emoji"
                      onClick={() => {
                        const anchor = emojiBtnRef.current ? emojiBtnRef.current.getBoundingClientRect() : null;
                        setPicker(p => p.open && p.target === 'draft' ? { ...p, open: false } : { open: true, anchor, target: 'draft' });
                      }}>
                <Icon.Emoji size={15} />
              </button>
            </div>
            <button
              className="send-btn"
              disabled={!draft.trim() || !!slowModeLock}
              onClick={onSend}
              title={slowModeLock ? `Slow mode — ${slowModeLock.secondsLeft}s remaining` : 'Send (↵)'}
            >
              <Icon.Send size={14} />
            </button>
          </div>
          <div className="composer-typing">
            {slowModeLock ? (
              <span style={{ opacity: 0.8 }}>
                <Icon.Lock size={10} /> Slow mode — {slowModeLock.secondsLeft}s before you can post again
              </span>
            ) : typing.length > 0 ? (
              <>{typing.join(', ')} {typing.length === 1 ? 'is' : 'are'} typing<span className="dot">.</span><span className="dot">.</span><span className="dot">.</span></>
            ) : (
              <span style={{ opacity: 0.6 }}>
                <Icon.Shield size={10} /> messages are end-to-end encrypted with Signal Protocol
              </span>
            )}
          </div>
        </div>
      </div>
      <EmojiPicker
        open={picker.open}
        anchorRect={picker.anchor}
        onClose={() => setPicker(p => ({ ...p, open: false }))}
        onPick={(e) => {
          if (picker.target === 'draft') {
            setDraft(draft + e);
          } else if (picker.target.startsWith('react:')) {
            const msgId = picker.target.slice(6);
            if (onReact) onReact(msgId, e);
          }
          setPicker(p => ({ ...p, open: false }));
        }}
      />
      {forwardId && (() => {
        const m = messages.find(x => x.id === forwardId);
        if (!m) return null;
        return (
          <ForwardModal
            sourceMsg={m}
            members={members}
            onClose={() => setForwardId(null)}
            onForward={(target) => {
              const ch = (members.byId[target.slice(3)] && target.startsWith('dm-')) ? target : target;
              const name = target.startsWith('dm-') ? members.byId[target.slice(3)]?.name : ('#' + target);
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: target.startsWith('dm-') ? null : target, author: 'system', text: 'Forwarded message to ' + name + '.', duration: 3000 } }));
              setForwardId(null);
            }}
          />
        );
      })()}
      {contextMenu && (
        <div className="ctx-overlay" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}>
          <div className="ctx-menu"
               style={{ left: Math.min(contextMenu.x, window.innerWidth - 220), top: Math.min(contextMenu.y, window.innerHeight - 320) }}
               onClick={e => e.stopPropagation()}>
            <button onClick={(e) => {
              const anchor = e.currentTarget.getBoundingClientRect();
              setPicker({ open: true, anchor, target: 'react:' + contextMenu.msgId });
              setContextMenu(null);
            }}>
              <Icon.Emoji size={13} /> Add reaction
            </button>
            <button onClick={() => {
              window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: channel.id, messageId: contextMenu.msgId } }));
              setContextMenu(null);
            }}>
              <Icon.Thread size={13} /> Reply in thread
            </button>
            <button><Icon.Reply size={12} /> Quote reply</button>
            <button onClick={() => {
              const wasIn = savedMsgs.has(contextMenu.msgId);
              setSavedMsgs(prev => {
                const next = new Set(prev);
                if (next.has(contextMenu.msgId)) next.delete(contextMenu.msgId);
                else next.add(contextMenu.msgId);
                return next;
              });
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'saved', text: wasIn ? 'Removed from saved messages.' : 'Saved. Find it in your bookmarks.', duration: 2200 } }));
              setContextMenu(null);
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l4-3 4 3V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              {savedMsgs.has(contextMenu.msgId) ? 'Remove bookmark' : 'Save message'}
            </button>
            <button onClick={() => { setForwardId(contextMenu.msgId); setContextMenu(null); }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 8h11l-3-3M13 8l-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Forward to…
            </button>
            {msgPerms.has(PERM_MANAGE_MESSAGES) && (
              <>
                <div className="ctx-sep" />
                <button onClick={() => {
                  const teamId = useTeamStore.getState().activeTeamId;
                  const ps = usePinStore.getState();
                  const already = ps.isPinned(channel.id, contextMenu.msgId);
                  // Optimistic flip so the icon updates instantly; rollback
                  // on failure. The server echoes message:pin-update which
                  // converges every other client.
                  if (already) ps.unpin(channel.id, contextMenu.msgId); else ps.pin(channel.id, contextMenu.msgId);
                  if (teamId && !isMockSession()) {
                    const call = already
                      ? api.unpinMessage(teamId, channel.id, contextMenu.msgId)
                      : api.pinMessage(teamId, channel.id, contextMenu.msgId);
                    call.catch((err) => {
                      if (already) ps.pin(channel.id, contextMenu.msgId); else ps.unpin(channel.id, contextMenu.msgId);
                      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'pins', text: (err as Error).message || 'Pin failed — manage-messages permission required.', duration: 3500 } }));
                    });
                  } else if (isMockSession() && teamId) {
                    // Keep mockApi store in sync with the UI store on /mesh.
                    (already
                      ? api.unpinMessage(teamId, channel.id, contextMenu.msgId)
                      : api.pinMessage(teamId, channel.id, contextMenu.msgId)
                    ).catch(() => {});
                  }
                  setContextMenu(null);
                }}>
                  <Icon.Pin size={13} />
                  {usePinStore.getState().isPinned(channel.id, contextMenu.msgId) ? 'Unpin from channel' : 'Pin to channel'}
                </button>
              </>
            )}
            <button onClick={() => {
              setUnreadAt(contextMenu.msgId);
              // Roll the read watermark back to the message *before* the
              // selected one so the sidebar pill reflects the unread span
              // and the server agrees on reload. We use the previous
              // message id (or empty if it's the first), and count messages
              // from-here-onwards that aren't ours as the local pill count
              // — server will recompute on next sync:init, but updating
              // locally avoids a flicker while the WS round-trips.
              const all = messages || [];
              const idx = all.findIndex((m) => m.id === contextMenu.msgId);
              if (idx >= 0) {
                const myId = data?.currentUserId;
                const fromHere = all.slice(idx).filter((m) => m.author !== myId).length;
                useUnreadStore.setState((s) => ({
                  counts: { ...s.counts, [channel.id]: fromHere },
                }));
                const teamId = useTeamStore.getState().activeTeamId;
                const prevId = idx > 0 ? all[idx - 1].id : '';
                if (teamId && !isMockSession()) {
                  // Sending an empty string would store "" as the watermark
                  // message, which the server treats as "never read"; that's
                  // actually the right behaviour for "mark from the very
                  // first message", so let it through.
                  try { ws.markChannelRead(teamId, channel.id, prevId); } catch { /* ignore */ }
                }
              }
              setContextMenu(null);
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Mark unread from here
            </button>
            <button onClick={() => {
              {(() => {
                const host = data?.SERVERS?.[0]?.node || 'local';
                navigator.clipboard?.writeText(`dilla://${host}/channels/${channel.id}/messages/${contextMenu.msgId}`);
              })()}
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { kind: 'message', channel: channel.name, author: 'system', text: 'Link copied to clipboard.', duration: 3000 } }));
              setContextMenu(null);
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>
              Copy link to message
            </button>
            {contextMenu.isMine && <div className="ctx-sep" />}
            {contextMenu.isMine && (
              <button onClick={() => {
                const msg = messages.find(m => m.id === contextMenu.msgId);
                if (msg) { setEditingId(msg.id); setEditDraft(msg.text || ''); }
                setContextMenu(null);
              }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                Edit message
              </button>
            )}
            {contextMenu.isMine && (
              <button className="danger" onClick={() => { setDeleteConfirm(contextMenu.msgId); setContextMenu(null); }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Delete message
              </button>
            )}
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-overlay modal-overlay--soft" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="cd-head">
              <div className="cd-icon">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h3>Delete message?</h3>
                <p>This removes it for everyone in the kanal. Other peer nodes will be told to drop it on their next sync.</p>
              </div>
            </div>
            <blockquote className="cd-preview">{deleteTarget.text}</blockquote>
            <div className="cd-actions">
              <button className="cd-btn" onClick={() => setDeleteConfirm(null)}>Cancel · esc</button>
              <button className="cd-btn danger" autoFocus
                      onClick={() => {
                        if (onDelete) onDelete(deleteConfirm);
                        setDeleteConfirm(null);
                      }}>Delete · ↵</button>
            </div>
          </div>
        </div>
      )}
      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 500,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 32, cursor: 'zoom-out',
            backdropFilter: 'blur(2px)',
          }}
        >
          <img
            src={lightboxSrc}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '95vw', maxHeight: '95vh', objectFit: 'contain', borderRadius: 4 }}
          />
          {/* Download button — fixed top-right of the overlay. <a download>
              picks the filename from the URL when our attachment URL
              already encodes the name; if it doesn't, the browser falls
              back to the response Content-Disposition. */}
          <a
            href={lightboxSrc}
            download
            onClick={(e) => e.stopPropagation()}
            title="Download image"
            style={{
              position: 'absolute', top: '1rem', right: '1rem',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: '2.5rem', height: '2.5rem',
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.12)',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.2)',
              cursor: 'pointer',
              backdropFilter: 'blur(4px)',
            }}
          >
            <Icon.Download size={18} />
          </a>
        </div>
      )}
    </div>
  );
}

function renderText(text, _members) {
  if (!text) return null;
  // Delegate to react-markdown via MessageMarkdown — gives us bold,
  // italic, strikethrough, lists, blockquotes, code fences, tables,
  // links and inline images, plus the @mention chip that renderText
  // used to hand-roll. Headings are disallowed (chat-bubble context).
  const me = (window as { SHELL_DATA?: { byId?: Record<string, { name?: string; username?: string }>; currentUserId?: string } }).SHELL_DATA;
  const myId = me?.currentUserId ?? null;
  const myRec = myId ? me?.byId?.[myId] : null;
  const myHandle = myRec?.username || myRec?.name || null;
  return <MessageMarkdown text={text} currentUserId={myId} currentUserHandle={myHandle} />;
}

// Mock unfurl content keyed by hostname — Dilla repo + a couple of others.
function mockUnfurl(host, url) {
  if (host.includes('github.com')) {
    if (url.includes('/pull/')) return {
      title: 'PR #47 · voice-dock: tighten audio meter polling',
      desc: '6 commits into main. +112 −38.',
      kind: 'github',
      meta: 'github · 6 commits · 4 files',
    };
    return {
      title: 'dilla-chat/dilla-chat',
      desc: 'Self-hosted, end-to-end encrypted chat — built in Gothenburg.',
      kind: 'github',
      meta: 'github · rust + react · agpl-3.0',
    };
  }
  if (host.includes('figma.com')) return {
    title: 'channel-list refinements · v3',
    desc: 'last edited by mira · 4 frames',
    kind: 'figma',
    meta: 'figma',
  };
  return { title: url.replace(/^https?:\/\//, ''), desc: '', kind: 'web', meta: host };
}
function Unfurl({ url, host }) {
  const info = mockUnfurl(host, url);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={'unfurl unfurl-' + info.kind}>
      <div className="uf-side" />
      <div className="uf-body">
        <div className="uf-host">{info.meta}</div>
        <div className="uf-title">{info.title}</div>
        {info.desc && <div className="uf-desc">{info.desc}</div>}
      </div>
    </a>
  );
}
function detectUnfurls(text) {
  if (!text) return [];
  // Skip URLs inside triple-backtick code fences
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const re = /https?:\/\/([^\s/?#)]+)([^\s)]*)?/g;
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    // Direct image URLs are already inline via renderText — skip the
    // unfurl card so /giphy doesn't render an image AND a generic card.
    const path = m[0].split('?')[0].toLowerCase();
    if (/\.(gif|png|jpe?g|webp|avif)$/.test(path)) continue;
    out.push({ url: m[0], host: m[1] });
    if (out.length >= 2) break;
  }
  return out;
}

// ───────────── main pane: voice channel ─────────────
function VoiceChannel({ channel, members, voiceConnection, onJoin, onLeave, mute, setMute, deaf, setDeaf, cam, setCam, screen, setScreen, rich, membersOpen, onToggleMembers }) {
  const nodes = (window.MeshChrome && window.MeshChrome.MEMBER_NODES) || {};
  const participants = (channel.participants || []).map(id => members.byId[id]);
  const isConnected = voiceConnection && voiceConnection.channelId === channel.id;
  const meIsAdmin = !!members?.byId?.[currentUserId()]?.isAdmin;
  const lockedForMe = !!channel.locked && !meIsAdmin;
  // Focused stream: a tuple of (participant_id, 'cam' | 'screen'). Tracking
  // the kind separately lets you focus the webcam alone, the screen alone,
  // or swap between them — previously a participant with both shared their
  // screen with the webcam stuck as a small PIP that couldn't be promoted.
  const [focused, setFocused] = useState<{ id: string; kind: 'cam' | 'screen' } | null>(null);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const [volumes, setVolumes] = useState({}); // memberId -> 0..100
  function vol(id) { return volumes[id] === undefined ? 100 : volumes[id]; }
  const focusedMember = focused ? participants.find(p => p.id === focused.id) : null;
  // Strip shows all participants (including the focused one) for context.
  const others = focused ? participants : [];

  useEffect(() => {
    if (!focused) return;
    function onKey(e) { if (e.key === 'Escape') setFocused(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  // Fullscreen the focused stage. Uses the browser Fullscreen API and
  // bails silently if the user denies the request or fullscreen isn't
  // available (e.g. iOS Safari which is restrictive on non-video els).
  function enterFullscreen() {
    const el = focusRef.current;
    if (!el) return;
    const req = (el as any).requestFullscreen || (el as any).webkitRequestFullscreen;
    if (!req) return;
    req.call(el).catch((err: unknown) => console.warn('[voice] fullscreen failed', err));
  }
  // Per-peer voice state from voice:mute-update / voice:rooms-snapshot.
  // Keyed by user_id within this channel. We look peers up here so the
  // tiles can show each remote user's actual mute/deafen state instead
  // of just our own.
  const channelOccupants = useVoiceStore((s) => s.voiceOccupants[channel.id]);
  // Stream-existence subscriptions so cardFor can fall back to the avatar
  // when a peer is flagged as sharing but we have no track to render
  // (e.g. when watching from outside the voice channel — the SFU hasn't
  // forwarded the screen track to us). Without this guard ScreenTile
  // renders its placeholder mockup instead.
  const localScreenStream = useVoiceStore((s) => s.localScreenStream);
  const remoteScreenStream = useVoiceStore((s) => s.remoteScreenStream);
  const localWebcamStream = useVoiceStore((s) => s.localWebcamStream);
  const remoteWebcamStreams = useVoiceStore((s) => s.remoteWebcamStreams);
  // Per-peer sharing flags so we can hide tiles when a peer toggles
  // a track off (the underlying stream is intentionally kept alive
  // in the store across toggles — see voice:webcam-update handler).
  const voicePeers = useVoiceStore((s) => s.peers);

  // Keep the focused stage useful as the underlying streams change:
  //   - both gone → exit focus (nothing to show)
  //   - focused kind gone, other kind still live → flip focus to it
  //   - focused kind still live → no change
  // Same liveness gating as the showCam/showScreen rule in cardFor.
  useEffect(() => {
    if (!focused) return;
    const isSelf = focused.id === currentUserId();
    const peerVoice = !isSelf ? voicePeers?.[focused.id] : null;
    const camLive = isSelf
      ? !!(cam && localWebcamStream)
      : !!(peerVoice?.webcam_sharing && remoteWebcamStreams?.[focused.id]);
    const screenLive = isSelf
      ? !!(screen && localScreenStream)
      : !!(peerVoice?.screen_sharing && remoteScreenStream);
    if (!camLive && !screenLive) {
      setFocused(null);
      return;
    }
    if (focused.kind === 'cam' && !camLive && screenLive) {
      setFocused({ id: focused.id, kind: 'screen' });
    } else if (focused.kind === 'screen' && !screenLive && camLive) {
      setFocused({ id: focused.id, kind: 'cam' });
    }
  }, [
    focused,
    voicePeers,
    cam,
    screen,
    localWebcamStream,
    localScreenStream,
    remoteWebcamStreams,
    remoteScreenStream,
  ]);
  return (
    <div className="main">
      {false && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-glyph"><Icon.Attach size={36} /></div>
            <div className="drop-title">Drop to attach</div>
            <div className="drop-sub">files are encrypted on this device before upload · Signal sender keys for {channel.type === 'dm' ? 'this DM' : '#' + channel.name}</div>
          </div>
        </div>
      )}
      <div className="main-head">
        <button className="chat-menu-btn" title="Open menu" onClick={() => window.dispatchEvent(new CustomEvent('dilla:toggle-drawer'))}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ch-title">
          <Icon.Speaker size={15} />
          <span>{channel.name}</span>
          <span className="enc-badge"><Icon.Shield size={10} /> SRTP</span>
        </div>
        <div className="ch-topic">{participants.length} connected</div>
        <div className="head-actions">
          <button className={'icon-btn' + (membersOpen ? '' : ' off')}
                  title={membersOpen ? 'Hide members' : 'Show members'}
                  onClick={onToggleMembers}>
            <Icon.People size={14} />
          </button>
        </div>
      </div>

      <div className="voice-view">
        {(() => {
          function cardFor(p, isMini, focusKind?: 'cam' | 'screen') {
            const speaking = p.id === 'ada' && isConnected;
            // For self, mute/deaf come straight from the local store (synced
            // with webrtcService). For peers, look them up in voiceOccupants
            // which is fed by voice:mute-update and voice:rooms-snapshot.
            const isSelf = p.id === currentUserId();
            const occupant = !isSelf ? channelOccupants?.find((o) => o.user_id === p.id) : null;
            const mineMuted = isSelf ? mute : !!occupant?.muted;
            const mineDeaf = isSelf ? deaf : !!occupant?.deafened;
            const mineCam = isSelf && cam;
            const mineScreen = isSelf && screen;
            // For peers we gate on BOTH the UI flag and the stream
            // being present. The stream now persists across toggles
            // (sender uses replaceTrack for off/on so no new ontrack
            // fires on resume), so the flag is what tells us whether
            // the peer is currently sharing — we keep the stream alive
            // so the existing <video> element resumes when frames
            // come back, without remounting.
            const peerVoice = !isSelf ? voicePeers?.[p.id] : null;
            const peerSharingScreen = !!peerVoice?.screen_sharing;
            const peerSharingCam = !!peerVoice?.webcam_sharing;
            const showScreen = isSelf
              ? mineScreen && !!localScreenStream
              : peerSharingScreen && !!remoteScreenStream;
            const showCam = isSelf
              ? mineCam && !!localWebcamStream
              : peerSharingCam && !!remoteWebcamStreams?.[p.id];
            const node = (nodes[p.id] || '').split('.')[0] || 'local';
            const focusable = showScreen || showCam;
            // In focus mode, render JUST the requested stream. Outside
            // focus, show screen (with PIP webcam) when both are on,
            // otherwise whichever single stream is active.
            const renderKind: 'screen' | 'cam' | 'avatar' = focusKind
              ? focusKind
              : (showScreen ? 'screen' : showCam ? 'cam' : 'avatar');
            return (
              <div key={p.id}
                   className={'voice-card'
                     + (speaking ? ' speaking' : '')
                     + (renderKind === 'screen' ? ' has-screen' : renderKind === 'cam' ? ' has-cam' : '')
                     + (isMini ? ' mini' : '')
                     + (isMini && focused && p.id === focused.id ? ' is-focused' : '')
                     + (focusable && !isMini ? ' focusable' : '')}
                   data-node={node}
                   data-bitrate="96 kbps · opus"
                   onContextMenu={(e) => {
                     e.preventDefault();
                     window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                       { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: p.id, x: e.clientX, y: e.clientY } })) },
                       ...(showScreen ? [{ label: focused?.id === p.id && focused.kind === 'screen' ? 'Exit screen focus' : 'Focus screen share', icon: <Icon.Screen size={13} />, onClick: () => setFocused(focused?.id === p.id && focused.kind === 'screen' ? null : { id: p.id, kind: 'screen' as const }) }] : []),
                       ...(showCam ? [{ label: focused?.id === p.id && focused.kind === 'cam' ? 'Exit webcam focus' : 'Focus webcam', icon: <Icon.Video size={13} />, onClick: () => setFocused(focused?.id === p.id && focused.kind === 'cam' ? null : { id: p.id, kind: 'cam' as const }) }] : []),
                       { sep: true },
                       { label: 'Mute for me only', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'mixer', text: 'Muted ' + p.name + ' for this session only.', duration: 2500 } })) },
                       { label: 'Server-mute (admin)', danger: true, icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Server-mute requires admin role. Propagates across the mesh.', duration: 3500 } })) },
                       { label: 'Disconnect from voice', danger: true, icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Disconnect ' + p.name + ' (admin only).', duration: 3000 } })) },
                     ] } }));
                   }}
                   onClick={() => {
                     // Click the mini strip → return to that stream.
                     if (isMini && focused) { setFocused({ id: p.id, kind: focused.kind }); return; }
                     // Click an already-focused tile → exit focus.
                     if (focused?.id === p.id) { setFocused(null); return; }
                     // Default: focus whichever single stream is showing.
                     if (showScreen) setFocused({ id: p.id, kind: 'screen' });
                     else if (showCam) setFocused({ id: p.id, kind: 'cam' });
                   }}>
                <div className="voice-media">
                  {renderKind === 'screen' ? (
                    // Outside focus mode, render a non-interactive PIP via
                    // ScreenTile's `pip` prop when both streams exist. In
                    // focus mode we render our own clickable PIP overlay
                    // below so the user can swap to the other stream by
                    // clicking it.
                    <ScreenTile member={p} pip={showCam && !focusKind ? p : null} />
                  ) : renderKind === 'cam' ? (
                    <CamTile member={p} />
                  ) : (
                    <Avatar member={p} size={isMini ? 32 : 64} />
                  )}
                  {/* Clickable swap PIP — only shown in focus mode when
                      the participant has BOTH streams. Click the PIP to
                      swap focus to the other stream. The pip shows the
                      OPPOSITE kind of what's currently focused: if you're
                      focused on the screen, the pip is the webcam (and
                      vice versa). */}
                  {focusKind && !isMini && showCam && showScreen && (
                    // div+role rather than <button> because <video>
                    // inside a <button> is invalid HTML — some browsers
                    // refuse to play it and render the PIP black.
                    <div
                      className="voice-pip-swap"
                      role="button"
                      tabIndex={0}
                      title={focusKind === 'screen' ? 'Switch to webcam' : 'Switch to screen'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFocused({ id: p.id, kind: focusKind === 'screen' ? 'cam' : 'screen' });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          setFocused({ id: p.id, kind: focusKind === 'screen' ? 'cam' : 'screen' });
                        }
                      }}
                    >
                      {focusKind === 'screen'
                        ? <CamTile member={p} mini />
                        : <ScreenTile member={p} pip={null} />}
                    </div>
                  )}
                </div>
                <div className="v-name">{p.name}</div>
                {!isMini && <div className="v-state">
                  {mineMuted ? <><Icon.Mic size={10} off /> <span className="v-mic-off">muted</span></> :
                    speaking ? <><span style={{ color: 'var(--accent)' }}>● speaking</span></> :
                    <><Icon.Mic size={10} /> connected</>}
                </div>}
                <div className="v-badges">
                  {mineMuted && <span className="v-badge danger" title="muted"><Icon.Mic size={11} off /></span>}
                  {mineDeaf && <span className="v-badge danger" title="deafened"><Icon.Headphones size={11} off /></span>}
                  {showCam && <span className="v-badge ok" title="camera on"><Icon.Video size={11} /></span>}
                  {showScreen && <span className="v-badge ok" title="sharing screen"><Icon.Screen size={11} /></span>}
                  <span className="v-badge nq" title="network quality">
                    {[0,1,2,3].map(i => (
                      // Heights chosen so the tallest bar matches the
                      // 11px Icon.Video / Icon.Screen glyph the sibling
                      // .v-badge.ok renders — previously bars topped out
                      // at 9px which made the nq badge look visibly
                      // shorter than the rest of the row.
                      <span key={i} className="nq-bar" style={{ height: 4 + i * 3, opacity: i < 3 ? 1 : 0.4 }} />
                    ))}
                  </span>
                </div>
                {!isMini && p.id !== currentUserId() && (
                  <div className="v-volume" onClick={(e) => e.stopPropagation()}>
                    <Icon.Headphones size={10} />
                    <input type="range" min={0} max={100} value={vol(p.id)}
                           onChange={(e) => setVolumes(v => ({ ...v, [p.id]: parseInt(e.target.value, 10) }))} />
                    <span className="v-volume-val">{vol(p.id)}</span>
                  </div>
                )}
                {!isMini && focusable && !focused && (
                  <button className="voice-expand" title="Expand"
                          onClick={(e) => { e.stopPropagation(); setFocusedId(p.id); }}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M9 2h5v5M14 2l-5 5M7 14H2V9M2 14l5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
            );
          }

          if (focused && focusedMember) {
            // Does the focused participant have BOTH streams? If so, show
            // a toggle so they can swap focus without backing out first.
            const fm = focusedMember as any;
            const isSelf = fm.id === currentUserId();
            const hasCam = isSelf ? cam : false; // peer streams TODO via voiceOccupants flags
            const hasScreen = isSelf ? screen : false;
            const showSwap = (focused.kind === 'cam' && hasScreen) || (focused.kind === 'screen' && hasCam);
            return (
              <>
                <div className="voice-focus" ref={focusRef}>
                  <div className="voice-focus-actions">
                    {showSwap && (
                      <button className="voice-unfocus" onClick={() => setFocused({ id: focused.id, kind: focused.kind === 'cam' ? 'screen' : 'cam' })} title={focused.kind === 'cam' ? 'Switch to screen' : 'Switch to webcam'}>
                        {focused.kind === 'cam' ? <Icon.Screen size={14} /> : <Icon.Video size={14} />}
                        {focused.kind === 'cam' ? 'screen' : 'webcam'}
                      </button>
                    )}
                    {focused.kind === 'screen' && (
                      <button className="voice-unfocus" onClick={enterFullscreen} title="Fullscreen (f)">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                          <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        fullscreen
                      </button>
                    )}
                    <button className="voice-unfocus" onClick={() => setFocused(null)} title="Exit focus (esc)">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M2 2h5v5M7 2L2 7M14 9v5h-5M14 14l-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      exit focus
                    </button>
                  </div>
                  {cardFor(focusedMember, false, focused.kind)}
                </div>
                <div className="voice-strip">
                  {others.map(p => cardFor(p, true))}
                </div>
              </>
            );
          }
          return (
            <div className="voice-stage">
              {participants.length === 0 && (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--fg-2)', marginBottom: 8 }}>
                    {lockedForMe ? 'Locked channel' : 'Quiet here'}
                  </div>
                  <div>
                    {lockedForMe ? (
                      <>Only members with manage-channels can join <strong>#{channel.name}</strong>.</>
                    ) : (
                      <>Click <em>Join</em> to be the first in <strong>#{channel.name}</strong>.</>
                    )}
                  </div>
                </div>
              )}
              {participants.map(p => cardFor(p, false))}
            </div>
          );
        })()}

        <div className="voice-controls-bar">
          {isConnected ? (
            <button className="ctrl danger" onClick={onLeave} title="Disconnect">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor"/></svg>
            </button>
          ) : (
            <button
              className="ctrl"
              style={{
                background: lockedForMe ? 'var(--surface-hi)' : 'var(--accent)',
                color: lockedForMe ? 'var(--fg-3)' : 'var(--accent-ink)',
                borderColor: lockedForMe ? 'var(--hairline)' : 'var(--accent)',
                cursor: lockedForMe ? 'not-allowed' : 'pointer',
              }}
              disabled={lockedForMe}
              title={lockedForMe ? 'Channel is locked' : 'Join voice'}
              onClick={() => { if (!lockedForMe) onJoin(); }}
            >
              {lockedForMe ? 'Locked' : 'Join'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────── member list ─────────────
function MemberList({ members, voiceConnection, rich, federated }) {
  // Resolve the viewer's perms once per render so menu items can hide
  // admin actions for non-admins instead of toasting 'permission required'
  // after a 403. teamMembers comes from the store so role changes flow in
  // without a prop drill.
  const memberListTeamId = useTeamStore((s) => s.activeTeamId);
  const memberListTeamMembers = useTeamStore((s) => (memberListTeamId ? s.members.get(memberListTeamId) ?? [] : [])) as any[];
  const memberPerms = useMemo(
    () => resolvePermissions(memberListTeamMembers, currentUserId()),
    [memberListTeamMembers],
  );
  const data = (useShellDataContext() as any) || MOCK_DATA;
  const teamName = data?.SERVERS?.[0]?.name || '';
  const MC = window.MeshChrome || {};
  const nodes = MC.MEMBER_NODES || {};
  const fps = MC.FINGERPRINTS || {};
  // Group online members by their highest-priority non-default role.
  // Members with no explicit role land under "Online" (the default group).
  // Offline members stay in their own group regardless of role.
  const offline: any[] = [];
  const groupOrder: string[] = []; // role names, ordered by max position desc
  const groupMeta: Record<string, { name: string; color: string; position: number }> = {};
  const groups: Record<string, any[]> = {};
  const onlineDefault: any[] = [];
  members.MEMBERS.forEach((m: any) => {
    if (m.status === 'offline') { offline.push(m); return; }
    const top = (m.roles && m.roles[0]) || null;
    if (!top) { onlineDefault.push(m); return; }
    const key = top.id;
    if (!groups[key]) {
      groups[key] = [];
      groupMeta[key] = { name: top.name, color: top.color, position: top.position ?? 0 };
      groupOrder.push(key);
    }
    groups[key].push(m);
  });
  groupOrder.sort((a, b) => (groupMeta[b].position ?? 0) - (groupMeta[a].position ?? 0));
  const onlineCount = members.MEMBERS.filter((m: any) => m.status !== 'offline').length;

  function Row({ m }) {
    const off = m.status === 'offline';
    const node = nodes[m.id] || '';
    const fed = node && !node.includes('gbg-1');
    return (
      <div className={'member' + (off ? ' offline' : '')}
           onClick={(e) => {
             const r = e.currentTarget.getBoundingClientRect();
             window.dispatchEvent(new CustomEvent('dilla:open-profile', {
               detail: { memberId: m.id, x: r.left - 270, y: r.top }
             }));
           }}
           onContextMenu={(e) => {
             e.preventDefault();
             window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
               { label: 'Send message', icon: <Icon.Chat size={13} />, onClick: () => {
                 window.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: m.id }));
               } },
               { label: 'Mention in current kanal', icon: <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 13 }}>@</span>, onClick: () => {
                 window.dispatchEvent(new CustomEvent('dilla:insert-mention', { detail: m.name }));
               } },
               { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: m.id, x: 200, y: 200 } })) },
               { label: 'Verify safety number', icon: <Icon.Shield size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: m.id })) },
               { sep: true },
               useBlockStore.getState().isBlocked(m.id)
                 ? { label: 'Unblock', icon: <Icon.Shield size={12} />, onClick: async () => {
                     const teamId = useTeamStore.getState().activeTeamId;
                     useBlockStore.getState().unblock(m.id);
                     if (teamId && !isMockSession()) {
                       try { await api.unblockUser(teamId, m.id); }
                       catch { useBlockStore.getState().block(m.id); }
                     }
                   } }
                 : { label: 'Block', danger: true, icon: <Icon.Shield size={12} />, onClick: async () => {
                     if (!(await dillaConfirm({
                       title: 'Block ' + m.name + '?',
                       body: 'You won\'t see their messages or DMs. They aren\'t notified.',
                       confirmLabel: 'Block',
                       danger: true,
                     }))) return;
                     const teamId = useTeamStore.getState().activeTeamId;
                     useBlockStore.getState().block(m.id);
                     if (teamId && !isMockSession()) {
                       try { await api.blockUser(teamId, m.id); }
                       catch { useBlockStore.getState().unblock(m.id); }
                     }
                   } },
               { label: 'Mute', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'system', text: m.name + ' muted in voice channels.', duration: 2200 } })) },
               ...(memberPerms.has(PERM_MANAGE_MEMBERS) && m.id !== currentUserId() ? [
               { label: 'Kick from team', danger: true, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 4V2H3v12h7v-2M6 8h9M12 5l3 3-3 3M9 3v0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>, onClick: async () => {
                 if (!(await dillaConfirm({
                   title: 'Kick ' + m.name + '?',
                   body: 'They\'ll lose access to this team. They can be re-invited. Requires admin role.',
                   confirmLabel: 'Kick',
                   danger: true,
                 }))) return;
                 const teamId = useTeamStore.getState().activeTeamId;
                 if (teamId && !isMockSession()) {
                   api.kickMember(teamId, m.id).then(() => {
                     window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Kicked ' + m.name + ' from the team.', duration: 3000 } }));
                   }).catch((err: unknown) => {
                     console.warn('[ChatApp] kickMember failed', err);
                     window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Kick failed — admin role required.', duration: 3500 } }));
                   });
                 } else {
                   window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Demo only — kick would propagate across the mesh on a live server.', duration: 3000 } }));
                 }
               } },
               { label: 'Ban from team', danger: true, icon: <Icon.Lock size={12} />, onClick: async () => {
                 if (!(await dillaConfirm({
                   title: 'Ban ' + m.name + '?',
                   body: 'Bans prevent re-join via invite — irreversible without admin action.',
                   confirmLabel: 'Ban',
                   danger: true,
                 }))) return;
                 const teamId = useTeamStore.getState().activeTeamId;
                 if (teamId && !isMockSession()) {
                   api.banMember(teamId, m.id).then(() => {
                     window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Banned ' + m.name + ' from the team.', duration: 3500 } }));
                   }).catch((err: unknown) => {
                     console.warn('[ChatApp] banMember failed', err);
                     window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Ban failed — admin role required.', duration: 3500 } }));
                   });
                 } else {
                   window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Demo only — ban would propagate across the mesh on a live server.', duration: 3000 } }));
                 }
               } },
               ] : []),
             ] } }));
           }}>
        <Avatar member={m} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="member-name">{m.name}</div>
          <div className="member-status">{m.custom || m.status}</div>
        </div>
        {rich && fed && federated && (
          <span className="node-tag fed" title={`Account hosted on federated node "${node}" — relayed to gbg-1 over the dilla mesh.`}>
            {node.replace('.io','').replace('.dilla.local','')}
          </span>
        )}
        {rich && fps[m.id] && (
          <div className="member-fingerprint">
            <div style={{ color: 'var(--accent)', marginBottom: 2 }}>SAFETY NUMBER · {node || 'local'}</div>
            {fps[m.id]}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="members">
      {rich && federated && (
        <div className="mesh-summary" title="This team is replicated across 2 server nodes. Members on a peer server are tagged.">
          <div className="screen-row">
            <span className="screen-dot" />
            <span className="ms-label">Mesh</span>
            <span className="ms-sep">·</span>
            <span>2 nodes</span>
          </div>
          <div className="ms-nodes">
            <span className="ms-node">
              <span>gbg-1</span>
              <span className="ms-node-sub">local · {members.MEMBERS.filter(m => (nodes[m.id]||'').includes('gbg-1')).length}</span>
            </span>
            <span className="ms-node">
              <span>rust.berra.io</span>
              <span className="ms-node-sub">federated · {members.MEMBERS.filter(m => !(nodes[m.id]||'').includes('gbg-1') && nodes[m.id]).length}</span>
            </span>
          </div>
        </div>
      )}
      {groupOrder.map((key) => (
        <React.Fragment key={key}>
          <div className="members-section" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: groupMeta[key].color }} />
            {groupMeta[key].name} — {groups[key].length}
          </div>
          {groups[key].map((m: any) => <Row key={m.id} m={m} />)}
        </React.Fragment>
      ))}
      {onlineDefault.length > 0 && (
        <>
          <div className="members-section">Online — {onlineDefault.length}</div>
          {onlineDefault.map((m: any) => <Row key={m.id} m={m} />)}
        </>
      )}
      {offline.length > 0 && (
        <>
          <div className="members-section">Offline — {offline.length}</div>
          {offline.map((m: any) => <Row key={m.id} m={m} />)}
        </>
      )}
    </aside>
  );
}

// ───────────── root ─────────────
function ChatApp({ theme, opts = {}, rich = false, controller }) {
  // Live shell data via context. Replaces the old `window.SHELL_DATA`
  // global read so re-renders are React-driven and tests can inject a
  // provider without monkey-patching window. Handlers below close over
  // this binding instead of re-reading the global.
  const data = (useShellDataContext() as any) || MOCK_DATA;
  // Live store selectors used by the outbound write paths (send/edit/delete).
  // activeTeamId routes WS messages to the right per-team socket; derivedKey
  // is required by tryEncrypt for channel-message E2E encryption.
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const derivedKey = useAuthStore((s) => s.derivedKey);
  // Pick sensible defaults from the bridged data instead of hardcoded
  // Prefer the active selection surfaced by useShellData; otherwise the
  // first real server / channel. NO mock-id fallback — falling through
  // to `'berralitos'` / `'design'` was the source of every "mock content
  // visible on /app" regression.
  const initialServer = data.activeServerId || data.SERVERS?.[0]?.id || '';
  const initialChannel =
    data.activeChannelId ||
    data.CHANNELS?.find((c) => c.type === 'text')?.id ||
    data.CHANNELS?.[0]?.id ||
    '';
  const [activeServer, setActiveServer] = useState(initialServer);
  const [tab, setTab] = useState('kanals');
  const [activeChannel, setActiveChannel] = useState(initialChannel);
  const [activeDM, setActiveDM] = useState(null);
  const [activeView, setActiveView] = useState({ kind: 'channel', id: initialChannel });
  // Keep useTeamStore/useDMStore active-id in lockstep with whichever
  // view is currently showing, AND clear that conversation's unread pill
  // every time the view changes. The global message listeners use the
  // store ids to (a) suppress the unread bump for the live view and
  // (b) roll the read watermark forward when a new message arrives
  // in-view; this effect handles the third case — landing on a chat
  // that *already had* a pill from earlier, regardless of how we got
  // there (tab switch, onPickDM, onPickChannel, redirect). Without this,
  // tab-switching to a DM with a stale count required an explicit click
  // on the DM row to clear.
  React.useEffect(() => {
    if (!activeView.id) return;
    const teamId = useTeamStore.getState().activeTeamId;
    if (activeView.kind === 'channel') {
      useTeamStore.getState().setActiveChannel(activeView.id);
      useDMStore.getState().setActiveDM(null);
      useUnreadStore.getState().markRead(activeView.id);
      if (teamId && !isMockSession()) {
        const msgs = data?.MESSAGES?.[activeView.id] ?? [];
        const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
        if (lastId) { try { ws.markChannelRead(teamId, activeView.id, lastId); } catch { /* ignore */ } }
      }
    } else if (activeView.kind === 'dm') {
      useDMStore.getState().setActiveDM(activeView.id);
      // Clear the channel id so a channel echo doesn't think it's "live"
      // while a DM is on screen.
      useTeamStore.getState().setActiveChannel('');
      useUnreadStore.getState().markRead(activeView.id);
      if (teamId && !isMockSession()) {
        const msgs = data?.DM_MESSAGES?.[activeView.id] ?? [];
        const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
        if (lastId) { try { ws.markChannelRead(teamId, activeView.id, lastId); } catch { /* ignore */ } }
      }
    }
  }, [activeView.kind, activeView.id]);
  const [messages, setMessages] = useState(data.MESSAGES);
  const [dmMessages, setDmMessages] = useState(data.DM_MESSAGES);
  // Keep local message state in sync with the live store-derived bridge
  // (data.MESSAGES / DM_MESSAGES). useShellData wraps its output in useMemo
  // with store dependencies, so these refs only change when the store
  // actually mutates — incoming WS events from the real server land here.
  // Optimistic writes via setMessages remain visible until the server echo
  // arrives, then are reconciled (same id = no glitch).
  useEffect(() => { setMessages(data.MESSAGES); }, [data.MESSAGES]);
  useEffect(() => { setDmMessages(data.DM_MESSAGES); }, [data.DM_MESSAGES]);

  // Per-channel slow-mode lock state. After 3 consecutive rejections we
  // disable the composer until the cooldown expires; the 1s tick below
  // forces a re-render so the countdown updates and the lock clears
  // when the time-left hits zero.
  const [slowLocks, setSlowLocks] = useState<Record<string, { strikes: number; until: number }>>({});
  const [, tickSlowLocks] = useState(0);
  useEffect(() => {
    const hasActive = Object.values(slowLocks).some((l) => l.until > Date.now());
    if (!hasActive) return;
    const id = window.setInterval(() => {
      tickSlowLocks((n) => n + 1);
      setSlowLocks((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, { strikes: number; until: number }> = {};
        for (const [cid, lock] of Object.entries(prev)) {
          if (lock.until <= now) {
            // Cooldown elapsed — reset strikes so a single late send doesn't
            // immediately re-lock; user has to hit slow mode three times again.
            changed = true;
            continue;
          }
          next[cid] = lock;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [slowLocks]);

  // Server-side rejections (slow mode, future quota/perm gates) — roll
  // back the optimistic message, restore its text to the composer, and
  // bump the strike count so we can disable the composer after three.
  useEffect(() => {
    const me = currentUserId();
    const unsub = ws.on('message:rejected', (payload: any) => {
      const channelId = payload?.channel_id;
      if (!channelId) return;
      const reason = payload?.reason;
      const retryIn = Number(payload?.retry_in ?? 0);
      setMessages(prev => {
        const list = (prev[channelId] || []) as any[];
        let removedText: string | null = null;
        const next = [...list];
        for (let i = next.length - 1; i >= 0; i--) {
          const m = next[i];
          if (m.author === me && typeof m.id === 'string' && m.id.startsWith('new-')) {
            removedText = m.text ?? null;
            next.splice(i, 1);
            break;
          }
        }
        if (removedText) {
          setDrafts(d => ({ ...d, [channelId]: removedText! }));
        }
        return { ...prev, [channelId]: next };
      });
      if (reason === 'slow_mode' && retryIn > 0) {
        setSlowLocks((prev) => {
          const cur = prev[channelId] ?? { strikes: 0, until: 0 };
          return { ...prev, [channelId]: { strikes: cur.strikes + 1, until: Date.now() + retryIn * 1000 } };
        });
      }
    });
    return () => { unsub(); };
  }, []);

  // Poll WS feed: route into the shared pollStore so the data survives
  // listener-mount races (eager-load may have stashed entries before this
  // component subscribed). useShellData merges store entries into MESSAGES.
  useEffect(() => {
    const upsertPoll = (payload: any) => {
      usePollStore.getState().upsert(normalizePoll(payload));
    };
    const unsubNew = ws.on('poll:new', upsertPoll);
    const unsubUpd = ws.on('poll:update', upsertPoll);
    return () => { unsubNew(); unsubUpd(); };
  }, []);
  const [drafts, setDrafts] = useState({});
  // Voice state is owned by the voice store (driven by useVoiceConnection
  // and WebRTC events). voiceConnection is a derived view (channelId +
  // friendly channel name) that the legacy UI props expect. mute/deaf
  // come straight from the store so the icons reflect real mic state.
  const voice = useVoiceConnection();
  const voiceCh = data.CHANNELS?.find((c) => c.id === voice.currentChannelId);
  const voiceConnection = voice.connected && voiceCh
    ? { channelId: voice.currentChannelId, channel: voiceCh.name }
    : null;
  const mute = voice.muted;
  const setMute = (next) => {
    const target = typeof next === 'function' ? next(voice.muted) : next;
    if (target !== voice.muted) voice.toggleMute();
  };
  const deaf = voice.deafened;
  const setDeaf = (next) => {
    const target = typeof next === 'function' ? next(voice.deafened) : next;
    if (target !== voice.deafened) voice.toggleDeafen();
  };
  // Wrap the local cam/screen booleans with side effects that actually
  // publish/stop media via webrtcService. Previously these were just
  // useState pairs — the toggle buttons flipped a boolean but no
  // getUserMedia/getDisplayMedia call ever happened, which is why the
  // UI showed CamTile/ScreenTile placeholders forever.
  const [cam, setCamRaw] = useState(false);
  const [screen, setScreenRaw] = useState(false);
  // Reset cam/screen when voice disconnects so the user-panel icons go
  // back to off — leaveChannel already stops the media tracks in the
  // store, but the local toggle flags live here so the user-panel
  // button doesn't have a state source to sync against otherwise.
  useEffect(() => {
    if (!voice.connected) {
      setCamRaw(false);
      setScreenRaw(false);
    }
  }, [voice.connected]);
  const setCam = (next: boolean | ((v: boolean) => boolean)) => {
    const target = typeof next === 'function' ? next(cam) : next;
    if (target === cam) return;
    // Optimistic flip so the button reacts instantly; if the media
    // request rejects (permission denied, no camera, etc.) we rewind.
    setCamRaw(target);
    (async () => {
      try {
        const { webrtcService } = await import('../services/webrtc');
        if (target) await webrtcService.startWebcam();
        else await webrtcService.stopWebcam();
      } catch (err) {
        console.warn('[Voice] webcam toggle failed', err);
        setCamRaw(!target);
      }
    })();
  };
  const setScreen = (next: boolean | ((v: boolean) => boolean)) => {
    const target = typeof next === 'function' ? next(screen) : next;
    if (target === screen) return;
    setScreenRaw(target);
    (async () => {
      try {
        const { webrtcService } = await import('../services/webrtc');
        if (target) await webrtcService.startScreenShare();
        else await webrtcService.stopScreenShare();
      } catch (err) {
        console.warn('[Voice] screen toggle failed', err);
        setScreenRaw(!target);
      }
    })();
  };
  const [typing, setTyping] = useState([]);
  const [dmTyping, setDmTyping] = useState({}); // channelId -> [names]
  const [settings, setSettings] = useState({ open: false, mode: 'user', tab: null });
  const [membersOpen, setMembersOpen] = useState(true);
  const [profilePop, setProfilePop] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replyTo, setReplyTo] = useState({}); // channelId -> msgId
  const [newChanOpen, setNewChanOpen] = useState(false);
  const [chanSettings, setChanSettings] = useState(null); // {id, name, topic} or null
  // /giphy picker state: open when the user runs /giphy <query>. Holds
  // the query string for the header and 3 candidate gif URLs. Clicking
  // a tile sends it as a text message; Cancel/Escape drops the picker.
  const [giphyPicker, setGiphyPicker] = useState<{ query: string; results: Array<{ url: string; preview: string }> } | null>(null);
  const [chanAccess, setChanAccess] = useState(null); // {id, name, accessRoleIds, hidden_if_restricted} or null
  const [groupAccess, setGroupAccess] = useState<{ id: string; name: string; accessRoleIds: string[]; hiddenIfRestricted: boolean } | null>(null);
  const [groupSettings, setGroupSettings] = useState<{ id: string; name: string } | null>(null);
  const [newServerOpen, setNewServerOpen] = useState(false);
  // Generic context menu: { x, y, items: [{ label, icon, danger, onClick }] }
  const [menuPop, setMenuPop] = useState(null);
  // Channel mutes live in a dedicated zustand store now so they persist
  // across reloads and sync to other devices via channel:mute-update.
  const mutedMap = useChannelMuteStore((s) => s.muted);
  const mutedChannels = useMemo(() => {
    const out = new Set<string>();
    const now = Date.now();
    for (const [cid, until] of mutedMap.entries()) {
      if (until === null || new Date(until).getTime() > now) out.add(cid);
    }
    return out;
  }, [mutedMap]);
  const [newDmOpen, setNewDmOpen] = useState(false);
  function openMenu(e, items) {
    e.preventDefault();
    setMenuPop({ x: e.clientX, y: e.clientY, items });
  }
  function toggleMuteChannel(id) {
    const teamId = useTeamStore.getState().activeTeamId;
    if (!teamId || isMockSession()) {
      // Mock session — flip the local store only.
      const s = useChannelMuteStore.getState();
      if (s.isMuted(id)) s.clear(id); else s.setMuted(id, null);
      return;
    }
    const currentlyMuted = useChannelMuteStore.getState().isMuted(id);
    // Optimistic so the icon flips instantly; WS echo arrives shortly.
    if (currentlyMuted) {
      useChannelMuteStore.getState().clear(id);
      api.unmuteChannel(teamId, id).catch((err) => {
        console.warn('[mute] unmute failed', err);
        useChannelMuteStore.getState().setMuted(id, null);
      });
    } else {
      useChannelMuteStore.getState().setMuted(id, null);
      api.muteChannel(teamId, id, null).catch((err) => {
        console.warn('[mute] mute failed', err);
        useChannelMuteStore.getState().clear(id);
      });
    }
  }

  useEffect(() => {
    function onAddSrv()  { setNewServerOpen(true); }
    function onAddCh()   { setNewChanOpen(true); }
    function onProfile(e) { setProfilePop(e.detail); }
    function onThread(e)  { setActiveThread(e.detail); }
    function onDrawer()   { setDrawerOpen(o => !o); }
    function onInsertMention(e) {
      // Append @name to the active channel/DM draft. The mention picker
      // (in TextChannel.tsx) already supports @-completions on type; this
      // handler is for the member-menu "Mention in current kanal" action.
      const name = e.detail;
      if (!name) return;
      const targetId = channel?.id || activeChannel;
      if (!targetId) return;
      setDrafts((prev) => ({
        ...prev,
        [targetId]: ((prev[targetId] || '').trimEnd() + ' @' + name + ' ').trimStart(),
      }));
    }
    function onChannelSettings(e) {
      const id = e.detail;
      // Read from the LIVE teamStore each time the menu fires — the
      // closure that captured `data` may be stale.
      const tid = useTeamStore.getState().activeTeamId;
      const ch = tid
        ? (useTeamStore.getState().channels.get(tid) ?? []).find((c) => c.id === id)
        : undefined;
      if (ch) setChanSettings(ch);
    }
    function onChannelAccess(e) {
      const id = e.detail;
      const tid = useTeamStore.getState().activeTeamId;
      const ch = tid
        ? (useTeamStore.getState().channels.get(tid) ?? []).find((c) => c.id === id)
        : undefined;
      if (ch) setChanAccess(ch);
    }
    function onGroupAccess(e) {
      const id = e.detail;
      const tid = useTeamStore.getState().activeTeamId;
      const g = tid
        ? (useTeamStore.getState().groups.get(tid) ?? []).find((x) => x.id === id)
        : undefined;
      if (g) setGroupAccess({ id: g.id, name: g.name, accessRoleIds: g.accessRoleIds, hiddenIfRestricted: g.hiddenIfRestricted });
    }
    function onGroupSettings(e) {
      const id = e.detail;
      const tid = useTeamStore.getState().activeTeamId;
      const g = tid
        ? (useTeamStore.getState().groups.get(tid) ?? []).find((x) => x.id === id)
        : undefined;
      if (g) setGroupSettings({ id: g.id, name: g.name });
    }
    function onCloseDm(e) {
      const dmId = e.detail;
      if (!dmId) return;
      // Drop from local DM list. Server-side DM channels stick around for
      // history retention; users can re-open from a member profile.
      data.DMS = data.DMS.filter((x: any) => x.id !== dmId);
      if (activeDM === dmId) {
        setActiveDM(null);
        setActiveView({ kind: 'channel', id: activeChannel });
      }
    }
    async function onOpenDm(e) {
      // Member context menu / "send message" handler. Mirrors NewDmModal
      // onPick but with the member id passed in via custom event detail so
      // any rendered MemberList row can trigger it.
      const memberId = e.detail;
      if (!memberId) return;
      const optimisticId = 'dm-' + memberId;
      if (!data.DMS.find(d => d.id === optimisticId)) {
        data.DMS.push({ id: optimisticId, with: memberId, preview: '', at: new Date(), unread: 0 });
      }
      setActiveDM(optimisticId);
      setActiveView({ kind: 'dm', id: optimisticId });
      setTab('pms');
      if (activeTeamId && !isMockSession()) {
        try {
          const real = (await api.createDM(activeTeamId, [memberId])) as { id: string };
          if (real?.id && real.id !== optimisticId) {
            setActiveDM(real.id);
            setActiveView({ kind: 'dm', id: real.id });
          }
        } catch (err) {
          console.warn('[ChatApp] open-dm createDM failed', err);
        }
      }
    }
    function onPickChannel(e) {
      const id = e.detail;
      if (data.CHANNELS.find(c => c.id === id)) {
        setActiveChannel(id); setActiveView({ kind: 'channel', id }); setTab('kanals');
      }
    }
    function onMenu(e) { setMenuPop(e.detail); }
    window.addEventListener('dilla:open-profile', onProfile);
    window.addEventListener('dilla:open-thread', onThread);
    window.addEventListener('dilla:toggle-drawer', onDrawer);
    window.addEventListener('dilla:pickchannel', onPickChannel);
    window.addEventListener('dilla:open-add-server', onAddSrv);
    window.addEventListener('dilla:open-new-channel', onAddCh);
    window.addEventListener('dilla:open-menu', onMenu);
    window.addEventListener('dilla:open-dm', onOpenDm);
    window.addEventListener('dilla:close-dm', onCloseDm);
    window.addEventListener('dilla:insert-mention', onInsertMention);
    window.addEventListener('dilla:open-channel-settings', onChannelSettings);
    window.addEventListener('dilla:open-channel-access', onChannelAccess);
    window.addEventListener('dilla:open-group-access', onGroupAccess);
    window.addEventListener('dilla:open-group-settings', onGroupSettings);
    function onKey(e) {
      const inField = e.target.matches && e.target.matches('input, textarea, [contenteditable="true"]');
      if (inField) return;
      const order = ['general','design','dev','mesh','random'];
      if ((e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) {
        const id = order[parseInt(e.key, 10) - 1];
        if (id) { e.preventDefault(); setActiveChannel(id); setActiveView({ kind: 'channel', id }); setTab('kanals'); }
      } else if (e.key.toLowerCase() === 'm' && voiceConnection) {
        e.preventDefault(); setMute(v => !v);
      } else if (e.key.toLowerCase() === 'd' && voiceConnection) {
        e.preventDefault(); setDeaf(v => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dilla:open-profile', onProfile);
      window.removeEventListener('dilla:open-thread', onThread);
      window.removeEventListener('dilla:toggle-drawer', onDrawer);
      window.removeEventListener('dilla:pickchannel', onPickChannel);
      window.removeEventListener('dilla:open-add-server', onAddSrv);
      window.removeEventListener('dilla:open-new-channel', onAddCh);
      window.removeEventListener('dilla:open-dm', onOpenDm);
      window.removeEventListener('dilla:close-dm', onCloseDm);
      window.removeEventListener('dilla:insert-mention', onInsertMention);
      window.removeEventListener('dilla:open-channel-settings', onChannelSettings);
      window.removeEventListener('dilla:open-channel-access', onChannelAccess);
      window.removeEventListener('dilla:open-group-access', onGroupAccess);
      window.removeEventListener('dilla:open-group-settings', onGroupSettings);
      window.removeEventListener('dilla:open-menu', onMenu);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  function toggleReaction(channelId, msgId, emoji) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    // Capture the pre-toggle mine flag before optimistic state changes — used
    // to decide add vs remove on the backend.
    const currentList = isDM ? dmMessages[channelId] : messages[channelId];
    const currentMsg = currentList?.find((m) => m.id === msgId);
    const wasMine = !!currentMsg?.reactions?.find((r) => r.e === emoji)?.mine;
    setter(prev => {
      const arr = prev[channelId] || [];
      return {
        ...prev,
        [channelId]: arr.map(m => {
          if (m.id !== msgId) return m;
          const rxns = m.reactions ? [...m.reactions] : [];
          const idx = rxns.findIndex(r => r.e === emoji);
          if (idx >= 0) {
            const r = rxns[idx];
            if (r.mine) {
              if (r.n <= 1) rxns.splice(idx, 1);
              else rxns[idx] = { ...r, n: r.n - 1, mine: false };
            } else {
              rxns[idx] = { ...r, n: r.n + 1, mine: true };
            }
          } else {
            rxns.push({ e: emoji, n: 1, mine: true });
          }
          return { ...m, reactions: rxns };
        })
      };
    });
    // Real reaction toggle (channel only — DM reactions API not exposed yet).
    if (!activeTeamId || isDM) return;
    const call = wasMine
      ? api.removeReaction(activeTeamId, channelId, msgId, emoji)
      : api.addReaction(activeTeamId, channelId, msgId, emoji);
    call.catch((err) => console.warn('[ChatApp] reaction toggle failed', err));
  }

  function voteOnPoll(channelId, msgId, optIdx) {
    if (channelId.startsWith('dm-')) return; // polls only in team channels
    if (!activeTeamId) return;
    const me = currentUserId();
    // Optimistic store mutation so the bar fills before the WS echo lands.
    const state = usePollStore.getState();
    const list = state.polls.get(channelId) ?? [];
    const current = list.find((p) => p.id === msgId);
    if (!current) return;
    const alreadyMine = (current.voters[optIdx] || []).includes(me);
    const nextVoters = current.voters.map((arr, i) => {
      if (i === optIdx) return alreadyMine ? arr.filter((u) => u !== me) : Array.from(new Set([...arr, me]));
      return arr.filter((u) => u !== me); // single-choice
    });
    state.upsert({
      ...current,
      tallies: nextVoters.map((arr) => arr.length),
      voters: nextVoters,
    });
    const promise = alreadyMine
      ? api.unvotePoll(activeTeamId, msgId)
      : api.votePoll(activeTeamId, msgId, optIdx);
    promise.catch((err) => console.warn('[poll] vote failed', err));
  }

  useEffect(() => {
    function onOpen(e) {
      const d = e.detail;
      if (typeof d === 'string') setSettings({ open: true, mode: d, tab: null });
      else if (d && typeof d === 'object') setSettings({ open: true, mode: d.mode || 'user', tab: d.tab || null });
      else setSettings({ open: true, mode: 'user', tab: null });
    }
    window.addEventListener('dilla:open-settings', onOpen);
    return () => window.removeEventListener('dilla:open-settings', onOpen);
  }, []);

  // Handoff cycled fake typing here ('ada', 'mira'). Disabled — real
  // typing arrives via websocket → useMessageStore.typing. Wire that up
  // here in a later step.

  // DM typing also disabled — same plan as channel typing above.

  // Expose imperative controls to a parent via the optional `controller` object.
  useEffect(() => {
    if (!controller) return;
    controller.pickChannel = (id) => {
      if (data.CHANNELS.find(c => c.id === id)) {
        setActiveChannel(id); setTab('kanals'); setActiveView({ kind: 'channel', id });
      }
    };
    controller.toggleMute   = () => setMute(v => !v);
    controller.toggleDeafen = () => setDeaf(v => !v);
    controller.disconnect   = () => voice.leave();
    controller.getVoiceConn = () => voiceConnection;
  }, [controller, voiceConnection]);

  const team = data.SERVERS.find(s => s.id === activeServer) || data.SERVERS[0];
  const channelsForServer = data.CHANNELS;
  const baseChannel = channelsForServer.find(c => c.id === activeChannel) || channelsForServer[0];

  // Resolve the active view: either a channel or a DM (synthesized as a channel-like object).
  let viewChannel = baseChannel;
  let dmPartner = null;
  if (activeView.kind === 'dm') {
    const dm = data.DMS.find(d => d.id === activeView.id);
    if (dm) {
      if (dm.group) {
        viewChannel = { id: dm.id, name: dm.name, type: 'dm', encrypted: true, topic: 'group · ' + (dm.with.map(id => data.byId[id]?.name).join(', ')), group: true };
      } else {
        const partner = data.byId[dm.with];
        dmPartner = partner;
        viewChannel = { id: dm.id, name: partner?.name || 'dm', type: 'dm', encrypted: true, topic: partner?.custom || partner?.status };
      }
    }
  }
  const channel = viewChannel;

  // /giphy picker handoff. Two flavours of payload:
  //   • { url, attachment }: server materialized the gif into an
  //     attachment; we post as a kind:'image' message so the bytes
  //     stream from our /attachments path, not media.giphy.com.
  //   • { url } only: embed failed or /mesh has no real backend;
  //     fall back to posting the raw URL as text (renderText inlines
  //     it via the .gif extension).
  // Must sit AFTER `const channel` because the dep array reads it.
  useEffect(() => {
    function onPick(e: Event) {
      const detail = (e as CustomEvent).detail as { url?: string; attachment?: { id: string } } | undefined;
      const url = detail?.url;
      const att = detail?.attachment;
      if (!url) return;
      const ts = new Date();
      const isDM = channel?.type === 'dm';
      const isImagePath = !!att;
      const optimistic: Record<string, unknown> = isImagePath
        ? {
            id: 'new-' + Date.now(),
            author: currentUserId(),
            at: ts,
            kind: 'image',
            text: '',
            attachment: { kind: 'image', label: 'giphy.gif', src: url, w: 320, h: 200 },
            replyTo: null,
          }
        : { id: 'new-' + Date.now(), author: currentUserId(), at: ts, kind: 'text', text: url, replyTo: null };
      if (isDM && channel) {
        setDmMessages(prev => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), optimistic] }));
        if (activeTeamId) {
          // DM endpoint doesn't take attachment_ids — bake the id into
          // the body the way the file-upload path does. Receivers parse
          // the [file:<id>] marker and resolve to /attachments.
          const body = att ? `[file:${att.id}] giphy.gif` : url;
          api.sendDMMessage(activeTeamId, channel.id, body).catch((err) => console.warn('[giphy] DM send failed', err));
        }
      } else if (activeChannel) {
        setMessages(prev => ({ ...prev, [activeChannel]: [...(prev[activeChannel] || []), optimistic] }));
        if (activeTeamId && !isMockSession()) {
          (async () => {
            try {
              const body = att ? ' ' : url; // image-only message — body is a space the encrypt step can chew on
              const encrypted = await tryEncrypt(body, activeChannel, derivedKey);
              ws.sendMessage(activeTeamId, activeChannel, encrypted, 'text', undefined, att ? [att.id] : undefined);
            } catch (err) {
              console.warn('[giphy] channel send failed', err);
            }
          })();
        }
      }
    }
    window.addEventListener('dilla:giphy-pick', onPick);
    return () => window.removeEventListener('dilla:giphy-pick', onPick);
  }, [channel, activeChannel, activeTeamId, derivedKey]);

  function processSlash(text) {
    // Side-effect commands. Return null to signal "handled — don't send a
    // message". Use dilla:notify for status feedback so the caller doesn't
    // get a silent failure.
    function notify(msg, kind = 'system') {
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: kind, author: 'system', text: msg, duration: 3200 } }));
    }
    function lookupMember(query) {
      const q = query.replace(/^@/, '').toLowerCase().trim();
      if (!q) return null;
      const list = (data?.MEMBERS || []) as any[];
      return list.find((m) => m.name?.toLowerCase() === q || m.id === q)
        || list.find((m) => m.name?.toLowerCase().startsWith(q))
        || null;
    }
    // Post a real text message to the current channel/DM. Used by
    // slash commands that need to dispatch the message asynchronously
    // (e.g. /giphy waits for a fetch round-trip first). Mirrors the
    // send() body but without going through processSlash again.
    async function sendRawText(body: string) {
      const targetChannel = channel;
      const ts = new Date();
      const optimistic = { id: 'new-' + Date.now(), author: currentUserId(), at: ts, kind: 'text', text: body, replyTo: null };
      if (targetChannel?.type === 'dm') {
        setDmMessages(prev => ({ ...prev, [targetChannel.id]: [...(prev[targetChannel.id] || []), optimistic] }));
        if (activeTeamId) {
          api.sendDMMessage(activeTeamId, targetChannel.id, body).catch((err) => console.warn('[slash] DM send failed', err));
        }
      } else {
        setMessages(prev => ({ ...prev, [activeChannel]: [...(prev[activeChannel] || []), optimistic] }));
        if (activeTeamId && !isMockSession()) {
          try {
            const encrypted = await tryEncrypt(body, activeChannel, derivedKey);
            ws.sendMessage(activeTeamId, activeChannel, encrypted);
          } catch (err) {
            console.warn('[slash] channel send failed', err);
          }
        }
      }
    }
    function setLocked(locked: boolean) {
      if (!activeTeamId || !channel || channel.type === 'dm') {
        notify('Use /lock or /unlock inside a team channel.');
        return;
      }
      api.updateChannel(activeTeamId, channel.id, { locked }).then(() =>
        notify((locked ? 'Locked ' : 'Unlocked ') + '#' + channel.name + '.'),
      ).catch((err: unknown) => {
        console.warn('[slash] lock failed', err);
        notify('Lock failed — manage-channels permission required.');
      });
    }

    if (text.startsWith('/me ')) return { kind: 'action', text: text.slice(4) };
    if (text === '/me') return { kind: 'text', text };
    if (text.startsWith('/shrug')) {
      const rest = text.slice(6).trim();
      return { kind: 'text', text: (rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯' };
    }
    if (text.startsWith('/poll ')) {
      const args = text.slice(6).split('|').map(s => s.trim()).filter(Boolean);
      if (args.length < 2) {
        notify('Poll needs at least one option — /poll <question> | <opt1> | <opt2>');
        return null;
      }
      const question = args[0];
      const opts = args.slice(1);
      if (!activeTeamId) { notify('Sign in first.'); return null; }
      // Server-backed: createPoll persists the poll + broadcasts poll:new
      // to every client in the channel; the WS listener below merges it
      // into the timeline as a kind:'poll' message.
      (async () => {
        try {
          const created: any = await api.createPoll(activeTeamId, activeChannel, { question, options: opts });
          // Seed the local store immediately — the WS broadcast is the
          // canonical source for everyone else, but seeding for the sender
          // avoids any visible round-trip lag.
          usePollStore.getState().upsert(normalizePoll(created));
        } catch (err) {
          console.warn('[slash] poll create failed', err);
          notify('Poll create failed.');
        }
      })();
      return null;
    }
    if (text.startsWith('/giphy ')) {
      const q = text.slice(7).trim();
      if (!q) { notify('Usage: /giphy <search>'); return null; }
      if (!activeTeamId) { notify('Sign in first.'); return null; }
      // Three candidates rather than one — open a picker so the user
      // chooses before posting. The server's gif endpoint returns a
      // `results` array when limit > 1; the picker calls sendRawText
      // on the chosen tile. Failure modes match the previous handler:
      //   503 → operator hasn't configured a key
      //   404 → no match for that query
      //   anything else → search link fallback
      (async () => {
        try {
          const res = await api.searchGif(activeTeamId, q, 3);
          const results = res.results && res.results.length > 0
            ? res.results
            : [{ url: res.url, preview: res.url }];
          setGiphyPicker({ query: q, results });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('503') || msg.toLowerCase().includes('not configured')) {
            notify('Gif search is disabled — an admin can add a Giphy API key in Team Settings → Integrations.');
          } else if (msg.includes('404') || msg.toLowerCase().includes('no gif')) {
            notify(`No gif matches "${q}".`);
          } else {
            console.warn('[slash] giphy failed', err);
            await sendRawText('https://giphy.com/search/' + encodeURIComponent(q));
          }
        }
      })();
      return null;
    }
    if (text.startsWith('/code')) {
      const lang = text.slice(5).trim();
      return { kind: 'text', text: '```' + lang + '\n' + (lang ? '// type your code here\n' : 'type your code here\n') + '```' };
    }

    if (text === '/help' || text.startsWith('/help ')) {
      window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'keys' } }));
      return null;
    }
    if (text.startsWith('/w ')) {
      const m = lookupMember(text.slice(3));
      if (!m) { notify('No member matches that name.'); return null; }
      if (m.id === currentUserId()) { notify('You cannot DM yourself.'); return null; }
      window.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: m.id }));
      return null;
    }
    if (text.startsWith('/invite ')) {
      const target = text.slice(8).trim();
      window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'invites' } }));
      notify(target ? `Open Invites to create a link for ${target}.` : 'Open Invites to create a link.');
      return null;
    }
    if (text.startsWith('/topic')) {
      const topic = text.slice(6).trim();
      if (!activeTeamId || !channel || channel.type === 'dm') {
        notify('Use /topic inside a team channel.');
        return null;
      }
      api.updateChannel(activeTeamId, channel.id, { topic }).then(() =>
        notify('Updated topic for #' + channel.name + '.'),
      ).catch((err: unknown) => {
        console.warn('[slash] topic failed', err);
        notify('Topic update failed — manage-channels permission required.');
      });
      return null;
    }
    if (text === '/lock' || text === '/unlock') { setLocked(text === '/lock'); return null; }
    if (text.startsWith('/nick ')) {
      const nick = text.slice(6).trim();
      if (!activeTeamId) { notify('Sign in first.'); return null; }
      api.updateMember(activeTeamId, currentUserId(), { nickname: nick }).then(() =>
        notify(nick ? 'Nickname set to ' + nick + '.' : 'Nickname cleared.'),
      ).catch((err: unknown) => {
        console.warn('[slash] nick failed', err);
        notify('Nickname update failed.');
      });
      return null;
    }
    if (text === '/remind' || text.startsWith('/remind ')) {
      notify('Reminders are not implemented yet.');
      return null;
    }
    if (text.startsWith('/')) {
      notify('Unknown command: ' + text.split(' ')[0] + ' — try /help.');
      return null;
    }
    return { kind: 'text', text };
  }

  // Outbound typing indicator. Channel typing uses ws.startTyping, DMs use
  // ws.startDMTyping. Debounced so we don't flood the WS on every keystroke
  // — the server broadcasts `typing:indicator` on receipt regardless of
  // frequency, but a 3s window matches the typical typing-decay UX.
  const lastTypingRef = useRef(0);
  function notifyTyping() {
    if (!activeTeamId) return;
    if (isMockSession()) return;
    const now = Date.now();
    if (now - lastTypingRef.current < 3000) return;
    lastTypingRef.current = now;
    if (channel.type === 'dm') {
      ws.startDMTyping(activeTeamId, channel.id);
    } else {
      ws.startTyping(activeTeamId, activeChannel);
    }
  }

  function send() {
    if (channel.type === 'dm') {
      const draft = drafts[channel.id];
      if (!draft || !draft.trim()) return;
      const text = draft.trim();
      const processed = processSlash(text);
      if (processed === null) {
        // Side-effect slash command handled it — clear the draft, don't send.
        setDrafts(prev => ({ ...prev, [channel.id]: '' }));
        return;
      }
      const m = { id: 'new-' + Date.now(), author: currentUserId(), at: new Date(), ...processed, replyTo: replyTo[channel.id] || null };
      setDmMessages(prev => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), m] }));
      setDrafts(prev => ({ ...prev, [channel.id]: '' }));
      setReplyTo(prev => ({ ...prev, [channel.id]: null }));
      // Real send: DM API is HTTP. Mock api implementation echoes back via
      // the dmStore so the bridged data.DM_MESSAGES picks up the round-trip.
      if (activeTeamId) {
        api.sendDMMessage(activeTeamId, channel.id, text).catch((err) =>
          console.warn('[ChatApp] DM send failed', err),
        );
      }
      return;
    }
    const draft = drafts[activeChannel];
    if (!draft || !draft.trim()) return;
    const text = draft.trim();
    const processed = processSlash(text);
    if (processed === null) {
      setDrafts(prev => ({ ...prev, [activeChannel]: '' }));
      return;
    }
    const m = {
      id: 'new-' + Date.now(),
      author: currentUserId(),
      at: new Date(),
      ...processed,
      replyTo: replyTo[activeChannel] || null,
    };
    setMessages(prev => ({ ...prev, [activeChannel]: [...(prev[activeChannel] || []), m] }));
    setDrafts(prev => ({ ...prev, [activeChannel]: '' }));
    setReplyTo(prev => ({ ...prev, [activeChannel]: null }));
    // Real send: channel messages are WS, encrypted with the team-derived key.
    // On /mesh the mock ws is a no-op and crypto is never initialized, so the
    // optimistic local push above is the entire demo flow. On /app this
    // round-trips through the server; the echo lands in messageStore and
    // flows back through useShellData → data.MESSAGES (synced by the
    // useEffect above).
    const replyTargetId = replyTo[activeChannel] || null;
    if (activeTeamId && !isMockSession()) {
      (async () => {
        try {
          const encrypted = await tryEncrypt(text || ' ', activeChannel, derivedKey);
          ws.sendMessage(
            activeTeamId,
            activeChannel,
            encrypted,
            'text',
            undefined,
            undefined,
            replyTargetId,
          );
        } catch (err) {
          console.warn('[ChatApp] channel send failed', err);
        }
      })();
    }
  }

  function editMessage(channelId, msgId, newText) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    setter(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(m =>
        m.id === msgId ? { ...m, text: newText, edited: true, editedAt: Date.now() } : m
      )
    }));
    // Real edit: channel edits are WS + encrypted; DM edits are HTTP.
    // On /mesh both paths route to mock services — but channel encryption
    // would fail noisily without initCrypto, so gate the channel branch on
    // a real session.
    if (!activeTeamId) return;
    if (isDM) {
      api.editDMMessage(activeTeamId, channelId, msgId, newText).catch((err) =>
        console.warn('[ChatApp] DM edit failed', err),
      );
    } else if (!isMockSession()) {
      (async () => {
        try {
          const encrypted = await tryEncrypt(newText, channelId, derivedKey);
          ws.editMessage(activeTeamId, msgId, channelId, encrypted);
        } catch (err) {
          console.warn('[ChatApp] channel edit failed', err);
        }
      })();
    }
  }

  function deleteMessage(channelId, msgId) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    setter(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).filter(m => m.id !== msgId)
    }));
    if (!activeTeamId) return;
    if (isDM) {
      api.deleteDMMessage(activeTeamId, channelId, msgId).catch((err) =>
        console.warn('[ChatApp] DM delete failed', err),
      );
    } else {
      ws.deleteMessage(activeTeamId, msgId, channelId);
    }
  }

  const rootStyle = window.THEMES.themeVars(theme, opts);
  rootStyle['--sidebar-w'] = (opts.sidebar || 240) + 'px';
  const isDM = channel.type === 'dm';
  const showFourth = activeThread || (membersOpen && !isDM);
  rootStyle['--members-w'] = (showFourth ? (activeThread ? 380 : (opts.members || 232)) : 0) + 'px';

  return (
    <div className="chat" data-style={theme.style} data-drawer={drawerOpen ? '1' : '0'} style={rootStyle}>
      <ServerRail servers={data.SERVERS} activeServer={activeServer} onPick={setActiveServer} />
      <ChannelSidebar
        team={team}
        tab={tab}
        onTab={(next) => {
          setTab(next);
          // When switching tabs, refocus the main view to match the
          // sidebar context — otherwise you'd see Kanals selected while
          // the chat pane still shows a DM (or vice versa). Falls back
          // to the first item in the target list if nothing was last
          // active.
          if (next === 'pms') {
            const target = activeDM || (data.DMS[0]?.id ?? null);
            if (target) {
              setActiveDM(target);
              setActiveView({ kind: 'dm', id: target });
            }
          } else if (next === 'kanals') {
            const target = activeChannel || (channelsForServer.find((c) => c.type === 'text')?.id ?? null);
            if (target) {
              setActiveChannel(target);
              setActiveView({ kind: 'channel', id: target });
              useTeamStore.getState().setActiveChannel(target);
              useDMStore.getState().setActiveDM(null);
            }
          }
        }}
        channels={channelsForServer}
        activeChannel={activeChannel}
        onPickChannel={(id) => {
          setActiveChannel(id);
          setActiveView({ kind: 'channel', id });
          // Mirror local activeChannel into useTeamStore so the global
          // message:new listener can suppress the unread bump for the
          // channel you're actually viewing (otherwise every echoed
          // message increments the pill).
          useTeamStore.getState().setActiveChannel(id);
          // useDMStore.activeDMId mirrors ChatApp's local activeDM so that
          // the global useDMEvents listener can tell whether a DM is open
          // and skip the unread bump for messages arriving on it.
          useDMStore.getState().setActiveDM(null);
          // Clear the unread pill locally and tell the server about the new
          // read watermark so a reload reconciles to the same state.
          useUnreadStore.getState().markRead(id);
          const teamId = useTeamStore.getState().activeTeamId;
          if (teamId && !isMockSession()) {
            const msgs = data?.MESSAGES?.[id] ?? [];
            const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
            if (lastId) { try { ws.markChannelRead(teamId, id, lastId); } catch { /* ignore */ } }
          }
        }}
        members={data}
        dms={data.DMS}
        activeDM={activeView.kind === 'dm' ? activeView.id : null}
        onPickDM={(id) => {
          setActiveDM(id);
          setActiveView({ kind: 'dm', id });
          useDMStore.getState().setActiveDM(id);
          useUnreadStore.getState().markRead(id);
          const teamId = useTeamStore.getState().activeTeamId;
          if (teamId && !isMockSession()) {
            const msgs = data?.DM_MESSAGES?.[id] ?? [];
            const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
            if (lastId) { try { ws.markChannelRead(teamId, id, lastId); } catch { /* ignore */ } }
          }
        }}
        voiceConnection={voiceConnection}
        onLeaveVoice={() => voice.leave()}
        onJoinVoice={(channelId) => {
          const teamId = useTeamStore.getState().activeTeamId;
          if (teamId) voice.join(teamId, channelId);
        }}
        mute={mute} setMute={setMute}
        deaf={deaf} setDeaf={setDeaf}
        cam={cam} setCam={setCam}
        screen={screen} setScreen={setScreen}
        mutedChannels={mutedChannels}
        toggleMuteChannel={toggleMuteChannel}
        onNewDm={() => setNewDmOpen(true)}
      />
      {channel.type === 'voice' ? (
        <VoiceChannel
          channel={channel}
          members={data}
          voiceConnection={voiceConnection}
          onJoin={() => {
            // useVoiceConnection.join → voiceStore.joinChannel → WebRTC
            // connect against the SFU. On /mesh the mock ws is a no-op so
            // the connect attempt fails fast and the dock stays hidden.
            const teamId = useTeamStore.getState().activeTeamId;
            if (teamId) voice.join(teamId, channel.id);
          }}
          onLeave={() => voice.leave()}
          mute={mute} setMute={setMute}
          deaf={deaf} setDeaf={setDeaf}
          cam={cam} setCam={setCam}
          screen={screen} setScreen={setScreen}
          rich={rich}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen(o => !o)}
        />
      ) : (
        <TextChannel
          channel={channel}
          messages={channel.type === 'dm' ? (dmMessages[channel.id] || []) : (messages[channel.id] || [])}
          members={data}
          dmPartner={dmPartner}
          draft={drafts[channel.id] || ''}
          setDraft={v => { setDrafts(prev => ({ ...prev, [channel.id]: v })); notifyTyping(); }}
          slowModeLock={(() => {
            const l = slowLocks[channel.id];
            if (!l || l.strikes < 3) return null;
            const secondsLeft = Math.max(0, Math.ceil((l.until - Date.now()) / 1000));
            return secondsLeft > 0 ? { secondsLeft } : null;
          })()}
          onSend={send}
          replyTo={replyTo[channel.id]}
          onSetReply={(id) => setReplyTo(prev => ({ ...prev, [channel.id]: id }))}
          onReact={(msgId, emoji) => toggleReaction(channel.id, msgId, emoji)}
          onVote={(msgId, optIdx) => voteOnPoll(channel.id, msgId, optIdx)}
          onEdit={(msgId, text) => editMessage(channel.id, msgId, text)}
          onDelete={(msgId) => deleteMessage(channel.id, msgId)}
          onAttach={async (file) => {
            // Optimistic local stub so the message appears immediately.
            // For images, a blob: URL gives the user an instant preview
            // before the server upload completes.
            const localId = 'att-' + Date.now();
            const isImage = file.type?.startsWith('image/');
            const previewUrl = isImage ? URL.createObjectURL(file) : '';
            const m = {
              id: localId,
              author: currentUserId(),
              at: new Date(),
              kind: isImage ? 'image' : 'file',
              text: '',
              attachment: {
                kind: isImage ? 'image' : 'file',
                label: file.name,
                size: file.size,
                src: previewUrl,
                w: 320,
                h: 200,
                tint: 'var(--accent)',
              },
            };
            const isDM = channel.type === 'dm';
            const setter = isDM ? setDmMessages : setMessages;
            setter(prev => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), m] }));
            if (!activeTeamId || isMockSession()) return;
            // Real flow: upload file → api.uploadFile returns Attachment.id.
            // Channel attachments ride on ws.sendMessage as a separate
            // attachment_ids array (content stays empty for image-only
            // messages); DMs use api.sendDMMessage with the attachment id
            // appended to the text body since the DM endpoint doesn't take
            // attachment ids directly.
            try {
              const att = await api.uploadFile(activeTeamId, file);
              if (isDM) {
                await api.sendDMMessage(activeTeamId, channel.id, `[file:${att.id}] ${file.name}`);
              } else {
                const encrypted = await tryEncrypt(' ', channel.id, derivedKey);
                ws.sendMessage(activeTeamId, channel.id, encrypted, 'text', undefined, [att.id]);
              }
            } catch (err) {
              console.warn('[ChatApp] attachment upload failed', err);
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: channel.name, author: 'system', text: 'Upload failed — ' + (err as Error).message, duration: 4000 } }));
            }
          }}
          typing={channel.type === 'dm' ? (dmTyping[channel.id] || []) : typing}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen(o => !o)}
        />
      )}
      {activeThread ? (
        <ThreadPanel
          channelId={activeThread.channelId}
          messageId={activeThread.messageId}
          members={data}
          onClose={() => setActiveThread(null)}
        />
      ) : (
        !isDM && membersOpen && <MemberList members={data} voiceConnection={voiceConnection} rich={rich} federated={opts.federated !== false} />
      )}
      {(() => {
        const SettingsModal = window.Settings;
        return SettingsModal ? (
          <SettingsModal
            open={settings.open}
            mode={settings.mode}
            defaultTab={settings.tab}
            onClose={() => setSettings(s => ({ ...s, open: false }))}
          />
        ) : null;
      })()}
      {opts.onSidebarChange && (
        <ResizeHandle kind="sidebar" value={opts.sidebar || 240}
                      onResize={opts.onSidebarChange} min={200} max={360} />
      )}
      {opts.onMembersChange && membersOpen && (
        <ResizeHandle kind="members" value={opts.members || 232}
                      onResize={opts.onMembersChange} min={180} max={340} />
      )}
      <ProfilePopover
        pop={profilePop}
        onClose={() => setProfilePop(null)}
        onDM={(id) => window.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: id }))}
        federated={opts.federated !== false}
      />
      {menuPop && (
        <div className="ctx-overlay" onClick={() => setMenuPop(null)} onContextMenu={(e) => { e.preventDefault(); setMenuPop(null); }}>
          <div className="ctx-menu"
               style={{ left: Math.min(menuPop.x, window.innerWidth - 220), top: Math.min(menuPop.y, window.innerHeight - (menuPop.items.length * 36 + 16)) }}
               onClick={e => e.stopPropagation()}>
            {menuPop.items.map((it, i) => it.sep ? (
              <div key={i} className="ctx-sep" />
            ) : (
              <button key={i} className={it.danger ? 'danger' : ''} disabled={!!it.disabled} onClick={() => { if (it.disabled) return; it.onClick && it.onClick(); setMenuPop(null); }}>
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {chanAccess && (
        <ChannelAccessModal channel={chanAccess} onClose={() => setChanAccess(null)} />
      )}
      {groupAccess && (
        <GroupAccessModal group={groupAccess} onClose={() => setGroupAccess(null)} />
      )}
      {groupSettings && (
        <GroupSettingsModal group={groupSettings} onClose={() => setGroupSettings(null)} />
      )}
      {chanSettings && (
        <ChannelSettingsModal channel={chanSettings} onClose={() => setChanSettings(null)} />
      )}
      {giphyPicker && (
        <GiphyPicker
          query={giphyPicker.query}
          results={giphyPicker.results}
          onPick={async (url) => {
            // Drop the picker first so the modal closes before the
            // round-trip — keeps the UI snappy. Then ask the server
            // to materialize the URL into a team attachment (avoids
            // hot-linking media.giphy.com from every recipient's
            // browser) and dispatch the resulting attachment id to
            // the send path. Fallback: if embed fails, post the URL
            // as plain text so the user isn't left empty-handed.
            setGiphyPicker(null);
            const teamId = useTeamStore.getState().activeTeamId;
            if (!teamId) return;
            try {
              if (isMockSession()) {
                // /mesh embed returns the URL as storage_path; demo
                // path posts the raw URL since mock has no /attachments
                // server to fetch from.
                window.dispatchEvent(new CustomEvent('dilla:giphy-pick', { detail: { url } }));
                return;
              }
              const att = await api.embedGif(teamId, url);
              const attUrl = api.getAttachmentUrl(teamId, att.id);
              window.dispatchEvent(new CustomEvent('dilla:giphy-pick', { detail: {
                url: attUrl,
                attachment: att,
              } }));
            } catch (err) {
              console.warn('[giphy] embed failed, falling back to URL', err);
              window.dispatchEvent(new CustomEvent('dilla:giphy-pick', { detail: { url } }));
            }
          }}
          onClose={() => setGiphyPicker(null)}
        />
      )}
      {newChanOpen && (
        <NewChannelModal onClose={() => setNewChanOpen(false)} onCreate={async (c) => {
          // Optimistic local push so the UI advances immediately. On /app the
          // server echoes the real channel via api.createChannel; we replace
          // the optimistic record with the server version (real id, etc.).
          // On /mesh the api call is a no-op equivalent so the optimistic
          // entry is what stays.
          const optimisticId = c.id;
          data.CHANNELS.push({ ...c, type: c.kind, unread: 0, encrypted: true });
          setActiveChannel(optimisticId);
          setActiveView({ kind: 'channel', id: optimisticId });
          setNewChanOpen(false);
          if (activeTeamId && !isMockSession()) {
            try {
              const real = (await api.createChannel(activeTeamId, {
                name: c.name,
                type: c.kind,
                topic: c.topic,
                category: c.category,
              })) as { id: string; name: string; type: string; topic?: string; category?: string };
              if (real?.id) {
                useTeamStore.getState().addChannel(activeTeamId, {
                  id: real.id,
                  name: real.name,
                  type: real.type,
                  topic: real.topic ?? '',
                  category: real.category ?? '',
                } as any);
                setActiveChannel(real.id);
                setActiveView({ kind: 'channel', id: real.id });
              }
            } catch (err) {
              console.warn('[ChatApp] createChannel failed', err);
            }
          }
          window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Kanal created.', duration: 3500 } }));
        }} />
      )}
      {newServerOpen && (
        <NewServerModal onClose={() => setNewServerOpen(false)} onCreate={(s) => {
          // Adding a team requires server URL + identity binding — too much
          // for a single modal. Redirect into the onboarding flow with the
          // appropriate mode + token pre-filled. The user's existing
          // identity is reused (no new keypair).
          setNewServerOpen(false);
          if (s.kind === 'join') {
            const tokenParam = encodeURIComponent(s.token || '');
            window.location.assign(`/onboarding?mode=invite&token=${tokenParam}`);
          } else {
            const nameParam = encodeURIComponent(s.name || '');
            window.location.assign(`/onboarding?mode=bootstrap&team=${nameParam}`);
          }
        }} />
      )}
      {newDmOpen && (
        <NewDmModal members={data} onClose={() => setNewDmOpen(false)}
          onPick={async (id) => {
            // Optimistic: synthesize a local DM id so the UI advances even
            // when offline / on /mesh. On /app the server returns the real
            // channel id; we re-route to it once the round-trip completes.
            const optimisticId = 'dm-' + id;
            if (!data.DMS.find(d => d.id === optimisticId)) {
              data.DMS.push({ id: optimisticId, with: id, preview: '', at: new Date(), unread: 0 });
            }
            setActiveDM(optimisticId);
            setActiveView({ kind: 'dm', id: optimisticId });
            setTab('pms');
            setNewDmOpen(false);
            if (activeTeamId && !isMockSession()) {
              try {
                const real = (await api.createDM(activeTeamId, [id])) as { id: string };
                if (real?.id && real.id !== optimisticId) {
                  setActiveDM(real.id);
                  setActiveView({ kind: 'dm', id: real.id });
                }
              } catch (err) {
                console.warn('[ChatApp] createDM failed', err);
              }
            }
          }} />
      )}
      <div className="chat-backdrop" onClick={() => setDrawerOpen(false)} />
    </div>
  );
}

export default ChatApp;
