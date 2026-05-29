// @ts-nocheck
// Dilla chat refinement — main React app, ported verbatim from
// design_handoff_dilla_mesh/chat-app.jsx. Strict TS types come later — for
// now we just want this rendering inside Vite at /mesh.

import React from 'react';
import { Icon } from './icons';
import MessageMarkdown from '../components/MessageMarkdown/MessageMarkdown';
import { EMPTY_SHELL_DATA } from './data';
import { THEMES } from './themes';
import { useShellDataContext } from './ShellDataContext';
import { MiniMeter, VoiceDockLatency, VoiceDockBitrate } from './VoiceDockStats';
import { Avatar, PlainAvatar, memberAvatarStyle, memberAvatarClass } from './Avatar';
import { shortId } from '../utils/randomId';
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
import { resolvePermissions, PERM_MANAGE_CHANNELS, PERM_MANAGE_MEMBERS, PERM_MANAGE_MESSAGES, PERM_MUTE_VOICE } from '../hooks/usePermissions';
import { api } from '../services/api';
import { tryEncrypt } from '../hooks/useMessageDecryption';
import { useChannelLazyLoad } from '../hooks/useChannelLazyLoad';
import { useMessageStore } from '../stores/messageStore';
import { isMockSession } from '../services/mockSession';

const { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } = React;

interface StagedAttachment {
  /** Server-assigned attachment id, already uploaded. */
  id: string;
  /** Filename for the chip caption. */
  name: string;
  /** Size in bytes — drives the kB / MB suffix. */
  size: number;
  /** Mime type — used to decide image preview vs file icon. */
  type: string;
  /** blob: URL for an immediate image thumbnail before the
   *  server-attachment GET would resolve. */
  previewUrl?: string;
}
// chat-app.jsx originally read globalThis.SHELL_DATA / globalThis.THEMES / globalThis.Icon
// — keep that contract until the bindings get rewired through Zustand.
// AppShell overwrites globalThis.SHELL_DATA with the live `useShellData()`
// on every render, so this initial write is just the pre-mount
// placeholder shape (empty arrays/maps; never mock content).
const w = globalThis as unknown as Record<string, unknown>;
w.SHELL_DATA = EMPTY_SHELL_DATA;
w.THEMES = THEMES;
w.Icon = Icon;

// Helper: current user id. This is the ONE remaining `globalThis.SHELL_DATA`
// reader in the file — it's called from non-React utility helpers (eg.
// renderText, sharingId calc, mention/peer matching) where threading a
// React hook through every call site would be invasive. AppShell writes
// `globalThis.SHELL_DATA = useShellData()` on every render so the value is
// always in sync. NO `'thim'` fallback — falling through to a hardcoded
// mock id was the cause of every "thim is admin" / "messages marked as
// mine when they aren't" bug on /app. An empty string means "no user
// known", and downstream code treats that as "no match".
export function currentUserId(): string {
  return (globalThis as any).SHELL_DATA?.currentUserId || '';
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
export function pollServerToMessage(p: any, me: string) {
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

export function timeShort(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function dayLabel(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
export function groupMessages(msgs) {
  // Group consecutive messages by the same author within ~5min into stacks.
  const out = [];
  let last = null;
  msgs.forEach(m => {
    if (last?.author === m.author && m.kind === 'text' && last.kind === 'text'
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
// Avatar / PlainAvatar + memberAvatarStyle / memberAvatarClass moved
// to ./Avatar. The helpers stay exported through ChatApp via the
// re-export below so any in-flight diffs that imported them from
// here keep building.
export { memberAvatarStyle, memberAvatarClass } from './Avatar';

// MiniMeter / StatsSparkline / VoiceDockLatency / VoiceDockBitrate
// moved to ./VoiceDockStats. They were all private to this file,
// only consumed from three call sites here, and stood on their own
// from a dependency standpoint — separate module keeps this file
// from growing further.

// Modal: forward a message to another channel or DM
export function ForwardModal({ sourceMsg, members, onClose, onForward }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
  const [q, setQ] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
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
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card" style={{ width: 'min(540px, 100%)' }}>
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
export function NewDmModal({ members, onClose, onPick }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  const list = (members.MEMBERS || []).filter(m => m.id !== currentUserId() && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card" style={{ width: 'min(480px, 100%)' }}>
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
export function GroupCombobox({ value, onChange, existing }: Readonly<{
  value: string;
  onChange: (next: string) => void;
  existing: string[];
}>) {
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
            <button type="button" key={g} className="grp-opt" onMouseDown={(e) => { e.preventDefault(); commit(g); }}>
              <span className="grp-pill grp-pill-static">{g}</span>
            </button>
          ))}
          {canCreate && (
            <button type="button" className="grp-opt grp-opt-new" onMouseDown={(e) => { e.preventDefault(); commit(draft); }}>
              <span className="grp-opt-new-label">+ Create</span>
              <span className="grp-pill grp-pill-static">{draft.trim()}</span>
            </button>
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
export function GiphyPicker({
  query,
  results,
  onPick,
  onClose,
}: Readonly<{ query: string; results: Array<{ url: string; preview: string }>; onPick: (url: string) => void; onClose: () => void }>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card giphy-picker">
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

export function NewChannelModal({ onClose, onCreate }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
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
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <h2>New kanal</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <div style={{ fontWeight: 600 }}>Type</div>
            <div className="onb-seg">
              <button className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}><Icon.Hash size={11} /> Text</button>
              <button className={kind === 'voice' ? 'on' : ''} onClick={() => setKind('voice')}><Icon.Speaker size={11} /> Voice</button>
            </div>
          </div>
          <div className="modal-row">
            <div style={{ fontWeight: 600 }}>Name</div>
            <div className="modal-input-pre">
              <span className="pre-glyph">{kind === 'voice' ? '🔊' : '#'}</span>
              <input value={name} autoFocus
                     onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9 -]/g, ''))}
                     placeholder="ship-talk" />
            </div>
            {slug && <div className="modal-hint">URL: <code>dilla://{nodeHost}/k/{slug}</code></div>}
          </div>
          <div className="modal-row">
            <label>
              <span>Topic <span className="modal-opt">optional</span></span>
              <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="what's this kanal for?" />
            </label>
          </div>
          <div className="modal-row">
            <label>
              <span>Group <span className="modal-opt">optional</span></span>
              <GroupCombobox value={group} onChange={setGroup} existing={existingGroups} />
            </label>
            <div className="modal-hint">Groups collapse together in the sidebar. Leave blank for the default list.</div>
          </div>
          <div className="modal-row modal-row-h">
            <div>
              <div style={{ fontWeight: 600 }}>Private kanal</div>
              <div className="modal-hint">{priv ? 'only invited members can see this.' : 'anyone on the team can join.'}</div>
            </div>
            <button className="set-toggle" data-on={priv ? '1' : '0'} onClick={() => setPriv(p => !p)}><i /></button>
          </div>
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!ok} onClick={() => onCreate({ id: slug, name: slug, kind, topic, category: group.trim(), private: priv })}>Create kanal</button>
        </footer>
      </div>
    </div>
  );
}

// Modal: edit an existing channel's topic + slow mode (admin/maintainer).
// Patches the live record via api.updateChannel; useTeamSync's broadcast
// echoes back to the store so other clients pick up the change.
export function ChannelAccessModal({ channel, onClose }) {
  const teamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const roles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const [selected, setSelected] = useState<Set<string>>(new Set(channel?.accessRoleIds ?? []));
  const [hidden, setHidden] = useState<boolean>(!!channel?.hidden_if_restricted || !!channel?.hiddenIfRestricted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(roleId: string) {
    setSelected((prev) => toggleRoleInSet(prev, roleId));
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
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <h2>#{channel?.name} access</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <div style={{ fontWeight: 600 }}>Roles that can access this channel</div>
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
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

// Group-level access modal. Same role-checkbox pattern as ChannelAccessModal,
// but persists via api.setGroupAccess and the WS broadcasts a
// group:access-update event that every channel in the group reads through
// its inherited resolveAccessRoles — one change ripples to N channels.
export function GroupAccessModal({ group, onClose }: Readonly<{ group: { id: string; name: string; accessRoleIds: string[]; hiddenIfRestricted: boolean }; onClose: () => void }>) {
  const teamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const roles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const [selected, setSelected] = useState<Set<string>>(new Set(group.accessRoleIds ?? []));
  const [hidden, setHidden] = useState<boolean>(!!group.hiddenIfRestricted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggle(roleId: string) {
    setSelected((prev) => toggleRoleInSet(prev, roleId));
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
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <h2>{group.name} · access</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <div style={{ fontWeight: 600 }}>Roles that can see channels in this group</div>
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
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

// Rename + delete a group. Lives next to GroupAccessModal so the right-
// click context menu can hand off cleanly.
export function GroupSettingsModal({ group, onClose }: Readonly<{ group: { id: string; name: string }; onClose: () => void }>) {
  const teamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
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
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <h2>{group.name} · settings</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>
              <span>Group name</span>
              <input value={name} autoFocus onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="modal-hint">Channels stay in the group — only the header label changes.</div>
          </div>
          {confirmDelete ? (
            <div className="modal-row" style={{ border: '1px solid var(--danger)', padding: '0.75rem', borderRadius: 'var(--r-sm)' }}>
              <div style={{ color: 'var(--danger)', fontWeight: 600 }}>Delete group</div>
              <div className="modal-hint">Channels in <strong>{group.name}</strong> won't be deleted — they'll just lose the group. Restricted-by-group channels will become open.</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="btn btn--danger" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete group'}</button>
              </div>
            </div>
          ) : (
            <div className="modal-row">
              <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>Delete group…</button>
            </div>
          )}
          {err && <div className="modal-hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

export function ChannelSettingsModal({ channel, onClose }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
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
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
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
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card">
        <header className="modal-head">
          <h2>#{channel?.name} settings</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>
              <span>Topic</span>
              <input value={topic} autoFocus onChange={e => setTopic(e.target.value)} placeholder="what's this kanal for?" />
            </label>
            <div className="modal-hint">Shown at the top of the channel. Anyone with permission to send can see this.</div>
          </div>
          <div className="modal-row">
            <label>
              <span>Group <span className="modal-opt">optional</span></span>
              <GroupCombobox value={group} onChange={setGroup} existing={existingGroups} />
            </label>
            <div className="modal-hint">Channels in the same group collapse together in the sidebar. Leave blank for the default list.</div>
          </div>
          <div className="modal-row">
            <label>
              <span>Slow mode (seconds)</span>
              <input value={slow} onChange={e => setSlow(e.target.value.replace(/\D/g, ''))} placeholder="0" />
            </label>
            <div className="modal-hint">Minimum interval between messages per member. 0 disables.</div>
          </div>
          {confirmDelete ? (
            <div className="modal-row" style={{ border: '1px solid var(--danger)', padding: '0.75rem', borderRadius: 'var(--r-sm)' }}>
              <div style={{ color: 'var(--danger)', fontWeight: 600 }}>Delete kanal</div>
              <div className="modal-hint">Permanently removes <strong>#{channel?.name}</strong> and every message in it. This can't be undone.</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="btn btn--danger" disabled={busy} onClick={remove}>{busy ? 'Deleting…' : 'Delete kanal'}</button>
              </div>
            </div>
          ) : (
            <div className="modal-row">
              <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>Delete kanal…</button>
            </div>
          )}
          {err && <div className="modal-hint" style={{ color: 'var(--danger)' }}>{err}</div>}
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        </footer>
      </div>
    </div>
  );
}

// Modal: create-or-join team
export function NewServerModal({ onClose, onCreate }) {
  const [mode, setMode] = useState('create'); // create | join
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const ok = mode === 'create' ? slug.length >= 2 : token.length >= 12;
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay">
      <button type="button" className="modal-overlay-dismiss" aria-label="Close" onClick={onClose} />
      <div className="modal-card">
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
                <label>
                  <span>Team name</span>
                  <input value={name} autoFocus
                       onChange={e => setName(e.target.value)}
                       placeholder="Team name" />
                </label>
                <div className="modal-hint">A team is hosted on a node you run. You'll be the admin.</div>
              </div>
              <div className="modal-row">
                <label>
                  <span>Server URL <span className="modal-opt">optional</span></span>
                  <input defaultValue="http://localhost:8080" />
                </label>
                <div className="modal-hint">Where your <code>dilla-server</code> binary is running.</div>
              </div>
            </>
          ) : (
              <div className="modal-row">
                <label>
                  <span>Invite link or token</span>
                  <textarea rows={3} value={token} onChange={e => setToken(e.target.value)}
                          placeholder="dilla.gbg/invite/4F7A · or paste a full URL"></textarea>
                </label>
                <div className="modal-hint">Single-use or capped invites. The server validates this before binding your identity.</div>
              </div>
          )}
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!ok} onClick={() => onCreate({
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
export function EmptyFeed({ channel, dmPartner }) {
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
export function ProfilePopover({ pop, onClose, onDM, federated }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
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
  const nodes = globalThis.MeshChrome?.MEMBER_NODES || {};
  const fps = globalThis.MeshChrome?.FINGERPRINTS || {};
  const node = nodes[m.id] || '';
  const fed = federated && node && !node.includes('gbg-1');
  // Clamp position to viewport
  const W = 260, H = 240;
  const x = Math.min(globalThis.innerWidth - W - 8, Math.max(8, pop.x));
  const y = Math.min(globalThis.innerHeight - H - 8, Math.max(8, pop.y));
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
          <button className="btn btn--primary btn--block" onClick={() => { onDM(m.id); onClose(); }}>Send message</button>
          <button className="btn btn--block" onClick={onClose}>View profile</button>
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
export function EmojiPicker({ open, onClose, onPick, anchorRect }) {
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
  const x = Math.min(globalThis.innerWidth - W - 8, Math.max(8, r.left + r.width - W));
  const y = Math.max(8, r.top - H - 6);
  return (
    <div className="emoji-pick" ref={ref} style={{ position: 'fixed', left: x, top: y, width: W }}>
      <div className="ep-head">
        <span>Frequently used</span>
        <button className="ep-x" onClick={onClose}>×</button>
      </div>
      <div className="ep-grid">
        {EMOJIS.map(e => (
          <button key={e} className="btn btn--ghost btn--icon btn--sm" onClick={() => onPick(e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}

// Drag-to-resize handle for the sidebar and members columns.
export function ResizeHandle({ kind, value, onResize, min = 180, max = 380 }) {
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
      globalThis.removeEventListener('mousemove', move);
      globalThis.removeEventListener('mouseup', up);
    }
    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mouseup', up);
  }
  return <button type="button" aria-label="drag to resize" className={'resize-handle resize-' + kind} onMouseDown={onDown} title="drag to resize" />;
}

// Thread panel — opens when clicking a thread-preview on a message.
export function ThreadPanel({ channelId, messageId, members, onClose, onReact }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
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
                      <button type="button" key={`${rx.e}-${i}`}
                            className={'rxn' + (rx.mine ? ' mine' : '')}
                            onClick={makeToggleThreadRxn(setReplies, r.id, rx.e)}>
                        <span>{rx.e}</span><span>{rx.n}</span>
                      </button>
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
            <button className="btn btn--primary btn--icon" disabled={!draft.trim()} onClick={send} title="Send (↵)">
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
export function VideoTile({ stream, fit = 'cover', mirror, showStats = true }: Readonly<{ stream: MediaStream; fit?: 'cover' | 'contain'; mirror?: boolean; showStats?: boolean }>) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [stats, setStats] = useState<{ w: number; h: number; fps: number } | null>(null);
  const [bitrate, setBitrate] = useState<number | null>(null);

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
        setStats((prev) => (prev?.w === meta.width && prev?.h === meta.height ? prev : { ...(prev ?? { fps: 0 }), w: meta.width, h: meta.height }));
      }
      rvfc?.call(el, onFrame);
    };
    rvfc?.call(el, onFrame);

    const id = globalThis.setInterval(() => {
      const w = el.videoWidth;
      const h = el.videoHeight;
      if (w === 0 || h === 0) return;
      const fps = frameCount;
      frameCount = 0;
      setStats({ w, h, fps });
    }, 1000);

    return () => {
      cancelled = true;
      globalThis.clearInterval(id);
    };
  }, [stream]);

  // Per-track bitrate from RTCPeerConnection.getStats(track). Works for
  // both incoming (inbound-rtp) and outgoing (outbound-rtp) senders/receivers
  // because we look up by the underlying track on whichever PC owns it.
  useEffect(() => {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const pc = useVoiceStore.getState().peerConnection;
    if (!pc) return;
    let lastBytes = 0;
    let lastTs = 0;
    const id = globalThis.setInterval(() => {
      pc.getStats(track)
        .then((report) => {
          const { bytes, ts } = sumVideoRtpStats(report);
          if (lastTs > 0 && ts > lastTs && bytes >= lastBytes) {
            const dtSec = (ts - lastTs) / 1000;
            const dBytes = bytes - lastBytes;
            const kbps = Math.round((dBytes * 8) / dtSec / 1000);
            setBitrate(kbps);
          }
          lastBytes = bytes;
          lastTs = ts;
        })
        .catch(() => { /* track gone, stats throw — fine */ });
    }, 1000);
    return () => globalThis.clearInterval(id);
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
      {showStats && stats && (
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
          {stats.w}×{stats.h} · {stats.fps}fps{bitrate == null ? '' : ` · ${bitrate} kbps`}
        </div>
      )}
    </div>
  );
}

// Floating, draggable + resizable picture-in-picture wrapper.
// Manipulates left/top/width/height directly on the underlying ref so
// drag and resize don't trigger React re-renders — buttery interaction
// even when the inner <video> is rendering. Resize handles cover all
// 4 corners and 4 edges; drag is the body itself. A click without
// meaningful movement still fires `onClick` so the pip-swap focus-
// toggle behavior keeps working.
type VoiceFocusKind = 'cam' | 'screen';
type VoiceCardKind = VoiceFocusKind | 'avatar';
type DragHandle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type PipStart = { startL: number; startT: number; startW: number; startH: number };
type PipDelta = PipStart & { dx: number; dy: number };
type PipResizeInput = PipDelta & { minW: number; minH: number };
type PipBox = { l: number; t: number; w: number; h: number };

function applyPipTranslate(
  el: HTMLElement,
  parentBox: { width: number; height: number },
  d: PipDelta,
): void {
  let l = d.startL + d.dx;
  let t = d.startT + d.dy;
  l = Math.max(0, Math.min(l, parentBox.width - d.startW));
  t = Math.max(0, Math.min(t, parentBox.height - d.startH));
  el.style.left = `${l}px`;
  el.style.top = `${t}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
}

function applyDirectionalResize(handle: DragHandle, d: PipDelta): PipBox {
  let l = d.startL, t = d.startT, w = d.startW, h = d.startH;
  if (handle.includes('n')) { t += d.dy; h -= d.dy; }
  if (handle.includes('s')) { h += d.dy; }
  if (handle.includes('w')) { l += d.dx; w -= d.dx; }
  if (handle.includes('e')) { w += d.dx; }
  return { l, t, w, h };
}

function enforceAspectRatio(
  handle: DragHandle,
  box: PipBox,
  start: PipStart,
): PipBox {
  const aspect = start.startW / start.startH;
  const onlyW = handle === 'e' || handle === 'w';
  const onlyH = handle === 'n' || handle === 's';
  let { w, h } = box;
  if (onlyW) h = w / aspect;
  else if (onlyH) w = h * aspect;
  else if (Math.abs(w - start.startW) > Math.abs(h - start.startH) * aspect) h = w / aspect;
  else w = h * aspect;
  let { l, t } = box;
  if (handle.includes('n')) t = start.startT + (start.startH - h);
  if (handle.includes('w')) l = start.startL + (start.startW - w);
  return { l, t, w, h };
}

function enforceMinSize(
  handle: DragHandle,
  box: PipBox,
  start: PipStart,
  minW: number,
  minH: number,
): PipBox {
  let { l, t, w, h } = box;
  if (w < minW) {
    const ratio = minW / w;
    w = minW;
    h = h * ratio;
    if (handle.includes('w')) l = start.startL + (start.startW - w);
    if (handle.includes('n')) t = start.startT + (start.startH - h);
  }
  if (h < minH) {
    const ratio = minH / h;
    h = minH;
    w = w * ratio;
    if (handle.includes('w')) l = start.startL + (start.startW - w);
    if (handle.includes('n')) t = start.startT + (start.startH - h);
  }
  return { l, t, w, h };
}

function enforceMaxSize(
  box: PipBox,
  parentBox: { width: number; height: number },
): PipBox {
  let { l, t, w, h } = box;
  if (w > parentBox.width) {
    const ratio = parentBox.width / w;
    w = parentBox.width;
    h = h * ratio;
  }
  if (h > parentBox.height) {
    const ratio = parentBox.height / h;
    h = parentBox.height;
    w = w * ratio;
  }
  l = Math.max(0, Math.min(l, parentBox.width - w));
  t = Math.max(0, Math.min(t, parentBox.height - h));
  return { l, t, w, h };
}

function resolvePipResizeBox(
  handle: DragHandle,
  input: PipResizeInput,
  parentBox: { width: number; height: number },
): PipBox {
  const start: PipStart = {
    startL: input.startL, startT: input.startT,
    startW: input.startW, startH: input.startH,
  };
  const directional = applyDirectionalResize(handle, input);
  const ratioed = enforceAspectRatio(handle, directional, start);
  const minClamped = enforceMinSize(handle, ratioed, start, input.minW, input.minH);
  return enforceMaxSize(minClamped, parentBox);
}

export function FloatingPip({
  className,
  children,
  onClick,
  title,
  minW = 80,
  minH = 60,
}: Readonly<{
  className: string;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
  minW?: number;
  minH?: number;
}>) {
  const ref = useRef<HTMLDivElement | null>(null);
  // When the stage around the PIP resizes (e.g. switching focus
  // mode normal ↔ tab ↔ screen), rescale our inline left/top/
  // width/height proportionally so the user's drag-positioned PIP
  // stays in roughly the same relative spot and ends up inside the
  // new stage bounds — instead of stranded outside or stuck at
  // pixel coords that mean something totally different.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const parent = (el.offsetParent as HTMLElement) || null;
    if (!parent) return;
    let prev = parent.getBoundingClientRect();
    const ro = new ResizeObserver(() => {
      const next = parent.getBoundingClientRect();
      if (!prev.width || !prev.height || !next.width || !next.height) {
        prev = next;
        return;
      }
      const rW = next.width / prev.width;
      const rH = next.height / prev.height;
      const scale = Math.min(rW, rH);
      // Only rescale when WE have set inline values (otherwise the
      // CSS-default bottom/right anchor handles things just fine).
      if (el.style.left) {
        const l = Number.parseFloat(el.style.left) * rW;
        const t = Number.parseFloat(el.style.top) * rH;
        const w = (Number.parseFloat(el.style.width) || el.offsetWidth) * scale;
        const h = (Number.parseFloat(el.style.height) || el.offsetHeight) * scale;
        const clampedL = Math.max(0, Math.min(l, next.width - w));
        const clampedT = Math.max(0, Math.min(t, next.height - h));
        el.style.left = `${clampedL}px`;
        el.style.top = `${clampedT}px`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
      }
      prev = next;
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);
  const start = useCallback((handle: DragHandle, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const parent = (el.offsetParent as HTMLElement) || document.body;
    const rect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startL = rect.left - parentRect.left;
    const startT = rect.top - parentRect.top;
    const startW = rect.width;
    const startH = rect.height;
    let moved = false;
    const parentBox = parent.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      if (handle === 'move') {
        applyPipTranslate(el, parentBox, { startL, startT, startW, startH, dx, dy });
        return;
      }
      const box = resolvePipResizeBox(handle, { startL, startT, startW, startH, dx, dy, minW, minH }, parentBox);
      el.style.left = `${box.l}px`;
      el.style.top = `${box.t}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (handle === 'move' && !moved && onClick) onClick();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onClick, minW, minH]);
  return (
    <div
      ref={ref}
      className={`${className} pip-wrap`}
      title={title}
      aria-label={title || 'Floating picture-in-picture'}
    >
      <button
        type="button"
        className="pip-move-handle"
        aria-label="Drag to move; click without dragging to activate"
        onMouseDown={(e) => start('move', e)}
      />
      {children}
      <button type="button" aria-label="Resize PIP from top edge" className="pip-edge pip-n"  onMouseDown={(e) => start('n', e)} />
      <button type="button" aria-label="Resize PIP from bottom edge" className="pip-edge pip-s"  onMouseDown={(e) => start('s', e)} />
      <button type="button" aria-label="Resize PIP from right edge" className="pip-edge pip-e"  onMouseDown={(e) => start('e', e)} />
      <button type="button" aria-label="Resize PIP from left edge" className="pip-edge pip-w"  onMouseDown={(e) => start('w', e)} />
      <button type="button" aria-label="Resize PIP from top-left" className="pip-edge pip-nw" onMouseDown={(e) => start('nw', e)} />
      <button type="button" aria-label="Resize PIP from top-right" className="pip-edge pip-ne" onMouseDown={(e) => start('ne', e)} />
      <button type="button" aria-label="Resize PIP from bottom-right" className="pip-edge pip-se" onMouseDown={(e) => start('se', e)} />
      <button type="button" aria-label="Resize PIP from bottom-left" className="pip-edge pip-sw" onMouseDown={(e) => start('sw', e)} />
    </div>
  );
}

export function CamTile({ member, mini, showStats = false }) {
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
        <VideoTile stream={stream} fit={mini ? 'contain' : 'cover'} mirror={isSelf} showStats={showStats && !mini} />
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
export function ScreenTile({ member, pip, showStats = false }: Readonly<{ member: any; pip: any; showStats?: boolean }>) {
  const isSelf = member.id === currentUserId();
  const localScreen = useVoiceStore((s) => s.localScreenStream);
  const remoteScreen = useVoiceStore((s) => s.remoteScreenStreams?.[member.id] ?? null);
  const stream = isSelf ? localScreen : remoteScreen;
  if (stream) {
    return (
      <div className="screen-tile" style={{ overflow: 'hidden' }}>
        {/* Screen-share ALWAYS uses `contain` — cropping a desktop screen
            (top/bottom of a long window, or sides of a wide one) defeats
            the purpose of sharing it. Black letterbox bars are fine. */}
        <VideoTile stream={stream} fit="contain" showStats={showStats} />
        {pip && (
          <FloatingPip className="screen-pip" minW={64} minH={36}>
            <CamTile member={pip} mini />
          </FloatingPip>
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
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <span key={`side-line-${50 + ((i * 17) % 40)}-${i}`} className="screen-side-line" style={{ width: (50 + ((i * 17) % 40)) + '%' }} />
          ))}
        </div>
        <div className="screen-editor">
          {lines.map((w, i) => (
            <div key={`row-${i}-${w}`} className="screen-row">
              <span className="screen-num">{i + 1}</span>
              <span className="screen-line" style={{ width: w + '%' }} />
            </div>
          ))}
        </div>
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
export function ServerRail({ servers, activeServer, onPick }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
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
        <button key={s.id}
             type="button"
             className={'rail-item' + (s.id === activeServer ? ' active' : '') + (overId === s.id && dragId && dragId !== s.id ? ' drop-target' : '') + (dragId === s.id ? ' dragging' : '')}
             draggable
             onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
             onDragOver={(e) => { e.preventDefault(); setOverId(s.id); }}
             onDragLeave={() => { if (overId === s.id) setOverId(null); }}
             onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== s.id) { reorder(dragId, s.id); } setDragId(null); setOverId(null); }}
             onDragEnd={() => { setDragId(null); setOverId(null); }}
             onClick={() => onPick(s.id)}
             onContextMenu={(e) => {
               e.preventDefault();
               globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
                 detail: { x: e.clientX, y: e.clientY, items: buildRailContextMenu(s, data) },
               }));
             }}
             title={s.name}>
          {s.short}
          {!s.federated && <span className="rail-dot" style={{ background: 'var(--warn)' }}></span>}
        </button>
      ))}
      <button className="rail-add" title="Add team" onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:open-add-server'))}><Icon.Plus /></button>
    </aside>
  );
}

// ───────────── channel sidebar ─────────────
export function ChannelSidebar({ team, tab, onTab, channels, activeChannel, onPickChannel,
                          voiceConnection, members, dms, activeDM, onPickDM,
                          onLeaveVoice, onJoinVoice, mute, setMute, deaf, setDeaf, cam, setCam, screen, setScreen,
                          mutedChannels = new Set(), toggleMuteChannel, onNewDm }) {
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
  const nodeHost = data?.SERVERS?.[0]?.node || 'local';
  // Local user's VAD-driven speaking flag, scoped subscription so the
  // re-render is contained to this sidebar component only.
  const selfSpeaking = useVoiceStore((s) => s.speaking);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [orderOverride, setOrderOverride] = useState(null); // [ids…]
  const isAdminHere = !!members?.byId?.[currentUserId()]?.isAdmin;
  // Pull the team's role catalog so we can identify the implicit
  // "everyone" role and resolve which channels the current user can enter.
  // activeTeamId isn't a prop here — read it from the store directly.
  const sidebarTeamId = useTeamStore((s) => s.activeTeamId);
  const teamRoles = useTeamStore((s) => (sidebarTeamId ? s.roles.get(sidebarTeamId) ?? EMPTY_LIST : EMPTY_LIST)) as any[];
  const teamMembers = useTeamStore((s) => (sidebarTeamId ? s.members.get(sidebarTeamId) ?? EMPTY_LIST : EMPTY_LIST)) as any[];
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
    if (typeof globalThis === 'undefined' || !collapsedKey) return new Set();
    try {
      const raw = globalThis.localStorage.getItem(collapsedKey);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    if (!collapsedKey) return;
    try {
      const raw = globalThis.localStorage.getItem(collapsedKey);
      setCollapsedGroups(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch { setCollapsedGroups(new Set()); }
  }, [collapsedKey]);
  const toggleGroupCollapsed = (cat: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      if (collapsedKey) {
        try { globalThis.localStorage.setItem(collapsedKey, JSON.stringify([...next])); }
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
        <button className="icon-btn" title="Team settings" onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'team' }))}>
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
                  <button
                    type="button"
                    className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.locked && !canJoinChannel(c) ? ' locked' : '')}
                    onClick={() => onPickChannel(c.id)}
                    onDoubleClick={() => { if (canJoinChannel(c)) onJoinVoice?.(c.id); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const items = buildActiveVoiceChannelMenu(c, voiceConnection?.channelId === c.id, canJoinChannel(c), perms.has(PERM_MANAGE_CHANNELS), nodeHost, onJoinVoice, onLeaveVoice);
                      globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items } }));
                    }}>
                    <span className="ch-glyph"><Icon.Speaker size={14} /></span>
                    <span className="ch-name">{c.name}</span>
                    {isRestricted(c) && <span style={{ color: 'var(--fg-3)' }} title="restricted access"><Icon.Lock size={11} /></span>}
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-3)' }}>
                      {(c.participants||[]).length}
                    </span>
                  </button>
                  <div className="voice-participants">
                    {(c.participants || []).map(pid => {
                      const m = members.byId[pid];
                      const peer = c.voicePeers?.[pid];
                      // For self, the local toggles are the source of
                      // truth (the peer object the server echoes back
                      // may not carry our local mute/cam/screen flags
                      // until we explicitly propagate them). For remote
                      // peers, read from peer.* which comes from the
                      // throttled voice:state broadcast.
                      const isSelf = pid === currentUserId();
                      const muted = isSelf ? mute : !!peer?.muted;
                      const deafened = isSelf ? deaf : !!peer?.deafened;
                      const screenOn = isSelf ? screen : !!peer?.screen_sharing;
                      const camOn = isSelf ? cam : !!peer?.webcam_sharing;
                      // Show speaking for everyone, including self.
                      // For self we read voice.speaking (VAD-driven);
                      // for remote peers we read peer.speaking from the
                      // throttled server voice:state broadcast. Muted
                      // peers don't get the indicator.
                      const speaking = !muted && (isSelf ? selfSpeaking : !!peer?.speaking);
                      return (
                        <article key={pid} className={'voice-participant' + (speaking ? ' speaking' : '') + (muted ? ' muted' : '')}
                             onContextMenu={(e) => {
                               e.preventDefault();
                               globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
                                 detail: { x: e.clientX, y: e.clientY, items: buildVoiceParticipantMenu(m, pid, c.id, muted, perms.has(PERM_MUTE_VOICE), sidebarTeamId) },
                               }));
                             }}>
                          <div className={memberAvatarClass(m, 'vp-avatar')} style={memberAvatarStyle(m)}>{!m.avatarUrl && m.initials}</div>
                          <span className="vp-name">{m.name}</span>
                          <div className="vp-state">
                            {speaking && <MiniMeter />}
                            {camOn && <span className="vp-icon screen" title="camera on"><Icon.Video size={11} /></span>}
                            {screenOn && <span className="vp-icon screen" title="sharing screen"><Icon.Screen size={11} /></span>}
                            {deafened && <span className="vp-icon mute" title="deafened"><Icon.Headphones size={11} off /></span>}
                            {muted && <span className="vp-icon mute" title="muted"><Icon.Mic size={11} off /></span>}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

          {groupByCategory(textChs, 'Kanals').map((grp, gi) => (
            <React.Fragment key={'tg-' + grp.key}>
              <div className="cat cat-row">
                <button
                  type="button"
                  className="cat-collapsible"
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
                    globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
                      detail: { x: e.clientX, y: e.clientY, items: buildGroupContextMenu(groupId) },
                    }));
                  }}
                >
                  <span className="cat-chev" style={{ transform: collapsedGroups.has(grp.key) ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                  <span>{grp.label}</span>
                </button>
                {gi === 0 && (
                  <div className="cat-actions"><button className="icon-btn" title="New kanal" onClick={(e) => { e.stopPropagation(); globalThis.dispatchEvent(new CustomEvent('dilla:open-new-channel')); }}><Icon.Plus size={12} /></button></div>
                )}
              </div>
              {!collapsedGroups.has(grp.key) && grp.channels.map(c => (
            <button key={c.id}
                 type="button"
                 draggable
                 onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
                 onDragOver={(e) => { e.preventDefault(); setOverId(c.id); }}
                 onDragLeave={() => { if (overId === c.id) setOverId(null); }}
                 onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== c.id) { reorderTextCh(dragId, c.id); } setDragId(null); setOverId(null); }}
                 onDragEnd={() => { setDragId(null); setOverId(null); }}
                 className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.unread > 0 ? ' unread' : '') + (mutedChannels.has(c.id) ? ' muted' : '') + (overId === c.id && dragId && dragId !== c.id ? ' drop-target' : '') + (dragId === c.id ? ' dragging' : '')}
                 onClick={() => onPickChannel(c.id)}
                 onContextMenu={(e) => {
                   e.preventDefault();
                   globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
                     detail: { x: e.clientX, y: e.clientY, items: buildTextChannelMenu(c, data, mutedChannels, toggleMuteChannel, nodeHost, perms.has(PERM_MANAGE_CHANNELS)) },
                   }));
                 }}>
              <span className="ch-glyph"><Icon.Hash size={14} /></span>
              <span className="ch-name">{c.name}</span>
              {isRestricted(c) && <span style={{ color: 'var(--fg-3)' }} title="restricted access"><Icon.Lock size={11} /></span>}
              {mutedChannels.has(c.id) && <span className="ch-muted" title="muted"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M2 6h2l3-3v10l-3-3H2zM10 5l3 3-3 3M13 5l-3 3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>}
              {c.unread > 0 && !mutedChannels.has(c.id) && (
                <span className={'unread-pill' + (c.mention ? ' mention' : '')}>{c.unread}</span>
              )}
            </button>
          ))}
            </React.Fragment>
          ))}

          {otherVoice.length > 0 && groupByCategory(otherVoice, 'Voice').map((grp) => (
            <React.Fragment key={'vg-' + grp.key}>
              <button
                type="button"
                className="cat cat-collapsible"
                onClick={() => toggleGroupCollapsed('voice:' + grp.key)}
                title={collapsedGroups.has('voice:' + grp.key) ? 'Expand' : 'Collapse'}
                onContextMenu={(e) => {
                  if (!grp.key.startsWith('g:')) return;
                  if (!perms.has(PERM_MANAGE_CHANNELS)) return;
                  e.preventDefault();
                  const groupId = grp.key.slice(2);
                  globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
                    detail: { x: e.clientX, y: e.clientY, items: buildGroupContextMenu(groupId) },
                  }));
                }}
              >
                <span className="cat-chev" style={{ transform: collapsedGroups.has('voice:' + grp.key) ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▾</span>
                <span>{grp.label}</span>
              </button>
              {!collapsedGroups.has('voice:' + grp.key) && grp.channels.map(c => (
                <button
                     type="button"
                     key={c.id}
                     className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.locked && !canJoinChannel(c) ? ' locked' : '')}
                     onClick={() => onPickChannel(c.id)}
                     onDoubleClick={() => { if (canJoinChannel(c)) onJoinVoice?.(c.id); }}
                     onContextMenu={(e) => {
                       e.preventDefault();
                       const items = buildVoiceChannelMenu(c, canJoinChannel(c), perms.has(PERM_MANAGE_CHANNELS), nodeHost, onPickChannel, onJoinVoice);
                       globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items } }));
                     }}>
                  <span className="ch-glyph"><Icon.Speaker size={14} /></span>
                  <span className="ch-name">{c.name}</span>
                  {isRestricted(c) && <span style={{ color: 'var(--fg-3)' }} title="restricted access"><Icon.Lock size={11} /></span>}
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div className="side-scroll">
          <div className="cat"><span>Direct Messages</span>
            <div className="cat-actions"><button className="icon-btn" title="New DM" onClick={() => onNewDm?.()}><Icon.Plus size={12} /></button></div>
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
              <button type="button" key={d.id}
                   className={'channel-row' + (d.id === activeDM ? ' active' : '') + (d.unread > 0 ? ' unread' : '')}
                   onClick={() => onPickDM(d.id)}
                   onContextMenu={(e) => {
                     e.preventDefault();
                     globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
                       detail: { x: e.clientX, y: e.clientY, items: buildDmContextMenu(d, data, mutedChannels, toggleMuteChannel) },
                     }));
                   }}>
                {isGroup ? (
                  <span className="ch-glyph"><Icon.People size={14} /></span>
                ) : (
                  <div className="vp-avatar" style={{ background: other.color, width: 20, height: 20, fontSize: 10 }}>{other.initials}</div>
                )}
                <span className="ch-name">{name}</span>
                {d.unread > 0 && <span className="unread-pill mention">{d.unread}</span>}
              </button>
            );
          })}
        </div>
      )}

      {(() => {
        // Show the dock always — when not in voice the controls work
        // as pre-set toggles (mute/deaf/cam/screen state survives into
        // the next join) and the hangup button is replaced with a
        // Join button that activates when the currently-selected
        // channel is a joinable voice channel.
        const inVoice = !!voiceConnection;
        const activeCh = channels.find((c) => c.id === activeChannel);
        const activeIsVoice = activeCh?.type === 'voice';
        const canJoinSelected = !inVoice && activeIsVoice && canJoinChannel(activeCh);
        return (
          <div className="voice-dock">
            {/* Render the stats row always and toggle via .is-hidden
                so we get a CSS max-height / opacity transition on
                join/leave instead of a hard mount/unmount snap. */}
            <div className={'voice-dock-stats' + (inVoice ? '' : ' is-hidden')}>
              <VoiceDockBitrate />
              <VoiceDockLatency />
            </div>
            <div className="voice-dock-controls">
              <button className={'vctrl' + (mute ? ' active' : '')} title={mute ? "Unmute" : "Mute"} onClick={() => { console.log('[Voice/diag] UI click: mute', { wasMuted: mute, willMute: !mute, inVoice }); setMute(!mute); }}>
                <Icon.Mic size={14} off={mute} />
              </button>
              <button className={'vctrl' + (deaf ? ' active' : '')} title={deaf ? "Undeafen" : "Deafen"} onClick={() => { console.log('[Voice/diag] UI click: deafen', { wasDeaf: deaf, willDeaf: !deaf, inVoice }); setDeaf(!deaf); }}>
                <Icon.Headphones size={14} off={deaf} />
              </button>
              <button
                className={'vctrl' + (cam ? ' on' : '') + (inVoice ? '' : ' is-disabled')}
                disabled={!inVoice}
                title={(() => {
                  if (!inVoice) return 'Join voice to use the camera';
                  return cam ? 'Stop camera' : 'Start camera';
                })()}
                onClick={() => { console.log('[Voice/diag] UI click: cam', { wasOn: cam, willStart: !cam, inVoice }); if (inVoice) setCam(!cam); }}
              >
                <Icon.Video size={14} off={!cam} />
              </button>
              <button
                className={'vctrl' + (screen ? ' on' : '') + (inVoice ? '' : ' is-disabled')}
                disabled={!inVoice}
                title={(() => {
                  if (!inVoice) return 'Join voice to share your screen';
                  return screen ? 'Stop sharing' : 'Share screen';
                })()}
                onClick={() => { console.log('[Voice/diag] UI click: screen', { wasOn: screen, willStart: !screen, inVoice }); if (inVoice) setScreen(!screen); }}
              >
                <Icon.Screen size={14} off={!screen} />
              </button>
              {inVoice ? (
                <button className="vctrl danger" title="Disconnect" onClick={() => { console.log('[Voice/diag] UI click: hangup'); onLeaveVoice(); }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor"/></svg>
                </button>
              ) : (
                <button
                  className={'vctrl join' + (canJoinSelected ? '' : ' is-disabled')}
                  disabled={!canJoinSelected}
                  title={canJoinSelected ? `Join ${activeCh!.name}` : 'Select a voice channel to enable join'}
                  onClick={() => { console.log('[Voice/diag] UI click: join', { channelId: activeCh?.id, channelName: activeCh?.name, canJoin: canJoinSelected }); if (canJoinSelected) onJoinVoice?.(activeCh!.id); }}
                >
                  <Icon.Speaker size={14} />
                </button>
              )}
            </div>
          </div>
        );
      })()}

      <UserPanel member={members.byId[currentUserId()]} />
    </aside>
  );
}

export function UserPanel({ member }) {
  // `member` can legitimately be undefined for a beat after sign-in —
  // currentUserId() reads from globalThis.SHELL_DATA which AppShell refreshes
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
        <button className="icon-btn" title="Preferences" onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'user' }))}>
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
              <button className="btn" onClick={() => {
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
export function TextChannel({ channel, messages, members, dmPartner, draft, setDraft, onSend, onReact, onVote, onEdit, onDelete, onAttach, pendingAttachments, onRemoveAttachment, replyTo, onSetReply, typing, onJoinVoice, membersOpen, onToggleMembers, slowModeLock }) {
  // Viewer permissions for this team, used to gate the message context
  // menu (pin / unpin / delete-others). Mirrors the server's
  // require_permission gates so we don't dangle an action that 403s.
  const tcTeamId = useTeamStore((s) => s.activeTeamId);
  const tcTeamMembers = useTeamStore((s) => (tcTeamId ? s.members.get(tcTeamId) ?? EMPTY_LIST : EMPTY_LIST)) as any[];
  const msgPerms = useMemo(
    () => resolvePermissions(tcTeamMembers, currentUserId()),
    [tcTeamMembers],
  );
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const feedRef = useRef(null);
  // Scroll-up to fetch older messages. The hook is a no-op on /mesh
  // (mock sessions) since there's no server to page against.
  useChannelLazyLoad(channel.id, feedRef);
  const emojiBtnRef = useRef(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Auto-grow the composer as Shift+Enter adds rows: reset to single-
  // line, then snap to scrollHeight so the box expands to fit content
  // (capped by max-height in CSS, beyond which the textarea scrolls
  // internally). Runs synchronously before paint so the user never
  // sees a one-line snap of multi-line content.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [draft]);
  const [picker, setPicker] = useState({ open: false, anchor: null, target: 'draft' });
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [forwardId, setForwardId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]);
  // Lightbox model: when a message has multiple image attachments,
  // clicking one opens the modal with the full gallery + the index of
  // the clicked image. Left/Right keys (and the on-screen chevrons)
  // cycle within that single message's images; Escape closes.
  const [lightbox, setLightbox] = useState<{ sources: string[]; index: number } | null>(null);
  const openLightbox = (sources: string[], index: number) =>
    setLightbox({ sources, index });
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => handleLightboxKey(e, setLightbox);
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [lightbox]);
  const [unreadAt, setUnreadAt] = useState(null);
  const [mention, setMention] = useState(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [slash, setSlash] = useState(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
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

  const slashMatches = slash
    ? SLASH_COMMANDS.filter(s => s.cmd.startsWith('/' + slash.query))
    : [];

  function applyMention(name) {
    applyMentionToDraft(name, draft, textareaRef, setDraft, setMention, setMentionIdx);
  }
  function applySlash(cmd) {
    applySlashCommand(cmd, textareaRef, setDraft, setSlash, setSlashIdx);
  }

  // Hidden file input + ref so the paperclip button can open the OS picker.
  // Selecting one or more files calls handleFiles → real File objects flow
  // to onAttach which uploads via api.uploadFile.
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFiles(files: File[]) {
    queueFileUploads(files, setUploads, onAttach);
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

  useEffect(() => trackFeedScrollPosition(feedRef, userPagedUpRef), [channel.id]);

  // Instant scroll-to-bottom helper. `.feed` has scroll-behavior:
  // smooth set for the user-facing "jump to latest" button; that
  // would otherwise animate every programmatic snap and let
  // late-loading media interrupt the animation mid-flight, leaving
  // Reset follow state whenever we switch channels. We also schedule
  // a few retries over the next second to catch late-loading images
  // and other content that grows the feed after our initial snap —
  // ResizeObserver covers most of those, but giphy/CDN media that
  // mounts <img> elements asynchronously sometimes lands between
  // observer cycles.
  useLayoutEffect(() => scheduleFeedSnapRetries(feedRef, userPagedUpRef), [channel.id]);

  // Stick to bottom after any commit that changed the messages array.
  // useLayoutEffect runs synchronously after DOM mutations and before
  // paint, so the user never sees a half-scrolled feed.
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (!userPagedUpRef.current) snapInstant(el);
  }, [messages]);

  // Late-loading media: when an image (or any child's intrinsic size)
  // arrives after the layout that triggered our useLayoutEffect, re-
  // snap to bottom unless the user has paged up in the meantime.
  useEffect(() => observeFeedForLateMedia(feedRef.current, userPagedUpRef), [channel.id]);

  useEffect(() => trackJumpButtonVisibility(feedRef, setShowJump), [channel.id]);

  function scrollToBottom() {
    if (feedRef.current) {
      feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
    }
  }

  const seenDays = new Set();

  // Drag-and-drop attach. dragOver flips on first dragenter that
  // carries files, off on a coordinated dragleave/drop. A counter
  // balances enter/leave fired for every child element the pointer
  // crosses so a quick swipe doesn't flicker the overlay.
  const dragCounterRef = useRef(0);
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types || []).includes('Files');
  function onDragEnter(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setDragOver(true);
  }
  function onDragOverEvt(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e: React.DragEvent) {
    if (!hasFiles(e)) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragOver(false);
  }

  return (
    <main
      className="main"
      onDragEnter={onDragEnter}
      onDragOver={onDragOverEvt}
      onDragLeave={onDragLeave}
      onDrop={(e) => { dragCounterRef.current = 0; onDrop(e); }}
    >
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-glyph"><Icon.Attach size={36} /></div>
            <div className="drop-title">Drop to attach</div>
            <div className="drop-sub">files are encrypted on this device before upload · Signal sender keys for {channel.type === 'dm' ? 'this DM' : '#' + channel.name}</div>
          </div>
        </div>
      )}
      <div className="main-head">
        <div className="ch-title">
          {renderChannelTitle(channel, dmPartner)}
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
              {threadsOpen && (
                <ThreadsPop
                  channel={channel}
                  messages={messages}
                  members={members}
                  onClose={() => setThreadsOpen(false)}
                />
              )}
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
                <SavedPop
                  savedMsgs={savedMsgs}
                  data={data}
                  onClose={() => setSavedOpen(false)}
                  onJump={(chanName) => { setSavedOpen(false); setActiveChannel(chanName); setActiveView({ kind: 'channel', id: chanName }); }}
                />
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
                <PinnedPop
                  channel={channel}
                  pinnedMsgs={pinnedMsgs}
                  membersById={members.byId}
                  onClose={() => setPinnedOpen(false)}
                  setPinnedOpen={setPinnedOpen}
                  feedRef={feedRef}
                />
              )}
            </div>
          )}
          {channel.type !== 'dm' && <button className={'icon-btn' + (membersOpen ? '' : ' off')}
                  title={membersOpen ? 'Hide members' : 'Show members'}
                  onClick={onToggleMembers}>
            <Icon.People size={14} />
          </button>}
          <button type="button" className="search-box"
               onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:open-search', { detail: { scopeChannel: channel.id, scopeName: channel.name } }))}>
            <Icon.Search size={13} />
            <span>{channel.type === 'dm' ? 'Search this DM…' : 'Search in #' + channel.name + '…'}</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.7 }}>/</span>
          </button>
        </div>
      </div>

      <div className="feed" ref={feedRef}>
        {groups.length === 0 ? (
          <EmptyFeed channel={channel} dmPartner={dmPartner} />
        ) : groups.map((g, i) => {
          const dayKey = g.at.toDateString();
          const showDay = !seenDays.has(dayKey);
          seenDays.add(dayKey);
          const showUnreadAbove = unreadAt && g.children?.[0]?.id === unreadAt;
          const author = members.byId[g.author] || { name: g.author, color: '#666', initials: '??' };
          if (g.base.kind === 'system') {
            return (
              <SystemMessageRow
                key={`sys-${g.base.id ?? i}`}
                base={g.base}
                showDay={showDay}
                dayText={dayLabel(g.at)}
              />
            );
          }
          return (
            <React.Fragment key={`grp-${g.base.id ?? i}`}>
              {showDay && <div className="day-divider">{dayLabel(g.at)}</div>}
              {showUnreadAbove && (
                <div className="unread-divider"><span>new</span></div>
              )}
              {g.children.map((m, idx) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  idx={idx}
                  author={author}
                  groupAuthor={g.author}
                  channel={channel}
                  members={members}
                  messages={messages}
                  feedRef={feedRef}
                  pinnedSet={pinnedSet}
                  editingId={editingId}
                  editDraft={editDraft}
                  setEditDraft={setEditDraft}
                  saveEdit={saveEdit}
                  setEditingId={setEditingId}
                  openLightbox={openLightbox}
                  onVote={onVote}
                  onReact={onReact}
                  onSetReply={onSetReply}
                  textareaRef={textareaRef}
                  setPicker={setPicker}
                  setDeleteConfirm={setDeleteConfirm}
                  setContextMenu={setContextMenu}
                  setPinnedOpen={setPinnedOpen}
                />
              ))}
            </React.Fragment>
          );
        })}
      </div>

      <div className="composer-wrap">
        {showJump && (
          // Floats just above the composer at the right edge. Positioning
          // is call-site concern; the .btn modifiers handle the visual.
          <button
            className="btn btn--primary btn--pill btn--mono"
            onClick={scrollToBottom}
            title="Jump to latest"
            style={{ position: 'absolute', bottom: '100%', right: '1rem', marginBottom: '0.375rem' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            scroll to latest
          </button>
        )}
        {replyTo && (
          <ReplyChip
            replyTo={replyTo}
            messages={messages}
            membersById={members.byId}
            onCancel={() => onSetReply?.(null)}
          />
        )}
        {(pendingAttachments ?? []).map((a) => (
          <AttachmentChip key={a.id} attachment={a} onRemove={onRemoveAttachment} />
        ))}
        {uploads.length > 0 && <UploadTray uploads={uploads} />}
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
                    <button type="button" key={m.id}
                         className={'mention-row' + (i === mentionIdx ? ' selected' : '')}
                         onMouseEnter={() => setMentionIdx(i)}
                         onMouseDown={(e) => { e.preventDefault(); applyMention(m.name); }}>
                      <div className={memberAvatarClass(m, 'mention-av')} style={memberAvatarStyle(m)}>{!m.avatarUrl && m.initials}</div>
                      <div className="mention-name">{m.name}</div>
                      {m.custom && <div className="mention-status">{m.custom}</div>}
                      <div className="mention-presence"><span className={'presence ' + m.status}></span></div>
                    </button>
                  ))}
                </div>
              )}
              {slash && slashMatches.length > 0 && (
                <div className="mention-pop slash-pop" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <div className="mention-head">slash commands · ↑↓ navigate · ⇥/↵ pick · esc cancel</div>
                  {slashMatches.map((s, i) => (
                    <button type="button" key={s.cmd}
                         ref={(el) => { if (el && i === slashIdx) el.scrollIntoView({ block: 'nearest' }); }}
                         className={'slash-row' + (i === slashIdx ? ' selected' : '')}
                         onMouseEnter={() => setSlashIdx(i)}
                         onMouseDown={(e) => { e.preventDefault(); applySlash(s); }}>
                      <div className="slash-cmd">{s.cmd}</div>
                      {s.args && <div className="slash-args">{s.args}</div>}
                      <div className="slash-desc">{s.desc}</div>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                placeholder={(() => {
                  if (slowModeLock) return `Slow mode — wait ${slowModeLock.secondsLeft}s before posting again`;
                  return channel.type === 'dm' ? `Message ${channel.name}` : `Message #${channel.name}`;
                })()}
                disabled={!!slowModeLock}
                value={draft}
                onChange={(e) => handleDraftChange(e.target.value, e.target.selectionStart, {
                  setDraft, setMention, setMentionIdx, setSlash, setSlashIdx,
                })}
                onKeyDown={e => {
                  if (handleMentionPickerKey(e, { mention, mentionMatches, mentionIdx, setMentionIdx, setMention, applyMention })) return;
                  if (handleSlashPickerKey(e, { slash, slashMatches, slashIdx, setSlashIdx, setSlash, applySlash })) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    // Either text or a staged attachment is enough to send.
                    if (draft.trim() || (pendingAttachments?.length ?? 0) > 0) onSend();
                  }
                  // Empty-draft ArrowUp loads the most recent message you
                  // sent in this channel for editing — matches the Slack /
                  // Discord pattern.
                  if (e.key === 'ArrowUp' && !mention && !slash && !draft) {
                    loadLastOwnMessageForEdit(e, messages, setEditingId, setEditDraft);
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
              className="btn btn--primary btn--icon"
              disabled={
                (!draft.trim() && (pendingAttachments?.length ?? 0) === 0) ||
                !!slowModeLock
              }
              onClick={onSend}
              title={slowModeLock ? `Slow mode — ${slowModeLock.secondsLeft}s remaining` : 'Send (↵)'}
            >
              <Icon.Send size={14} />
            </button>
          </div>
          <div className="composer-typing">
            {composerStatus(slowModeLock, typing)}
          </div>
        </div>
      </div>
      <EmojiPicker
        open={picker.open}
        anchorRect={picker.anchor}
        onClose={() => setPicker(p => ({ ...p, open: false }))}
        onPick={(emoji) => {
          dispatchEmojiPick(emoji, picker.target, draft, setDraft, onReact);
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
              const name = target.startsWith('dm-') ? members.byId[target.slice(3)]?.name : ('#' + target);
              globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: target.startsWith('dm-') ? null : target, author: 'system', text: 'Forwarded message to ' + name + '.', duration: 3000 } }));
              setForwardId(null);
            }}
          />
        );
      })()}
      {contextMenu && (
        <div className="ctx-overlay">
          <button
            type="button"
            className="ctx-overlay-dismiss"
            aria-label="Close context menu"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div className="ctx-menu"
               style={{ left: Math.min(contextMenu.x, globalThis.innerWidth - 220), top: Math.min(contextMenu.y, globalThis.innerHeight - 320) }}>
            <button onClick={(e) => {
              const anchor = e.currentTarget.getBoundingClientRect();
              setPicker({ open: true, anchor, target: 'react:' + contextMenu.msgId });
              setContextMenu(null);
            }}>
              <Icon.Emoji size={13} /> Add reaction
            </button>
            <button onClick={() => {
              globalThis.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: channel.id, messageId: contextMenu.msgId } }));
              setContextMenu(null);
            }}>
              <Icon.Thread size={13} /> Reply in thread
            </button>
            <button><Icon.Reply size={12} /> Quote reply</button>
            <button onClick={() => { toggleSavedBookmark(contextMenu.msgId, savedMsgs, setSavedMsgs); setContextMenu(null); }}>
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
                <button onClick={() => { togglePinForMessage(channel.id, contextMenu.msgId); setContextMenu(null); }}>
                  <Icon.Pin size={13} />
                  {usePinStore.getState().isPinned(channel.id, contextMenu.msgId) ? 'Unpin from channel' : 'Pin to channel'}
                </button>
              </>
            )}
            <button onClick={() => { markUnreadFromMessage(contextMenu.msgId, channel.id, messages, data, setUnreadAt); setContextMenu(null); }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Mark unread from here
            </button>
            <button onClick={() => { copyMessageLink(data, channel, contextMenu.msgId); setContextMenu(null); }}>
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
        <DeleteMessageConfirm
          previewText={deleteTarget.text}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => {
            if (onDelete) onDelete(deleteConfirm);
            setDeleteConfirm(null);
          }}
        />
      )}
      {lightbox && (() => {
        const total = lightbox.sources.length;
        const current = lightbox.sources[lightbox.index];
        const go = (delta: number) =>
          setLightbox((cur) => cur ? { ...cur, index: (cur.index + delta + cur.sources.length) % cur.sources.length } : cur);
        // Floating overlay chrome — translucent so the underlying
        // image stays visible behind the buttons, sized to match
        // the rest of the GUI's small-radius square buttons.
        const lbBtn = {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '2.25rem', height: '2.25rem',
          borderRadius: 'var(--r-sm)',
          background: 'rgba(0,0,0,0.55)',
          color: 'var(--accent)',
          border: '1px solid rgba(255,255,255,0.18)',
          cursor: 'pointer',
          padding: 0,
        } as const;
        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 500,
              background: 'rgba(0,0,0,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 32, cursor: 'zoom-out',
              backdropFilter: 'blur(2px)',
            }}
          >
            <button
              type="button"
              aria-label="Close lightbox"
              onClick={() => setLightbox(null)}
              style={{ position: 'absolute', inset: 0, background: 'transparent', border: 'none', cursor: 'zoom-out', padding: 0 }}
            />
            <img
              src={current}
              alt=""
              style={{ maxWidth: '95vw', maxHeight: '95vh', objectFit: 'contain', borderRadius: 4, position: 'relative' }}
            />
            {total > 1 && (
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); go(-1); }}
                  title="Previous (←)"
                  style={{ ...lbBtn, position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14.7 4.3a1 1 0 010 1.4L8.4 12l6.3 6.3a1 1 0 11-1.4 1.4l-7-7a1 1 0 010-1.4l7-7a1 1 0 011.4 0z" fill="currentColor" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); go(1); }}
                  title="Next (→)"
                  style={{ ...lbBtn, position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9.3 4.3a1 1 0 011.4 0l7 7a1 1 0 010 1.4l-7 7a1 1 0 11-1.4-1.4L15.6 12 9.3 5.7a1 1 0 010-1.4z" fill="currentColor" />
                  </svg>
                </button>
                <div
                  style={{
                    position: 'absolute', bottom: '1rem', left: '50%',
                    transform: 'translateX(-50%)',
                    padding: '0.25rem 0.75rem',
                    borderRadius: 'var(--r-sm)',
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    color: 'var(--fg)',
                    fontSize: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {lightbox.index + 1} / {total}
                </div>
              </>
            )}
            <a
              href={current}
              download
              onClick={(e) => e.stopPropagation()}
              title="Download image"
              style={{ ...lbBtn, position: 'absolute', top: '1rem', right: '1rem', textDecoration: 'none' }}
            >
              <Icon.Download size={16} />
            </a>
          </div>
        );
      })()}
    </main>
  );
}

function buildVoiceCardClassName(args: {
  speaking: boolean;
  renderKind: VoiceCardKind;
  isMini: boolean;
  focused: { id: string } | null;
  pid: string;
  focusable: boolean;
}): string {
  const { speaking, renderKind, isMini, focused, pid, focusable } = args;
  let cls = 'voice-card-wrap voice-card';
  if (speaking) cls += ' speaking';
  cls += voiceCardKindClass(renderKind);
  if (isMini) cls += ' mini';
  if (isMini && pid === focused?.id) cls += ' is-focused';
  if (focusable && !isMini) cls += ' focusable';
  return cls;
}

function voiceCardKindClass(kind: VoiceCardKind): string {
  if (kind === 'screen') return ' has-screen';
  if (kind === 'cam') return ' has-cam';
  return '';
}

function resolveVoiceCardState(args: {
  participant: { id: string };
  isConnected: boolean;
  mute: boolean; deaf: boolean; cam: boolean; screen: boolean;
  channelOccupants?: Array<{ user_id: string; muted?: boolean; deafened?: boolean }>;
  voicePeers?: Record<string, { webcam_sharing?: boolean; screen_sharing?: boolean }>;
  localScreenStream?: MediaStream | null;
  localWebcamStream?: MediaStream | null;
  remoteScreenStreams?: Record<string, MediaStream | null>;
  remoteWebcamStreams?: Record<string, MediaStream | null>;
}) {
  const { participant: p, mute, deaf, cam, screen, channelOccupants, voicePeers } = args;
  const isSelf = p.id === currentUserId();
  const occupant = isSelf ? null : channelOccupants?.find((o) => o.user_id === p.id);
  const peerVoice = isSelf ? null : voicePeers?.[p.id];
  const mineMuted = isSelf ? mute : !!occupant?.muted;
  const mineDeaf = isSelf ? deaf : !!occupant?.deafened;
  const showScreen = isSelf
    ? screen && !!args.localScreenStream
    : !!peerVoice?.screen_sharing && !!args.remoteScreenStreams?.[p.id];
  const showCam = isSelf
    ? cam && !!args.localWebcamStream
    : !!peerVoice?.webcam_sharing && !!args.remoteWebcamStreams?.[p.id];
  return { isSelf, mineMuted, mineDeaf, showScreen, showCam };
}

function markAllTeamChannelsRead(data: any, teamName: string): void {
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
  globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'system', text: 'All kanals in ' + teamName + ' marked as read.', duration: 2500 } }));
}

async function leaveTeamFromRail(s: { name: string }): Promise<void> {
  const confirmed = await dillaConfirm({
    title: 'Leave ' + s.name + '?',
    body: 'You\'ll lose access to channels and DMs in this team until you re-join with an invite.',
    confirmLabel: 'Leave team',
    danger: true,
  });
  if (!confirmed) return;
  const teamId = useTeamStore.getState().activeTeamId;
  const myId = useAuthStore.getState().teams.get(teamId || '')?.user?.id;
  if (!teamId || !myId || isMockSession()) {
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Demo only — leave would propagate across the mesh on a live server.', duration: 3000 } }));
    return;
  }
  try {
    await api.leaveTeam(teamId);
    useAuthStore.getState().removeTeam?.(teamId);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Left ' + s.name + '.', duration: 3000 } }));
    globalThis.location.assign('/');
  } catch (err) {
    console.warn('[ChatApp] leave team failed', err);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Leave failed: ' + (err as Error).message, duration: 4000 } }));
  }
}

function membersWidth(showFourth: boolean, activeThread: unknown, defaultWidth?: number): number {
  if (!showFourth) return 0;
  if (activeThread) return 380;
  return defaultWidth || 232;
}

function resolveFocusedKind(
  focused: { id: string; kind: VoiceFocusKind },
  state: { cam: boolean; screen: boolean; voicePeers?: Record<string, { webcam_sharing?: boolean; screen_sharing?: boolean }> },
): VoiceFocusKind | null {
  const isSelf = focused.id === currentUserId();
  const peerVoice = isSelf ? null : state.voicePeers?.[focused.id];
  const camOn = isSelf ? state.cam : !!peerVoice?.webcam_sharing;
  const screenOn = isSelf ? state.screen : !!peerVoice?.screen_sharing;
  if (!camOn && !screenOn) return null;
  if (focused.kind === 'cam' && !camOn && screenOn) return 'screen';
  if (focused.kind === 'screen' && !screenOn && camOn) return 'cam';
  return focused.kind;
}

function VoiceFullscreenSelector({
  tabFs,
  browserFs,
  setTabFs,
  toggleBrowserFullscreen,
}: Readonly<{
  tabFs: boolean;
  browserFs: boolean;
  setTabFs: (v: boolean) => void;
  toggleBrowserFullscreen: () => void;
}>): JSX.Element {
  const onNormal = () => {
    if (tabFs) setTabFs(false);
    if (browserFs) toggleBrowserFullscreen();
  };
  const onTab = () => {
    if (browserFs) toggleBrowserFullscreen();
    setTabFs(true);
  };
  const onScreen = () => {
    if (tabFs) setTabFs(false);
    if (!browserFs) toggleBrowserFullscreen();
  };
  return (
    <fieldset className="voice-fs-group" aria-label="Fullscreen mode">
      <button
        className={'voice-fs-opt' + (!tabFs && !browserFs ? ' is-active' : '')}
        onClick={onNormal}
        title="Normal — focus mode within the chat pane"
      >
        normal
      </button>
      <button
        className={'voice-fs-opt' + (tabFs ? ' is-active' : '')}
        onClick={onTab}
        title="Tab — fill the whole client viewport"
      >
        tab
      </button>
      <button
        className={'voice-fs-opt' + (browserFs ? ' is-active' : '')}
        onClick={onScreen}
        title="Screen — fill the entire monitor (browser fullscreen)"
      >
        screen
      </button>
    </fieldset>
  );
}

function VoiceCard({
  p,
  isMini,
  focusKind,
  cardState,
  speaking,
  node,
  latency,
  effectiveFocused,
  focused,
  setFocused,
  canExitFocus,
  canMuteVoice,
  vcTeamId,
  channelId,
  lastFocusKindRef,
  vol,
  setVolumes,
}: Readonly<{
  p: any;
  isMini: boolean;
  focusKind?: VoiceFocusKind;
  cardState: { mineMuted: boolean; mineDeaf: boolean; showScreen: boolean; showCam: boolean };
  speaking: boolean;
  node: string;
  latency: any;
  effectiveFocused: { id: string; kind: VoiceFocusKind } | null;
  focused: any;
  setFocused: (next: any) => void;
  canExitFocus: boolean;
  canMuteVoice: boolean;
  vcTeamId: any;
  channelId: string;
  lastFocusKindRef: { current: Record<string, any> };
  vol: (id: string) => number;
  setVolumes: any;
}>): JSX.Element {
  const { mineMuted, mineDeaf, showScreen, showCam } = cardState;
  const focusable = showScreen || showCam;
  const renderKind: VoiceCardKind = focusKind ?? (showCam ? 'cam' : 'avatar');
  return (
    <div
      className={buildVoiceCardClassName({ speaking, renderKind, isMini, focused: effectiveFocused, pid: p.id, focusable })}
      data-node={node}
      data-latency={latency}>
      <button
        type="button"
        className="voice-card-hit"
        aria-label={`Focus ${p.name}`}
        onContextMenu={(e) => openVoiceCardMenu(e, {
          p, showScreen, showCam, focused, setFocused,
          canMuteVoice,
          mineMuted, vcTeamId, channelId,
        })}
        onClick={() => handleVoiceCardClick({
          pid: p.id,
          effectiveFocused, canExitFocus, setFocused,
          remembered: lastFocusKindRef.current[p.id],
          showScreen, showCam,
        })}
      />
      <VoiceCardMedia
        p={p} focusKind={focusKind} isMini={isMini}
        renderKind={renderKind} showCam={showCam} showScreen={showScreen}
        setFocused={setFocused}
      />
      <div className="v-name">{p.name}</div>
      {!isMini && (
        <VoiceCardBadges
          mineMuted={mineMuted} mineDeaf={mineDeaf}
          showCam={showCam} showScreen={showScreen}
        />
      )}
      {!isMini && p.id !== currentUserId() && (
        <span className="v-volume">
          <Icon.Headphones size={10} />
          <input type="range" min={0} max={100} value={vol(p.id)}
                 onClick={(e) => e.stopPropagation()}
                 onChange={(e) => updateVolumeFor(setVolumes, p.id, e.target.value)} />
          <span className="v-volume-val">{vol(p.id)}</span>
        </span>
      )}
    </div>
  );
}

function VoiceCardMedia({
  p,
  focusKind,
  isMini,
  renderKind,
  showCam,
  showScreen,
  setFocused,
}: Readonly<{
  p: any;
  focusKind?: VoiceFocusKind;
  isMini: boolean;
  renderKind: VoiceCardKind;
  showCam: boolean;
  showScreen: boolean;
  setFocused: (next: { id: string; kind: VoiceFocusKind } | null) => void;
}>): JSX.Element {
  return (
    <div className="voice-media">
      {focusKind === 'screen' && <ScreenTile member={p} pip={null} showStats />}
      {focusKind && focusKind !== 'screen' && <CamTile member={p} showStats />}
      {!focusKind && (
        <AvatarTile p={p} renderKind={renderKind} showCam={showCam} isMini={isMini} />
      )}
      {focusKind && !isMini && showCam && showScreen && (
        <FloatingPip
          className="voice-pip-swap"
          minW={128}
          minH={72}
          title={focusKind === 'screen' ? 'Switch to webcam' : 'Switch to screen'}
          onClick={() => setFocused({ id: p.id, kind: focusKind === 'screen' ? 'cam' : 'screen' })}
        >
          {focusKind === 'screen'
            ? <CamTile member={p} mini />
            : <ScreenTile member={p} pip={null} />}
        </FloatingPip>
      )}
    </div>
  );
}

function VoiceCardBadges({
  mineMuted,
  mineDeaf,
  showCam,
  showScreen,
}: Readonly<{ mineMuted: boolean; mineDeaf: boolean; showCam: boolean; showScreen: boolean }>): JSX.Element {
  return (
    <div className="v-badges v-badges-inline">
      {mineMuted
        ? <span className="v-badge danger" title="muted"><Icon.Mic size={11} off /></span>
        : <span className="v-badge ok" title="mic on"><Icon.Mic size={11} /></span>}
      {mineDeaf
        ? <span className="v-badge danger" title="deafened"><Icon.Headphones size={11} off /></span>
        : <span className="v-badge ok" title="headphones on"><Icon.Headphones size={11} /></span>}
      {showCam && <span className="v-badge ok" title="camera on"><Icon.Video size={11} /></span>}
      {showScreen && <span className="v-badge ok" title="sharing screen"><Icon.Screen size={11} /></span>}
    </div>
  );
}

function AvatarTile({
  p,
  renderKind,
  showCam,
  isMini,
}: Readonly<{
  p: any;
  renderKind: VoiceCardKind;
  showCam: boolean;
  isMini: boolean;
}>): JSX.Element {
  let inner: JSX.Element;
  if (renderKind === 'screen') inner = <ScreenTile member={p} pip={showCam ? p : null} />;
  else if (renderKind === 'cam') inner = <CamTile member={p} />;
  else inner = <Avatar member={p} size={isMini ? 32 : 96} />;
  return (
    <div className="avatar-tile">
      {inner}
      {/* Dot overlay only when the content is a cam / screen tile — the
          Avatar provides its own dot already. */}
      {renderKind !== 'avatar' && p.status && (
        <span className={`voice-media-presence presence ${p.status}`} />
      )}
    </div>
  );
}

function handleMentionPickerKey(
  e: React.KeyboardEvent,
  ctx: {
    mention: { query: string } | null;
    mentionMatches: any[];
    mentionIdx: number;
    setMentionIdx: (updater: (i: number) => number) => void;
    setMention: (m: any) => void;
    applyMention: (name: string) => void;
  },
): boolean {
  const { mention, mentionMatches, mentionIdx, setMentionIdx, setMention, applyMention } = ctx;
  if (!mention || mentionMatches.length === 0) return false;
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    applyMention(mentionMatches[mentionIdx].name);
    return true;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => Math.min(mentionMatches.length - 1, i + 1)); return true; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIdx((i) => Math.max(0, i - 1)); return true; }
  if (e.key === 'Escape')    { e.preventDefault(); setMention(null); return true; }
  return false;
}

function handleSlashPickerKey(
  e: React.KeyboardEvent,
  ctx: {
    slash: { query: string } | null;
    slashMatches: any[];
    slashIdx: number;
    setSlashIdx: (updater: (i: number) => number) => void;
    setSlash: (s: any) => void;
    applySlash: (cmd: any) => void;
  },
): boolean {
  const { slash, slashMatches, slashIdx, setSlashIdx, setSlash, applySlash } = ctx;
  if (!slash || slashMatches.length === 0) return false;
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    applySlash(slashMatches[slashIdx]);
    return true;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => Math.min(slashMatches.length - 1, i + 1)); return true; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx((i) => Math.max(0, i - 1)); return true; }
  if (e.key === 'Escape')    { e.preventDefault(); setSlash(null); return true; }
  return false;
}

function loadLastOwnMessageForEdit(
  e: React.KeyboardEvent,
  messages: any[],
  setEditingId: (id: string) => void,
  setEditDraft: (text: string) => void,
): void {
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

function clearStagedAttachments(
  setPendingAttachments: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void,
  channelId: string,
  staged: Array<{ previewUrl?: string }>,
): void {
  setPendingAttachments((prev) => {
    for (const a of staged) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    const next = { ...prev };
    delete next[channelId];
    return next;
  });
}

function sendDmFromComposer(ctx: {
  channel: { id: string };
  drafts: Record<string, string>;
  pendingAttachments: Record<string, Array<{ id: string; name: string; previewUrl?: string }>>;
  replyTo: Record<string, string | null>;
  activeTeamId: string | null | undefined;
  processSlash: (text: string) => any;
  setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setReplyTo: (updater: (prev: Record<string, string | null>) => Record<string, string | null>) => void;
  setPendingAttachments: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
}): void {
  const { channel, drafts, pendingAttachments, replyTo, activeTeamId, processSlash,
    setDmMessages, setDrafts, setReplyTo, setPendingAttachments } = ctx;
  const draft = drafts[channel.id];
  const staged = pendingAttachments[channel.id] || [];
  if (!draft?.trim() && staged.length === 0) return;
  const userText = (draft ?? '').trim();
  const processed = userText ? processSlash(userText) : { kind: 'text', text: '' };
  if (processed === null) {
    setDrafts((prev) => ({ ...prev, [channel.id]: '' }));
    return;
  }
  // DM API doesn't take attachment_ids as a separate field; encode each staged
  // file as a `[file:<id>] name` token at the front of the body.
  const tokens = staged.map((a) => `[file:${a.id}] ${a.name}`).join(' ');
  let wireText: string;
  if (!tokens) wireText = userText;
  else if (userText) wireText = `${tokens} ${userText}`;
  else wireText = tokens;
  const m = { id: 'new-' + Date.now(), author: currentUserId(), at: new Date(), ...processed, replyTo: replyTo[channel.id] || null };
  setDmMessages((prev) => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), m] }));
  setDrafts((prev) => ({ ...prev, [channel.id]: '' }));
  setReplyTo((prev) => ({ ...prev, [channel.id]: null }));
  clearStagedAttachments(setPendingAttachments, channel.id, staged);
  if (activeTeamId) {
    api.sendDMMessage(activeTeamId, channel.id, wireText).catch((err) =>
      console.warn('[ChatApp] DM send failed', err),
    );
  }
}

function buildOptimisticChannelMessage(
  processed: any,
  replyToId: string | null,
  staged: Array<{ name: string; size: number; type: string; previewUrl?: string }>,
) {
  const base = {
    id: 'new-' + Date.now(),
    author: currentUserId(),
    at: new Date(),
    ...processed,
    replyTo: replyToId,
  };
  if (staged.length === 0) return base;
  const first = staged[0];
  const kind = first.type.startsWith('image/') ? 'image' : 'file';
  return {
    ...base,
    kind,
    attachment: { kind, label: first.name, size: first.size, src: first.previewUrl ?? '' },
  };
}

async function sendEncryptedChannelMessage(
  text: string,
  activeChannel: string,
  activeTeamId: string,
  derivedKey: any,
  stagedIds: string[] | undefined,
  replyTargetId: string | null,
): Promise<void> {
  try {
    const encrypted = await tryEncrypt(text || ' ', activeChannel, derivedKey);
    ws.sendMessage(activeTeamId, activeChannel, encrypted, 'text', undefined, stagedIds, replyTargetId);
  } catch (err) {
    console.warn('[ChatApp] channel send failed', err);
  }
}

function sendChannelFromComposer(ctx: {
  activeChannel: string;
  drafts: Record<string, string>;
  pendingAttachments: Record<string, Array<{ id: string; name: string; size: number; type: string; previewUrl?: string }>>;
  replyTo: Record<string, string | null>;
  activeTeamId: string | null | undefined;
  derivedKey: any;
  processSlash: (text: string) => any;
  setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  setReplyTo: (updater: (prev: Record<string, string | null>) => Record<string, string | null>) => void;
  setPendingAttachments: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
}): void {
  const { activeChannel, drafts, pendingAttachments, replyTo, activeTeamId, derivedKey, processSlash,
    setMessages, setDrafts, setReplyTo, setPendingAttachments } = ctx;
  const draft = drafts[activeChannel];
  const staged = pendingAttachments[activeChannel] || [];
  if (!draft?.trim() && staged.length === 0) return;
  const text = (draft ?? '').trim();
  const processed = text ? processSlash(text) : { kind: 'text', text: '' };
  if (processed === null) {
    setDrafts((prev) => ({ ...prev, [activeChannel]: '' }));
    return;
  }
  const m = buildOptimisticChannelMessage(processed, replyTo[activeChannel] || null, staged);
  setMessages((prev) => ({ ...prev, [activeChannel]: [...(prev[activeChannel] || []), m] }));
  setDrafts((prev) => ({ ...prev, [activeChannel]: '' }));
  setReplyTo((prev) => ({ ...prev, [activeChannel]: null }));
  clearStagedAttachments(setPendingAttachments, activeChannel, staged);
  const replyTargetId = replyTo[activeChannel] || null;
  if (activeTeamId && !isMockSession()) {
    void sendEncryptedChannelMessage(
      text,
      activeChannel,
      activeTeamId,
      derivedKey,
      staged.length > 0 ? staged.map((a) => a.id) : undefined,
      replyTargetId,
    );
  }
}

function buildGiphyOptimistic(url: string, att?: { id: string }) {
  const ts = new Date();
  if (att) {
    return {
      id: 'new-' + Date.now(),
      author: currentUserId(),
      at: ts,
      kind: 'image',
      text: '',
      attachment: { kind: 'image', label: 'giphy.gif', src: url, w: 320, h: 200 },
      replyTo: null,
    };
  }
  return { id: 'new-' + Date.now(), author: currentUserId(), at: ts, kind: 'text', text: url, replyTo: null };
}

async function sendGiphyToChannel(
  body: string,
  activeChannel: string,
  activeTeamId: string,
  derivedKey: any,
  att?: { id: string },
): Promise<void> {
  try {
    const encrypted = await tryEncrypt(body, activeChannel, derivedKey);
    ws.sendMessage(activeTeamId, activeChannel, encrypted, 'text', undefined, att ? [att.id] : undefined);
  } catch (err) {
    console.warn('[giphy] channel send failed', err);
  }
}

function handleGiphyPick(
  e: Event,
  ctx: {
    channel: any;
    activeChannel: string;
    activeTeamId: string | null | undefined;
    derivedKey: any;
    setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
    setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  },
): void {
  const detail = (e as CustomEvent).detail as { url?: string; attachment?: { id: string } } | undefined;
  const url = detail?.url;
  const att = detail?.attachment;
  if (!url) return;
  const { channel, activeChannel, activeTeamId, derivedKey, setDmMessages, setMessages } = ctx;
  const optimistic = buildGiphyOptimistic(url, att);

  if (channel?.type === 'dm') {
    setDmMessages((prev) => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), optimistic] }));
    if (activeTeamId) {
      const body = att ? `[file:${att.id}] giphy.gif` : url;
      api.sendDMMessage(activeTeamId, channel.id, body).catch((err) => console.warn('[giphy] DM send failed', err));
    }
    return;
  }
  if (activeChannel) {
    setMessages((prev) => ({ ...prev, [activeChannel]: [...(prev[activeChannel] || []), optimistic] }));
    if (activeTeamId && !isMockSession()) {
      const body = att ? ' ' : url;
      void sendGiphyToChannel(body, activeChannel, activeTeamId, derivedKey, att);
    }
  }
}

function openVoiceCardMenu(
  e: React.MouseEvent,
  args: {
    p: any; showScreen: boolean; showCam: boolean;
    focused: any; setFocused: (next: any) => void;
    canMuteVoice: boolean; mineMuted: boolean;
    vcTeamId: string | null | undefined; channelId: string;
  },
): void {
  e.preventDefault();
  const items = buildVoiceCardMenu({ ...args, x: e.clientX, y: e.clientY });
  globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items } }));
}

function handleVoiceCardClick(args: {
  pid: string;
  effectiveFocused: { id: string; kind: VoiceFocusKind } | null;
  canExitFocus: boolean;
  setFocused: (next: { id: string; kind: VoiceFocusKind } | null) => void;
  remembered?: VoiceFocusKind | null;
  showScreen: boolean;
  showCam: boolean;
}): void {
  const { pid, effectiveFocused, canExitFocus, setFocused, remembered, showScreen, showCam } = args;
  if (effectiveFocused?.id === pid) {
    if (canExitFocus) setFocused(null);
    return;
  }
  let nextKind: VoiceFocusKind | null = null;
  if (remembered === 'screen' && showScreen) nextKind = 'screen';
  else if (remembered === 'cam' && showCam) nextKind = 'cam';
  else if (showScreen) nextKind = 'screen';
  else if (showCam) nextKind = 'cam';
  if (nextKind) setFocused({ id: pid, kind: nextKind });
}

function rollbackOptimistic(
  prev: Record<string, any[]>,
  channelId: string,
  me: string,
  setDrafts: (updater: (d: Record<string, any>) => Record<string, any>) => void,
): Record<string, any[]> {
  const list = prev[channelId] || [];
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
    setDrafts(d => ({ ...d, [channelId]: removedText }));
  }
  return { ...prev, [channelId]: next };
}

function addSlowLockStrike(
  prev: Record<string, { strikes: number; until: number }>,
  channelId: string,
  retryIn: number,
): Record<string, { strikes: number; until: number }> {
  const cur = prev[channelId] ?? { strikes: 0, until: 0 };
  return { ...prev, [channelId]: { strikes: cur.strikes + 1, until: Date.now() + retryIn * 1000 } };
}

function pruneExpiredSlowLocks(
  prev: Record<string, { strikes: number; until: number }>,
): Record<string, { strikes: number; until: number }> {
  const now = Date.now();
  let changed = false;
  const next: Record<string, { strikes: number; until: number }> = {};
  for (const [cid, lock] of Object.entries(prev)) {
    if (lock.until <= now) {
      changed = true;
      continue;
    }
    next[cid] = lock;
  }
  return changed ? next : prev;
}

async function unblockMember(memberId: string): Promise<void> {
  const teamId = useTeamStore.getState().activeTeamId;
  useBlockStore.getState().unblock(memberId);
  if (teamId && !isMockSession()) {
    try { await api.unblockUser(teamId, memberId); }
    catch { useBlockStore.getState().block(memberId); }
  }
}

async function kickMember(memberId: string, memberName: string, teamName: string): Promise<void> {
  const confirmed = await dillaConfirm({
    title: 'Kick ' + memberName + '?',
    body: 'They\'ll lose access to this team. They can be re-invited. Requires admin role.',
    confirmLabel: 'Kick',
    danger: true,
  });
  if (!confirmed) return;
  const teamId = useTeamStore.getState().activeTeamId;
  if (!teamId || isMockSession()) {
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Demo only — kick would propagate across the mesh on a live server.', duration: 3000 } }));
    return;
  }
  try {
    await api.kickMember(teamId, memberId);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Kicked ' + memberName + ' from the team.', duration: 3000 } }));
  } catch (err) {
    console.warn('[ChatApp] kickMember failed', err);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Kick failed — admin role required.', duration: 3500 } }));
  }
}

async function banMember(memberId: string, memberName: string, teamName: string): Promise<void> {
  const confirmed = await dillaConfirm({
    title: 'Ban ' + memberName + '?',
    body: 'Bans prevent re-join via invite — irreversible without admin action.',
    confirmLabel: 'Ban',
    danger: true,
  });
  if (!confirmed) return;
  const teamId = useTeamStore.getState().activeTeamId;
  if (!teamId || isMockSession()) {
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Demo only — ban would propagate across the mesh on a live server.', duration: 3000 } }));
    return;
  }
  try {
    await api.banMember(teamId, memberId);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Banned ' + memberName + ' from the team.', duration: 3500 } }));
  } catch (err) {
    console.warn('[ChatApp] banMember failed', err);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'admin', text: 'Ban failed — admin role required.', duration: 3500 } }));
  }
}

async function blockMember(memberId: string, memberName: string): Promise<void> {
  const confirmed = await dillaConfirm({
    title: 'Block ' + memberName + '?',
    body: 'You won\'t see their messages or DMs. They aren\'t notified.',
    confirmLabel: 'Block',
    danger: true,
  });
  if (!confirmed) return;
  const teamId = useTeamStore.getState().activeTeamId;
  useBlockStore.getState().block(memberId);
  if (teamId && !isMockSession()) {
    try { await api.blockUser(teamId, memberId); }
    catch { useBlockStore.getState().unblock(memberId); }
  }
}

function buildTextChannelMenu(
  c: { id: string; name: string; groupId?: string },
  data: any,
  mutedChannels: Set<string>,
  toggleMuteChannel: (id: string) => void,
  nodeHost: string,
  canManageChannels: boolean,
): any[] {
  const items: any[] = [
    {
      label: 'Mark as read',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>,
      onClick: () => {
        useUnreadStore.getState().markRead(c.id);
        const teamId = useTeamStore.getState().activeTeamId;
        if (teamId && !isMockSession()) {
          const msgs = data?.MESSAGES?.[c.id] ?? [];
          const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
          if (lastId) {
            try { ws.markChannelRead(teamId, c.id, lastId); } catch { /* ignore */ }
          }
        }
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Marked all messages in #' + c.name + ' as read.', duration: 2500 } }));
      },
    },
    {
      label: mutedChannels.has(c.id) ? 'Unmute kanal' : 'Mute kanal',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 6h2l3-3v10l-3-3H2zM10 5l3 3-3 3M13 5l-3 3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>,
      onClick: () => {
        toggleMuteChannel(c.id);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: (mutedChannels.has(c.id) ? 'Unmuted ' : 'Muted ') + '#' + c.name + '.', duration: 2500 } }));
      },
    },
    {
      label: 'Copy link',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>,
      onClick: () => {
        navigator.clipboard?.writeText(('dilla://' + nodeHost + '/k/') + c.id);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Link copied.', duration: 2000 } }));
      },
    },
  ];
  if (canManageChannels) {
    items.push(
      { sep: true },
      c.groupId
        ? { label: 'Access is handled by group', icon: <Icon.Lock size={12} />, disabled: true, onClick: () => {} }
        : { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: c.id })) },
      { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: c.id })) },
    );
  }
  return items;
}

function buildGroupContextMenu(groupId: string): any[] {
  return [
    { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-group-access', { detail: groupId })) },
    { label: 'Group settings', icon: <Icon.Cog size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-group-settings', { detail: groupId })) },
  ];
}

function buildActiveVoiceChannelMenu(
  c: { id: string; name: string; groupId?: string },
  inThisChannel: boolean,
  joinAllowed: boolean,
  canManageChannels: boolean,
  nodeHost: string,
  onJoinVoice: ((id: string) => void) | undefined,
  onLeaveVoice: (() => void) | undefined,
): any[] {
  const head = inThisChannel
    ? { label: 'Disconnect from voice', danger: true, icon: <Icon.Mic size={13} off />, onClick: onLeaveVoice }
    : { label: joinAllowed ? 'Join voice' : 'Locked', disabled: !joinAllowed, icon: joinAllowed ? <Icon.Speaker size={13} /> : <Icon.Lock size={13} />, onClick: () => { if (joinAllowed) onJoinVoice?.(c.id); } };
  const items: any[] = [
    head,
    {
      label: 'Copy link',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>,
      onClick: () => {
        navigator.clipboard?.writeText(('dilla://' + nodeHost + '/k/') + c.id);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal link copied.', duration: 2000 } }));
      },
    },
  ];
  if (canManageChannels) {
    items.push(
      { sep: true },
      c.groupId
        ? { label: 'Access is handled by group', icon: <Icon.Lock size={12} />, disabled: true, onClick: () => {} }
        : { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: c.id })) },
      { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: c.id })) },
    );
  }
  return items;
}

function buildVoiceChannelMenu(
  c: { id: string; name: string; groupId?: string },
  joinAllowed: boolean,
  canManageChannels: boolean,
  nodeHost: string,
  onPickChannel: (id: string) => void,
  onJoinVoice: ((id: string) => void) | undefined,
): any[] {
  const items: any[] = [
    {
      label: joinAllowed ? 'Join voice' : 'Locked',
      disabled: !joinAllowed,
      icon: joinAllowed ? <Icon.Speaker size={13} /> : <Icon.Lock size={13} />,
      onClick: () => { if (joinAllowed) { onPickChannel(c.id); onJoinVoice?.(c.id); } },
    },
    {
      label: 'Copy link',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>,
      onClick: () => {
        navigator.clipboard?.writeText(('dilla://' + nodeHost + '/k/') + c.id);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal link copied.', duration: 2000 } }));
      },
    },
  ];
  if (canManageChannels) {
    items.push(
      { sep: true },
      c.groupId
        ? { label: 'Access is handled by group', icon: <Icon.Lock size={12} />, disabled: true, onClick: () => {} }
        : { label: 'Manage access', icon: <Icon.Lock size={12} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: c.id })) },
      { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: c.id })) },
    );
  }
  return items;
}

type UploadRow = { id: string; name: string; size: number; progress: number; phase: string };

function schedulePhaseUpdates(
  phases: Array<{ ms: number; p: number; phase: string }>,
  id: string,
  setUploads: (updater: (prev: UploadRow[]) => UploadRow[]) => void,
): void {
  let acc = 0;
  for (const ph of phases) {
    acc += ph.ms;
    setTimeout(() => {
      setUploads((prev) => prev.map((u) => u.id === id ? { ...u, progress: ph.p, phase: ph.phase } : u));
    }, acc);
  }
}

function composerStatus(slowModeLock: { secondsLeft: number } | null | undefined, typing: string[]): React.ReactNode {
  if (slowModeLock) {
    return (
      <span style={{ opacity: 0.8 }}>
        <Icon.Lock size={10} /> Slow mode — {slowModeLock.secondsLeft}s before you can post again
      </span>
    );
  }
  if (typing.length > 0) {
    return (
      <>{typing.join(', ')} {typing.length === 1 ? 'is' : 'are'} typing{' '}<span className="dot">.</span><span className="dot">.</span><span className="dot">.</span></>
    );
  }
  return (
    <span style={{ opacity: 0.6 }}>
      <Icon.Shield size={10} /> messages are end-to-end encrypted with Signal Protocol
    </span>
  );
}

function buildVoiceCardMenu(args: {
  p: { id: string; name: string };
  showScreen: boolean;
  showCam: boolean;
  focused: { id: string; kind: VoiceFocusKind } | null;
  setFocused: (next: { id: string; kind: VoiceFocusKind } | null) => void;
  canMuteVoice: boolean;
  mineMuted: boolean;
  vcTeamId: string | null;
  channelId: string;
  x: number;
  y: number;
}): any[] {
  const { p, showScreen, showCam, focused, setFocused, canMuteVoice, mineMuted, vcTeamId, channelId, x, y } = args;
  const items: any[] = [
    { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: p.id, x, y } })) },
  ];
  if (showScreen) {
    const focusedScreen = focused?.id === p.id && focused.kind === 'screen';
    items.push({
      label: focusedScreen ? 'Exit screen focus' : 'Focus screen share',
      icon: <Icon.Screen size={13} />,
      onClick: () => setFocused(focusedScreen ? null : { id: p.id, kind: 'screen' }),
    });
  }
  if (showCam) {
    const focusedCam = focused?.id === p.id && focused.kind === 'cam';
    items.push({
      label: focusedCam ? 'Exit webcam focus' : 'Focus webcam',
      icon: <Icon.Video size={13} />,
      onClick: () => setFocused(focusedCam ? null : { id: p.id, kind: 'cam' }),
    });
  }
  items.push(
    { sep: true },
    { label: 'Mute for me only', icon: <Icon.Mic size={13} off />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'mixer', text: 'Muted ' + p.name + ' for this session only.', duration: 2500 } })) },
  );
  if (canMuteVoice && p.id !== currentUserId() && !mineMuted) {
    items.push({
      label: 'Server-mute',
      danger: true,
      icon: <Icon.Mic size={13} off />,
      onClick: () => {
        if (!vcTeamId) return;
        ws.voiceForceMute(vcTeamId, channelId, p.id);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Server-muted ' + p.name + '.', duration: 2500 } }));
      },
    });
  }
  if (canMuteVoice && p.id !== currentUserId()) {
    items.push({
      label: 'Disconnect from voice',
      danger: true,
      icon: null,
      onClick: () => {
        if (!vcTeamId) return;
        ws.voiceForceDisconnect(vcTeamId, channelId, p.id);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Disconnected ' + p.name + ' from voice.', duration: 2500 } }));
      },
    });
  }
  return items;
}

function buildVoiceParticipantMenu(
  m: { name: string },
  pid: string,
  channelId: string,
  muted: boolean,
  canMuteVoice: boolean,
  sidebarTeamId: string | null,
): any[] {
  const items: any[] = [
    { label: 'Adjust volume', icon: <Icon.Headphones size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'voice', author: 'mixer', text: 'Per-user volume slider for ' + m.name + ' (drag to set).', duration: 3500 } })) },
    { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: pid, x: 200, y: 200 } })) },
    { sep: true },
    { label: 'Mute for me only', icon: <Icon.Mic size={13} off />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'mixer', text: 'Muted ' + m.name + ' for this session only.', duration: 2500 } })) },
  ];
  if (canMuteVoice && pid !== currentUserId() && !muted) {
    items.push({
      label: 'Server-mute',
      danger: true,
      icon: <Icon.Mic size={13} off />,
      onClick: () => {
        if (!sidebarTeamId) return;
        ws.voiceForceMute(sidebarTeamId, channelId, pid);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Server-muted ' + m.name + '.', duration: 2500 } }));
      },
    });
  }
  if (canMuteVoice && pid !== currentUserId()) {
    items.push({
      label: 'Disconnect from voice',
      danger: true,
      icon: null,
      onClick: () => {
        if (!sidebarTeamId) return;
        ws.voiceForceDisconnect(sidebarTeamId, channelId, pid);
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Disconnected ' + m.name + ' from voice.', duration: 2500 } }));
      },
    });
  }
  return items;
}

function buildDmContextMenu(
  d: { id: string },
  data: any,
  mutedChannels: Set<string>,
  toggleMuteChannel: (id: string) => void,
): any[] {
  return [
    { label: 'Mark as read', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>, onClick: () => {
      useUnreadStore.getState().markRead(d.id);
      const teamId = useTeamStore.getState().activeTeamId;
      if (teamId && !isMockSession()) {
        const msgs = data?.DM_MESSAGES?.[d.id] ?? [];
        const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : '';
        if (lastId) {
          try { ws.markChannelRead(teamId, d.id, lastId); } catch { /* ignore */ }
        }
      }
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Marked DM as read.', duration: 2000 } }));
    } },
    { label: 'Mute notifications', icon: <Icon.Mic size={13} off />, onClick: () => {
      toggleMuteChannel(d.id);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: mutedChannels.has(d.id) ? 'Unmuted DM.' : 'DM muted.', duration: 2000 } }));
    } },
    { sep: true },
    { label: 'Close DM', danger: true, icon: null, onClick: () => {
      globalThis.dispatchEvent(new CustomEvent('dilla:close-dm', { detail: d.id }));
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Closed DM. Re-open it from a member profile.', duration: 2500 } }));
    } },
  ];
}

function buildRailContextMenu(s: { name: string }, data: any): any[] {
  return [
    { label: s.name, icon: null, onClick: () => {} },
    { sep: true },
    { label: 'Team settings', icon: <Icon.Cog size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'team' } })) },
    { label: 'Invites', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4l6 5 6-5M2 4v8h12V4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'invites' } })) },
    { label: 'Federation', icon: <Icon.Lightning size={12} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } })) },
    { label: 'Mark all read', icon: null, onClick: () => markAllTeamChannelsRead(data, s.name) },
    { sep: true },
    { label: 'Leave team', danger: true, icon: null, onClick: () => leaveTeamFromRail(s) },
  ];
}

function sumVideoRtpStats(report: RTCStatsReport): { bytes: number; ts: number } {
  let bytes = 0;
  let ts = 0;
  report.forEach((stat) => {
    if (stat.type !== 'outbound-rtp' && stat.type !== 'inbound-rtp') return;
    const s = stat as RTCRtpStreamStats & { kind?: string; bytesSent?: number; bytesReceived?: number };
    if (s.kind !== 'video') return;
    bytes += s.bytesSent ?? s.bytesReceived ?? 0;
    ts = Math.max(ts, s.timestamp ?? 0);
  });
  return { bytes, ts };
}

function flashMessage(container: HTMLElement | null, id: string): void {
  const el = container?.querySelector('[data-msg-id="' + id + '"]');
  if (!el) return;
  el.classList.add('msg-flash');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('msg-flash'), 1400);
}

function toggleRoleInSet(prev: Set<string>, roleId: string): Set<string> {
  const next = new Set(prev);
  if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
  return next;
}

function slashNotify(msg: string, kind = 'system'): void {
  globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: kind, author: 'system', text: msg, duration: 3200 } }));
}

type SlashCtx = {
  text: string;
  data: any;
  channel: any;
  activeChannel: string;
  activeTeamId: string | null | undefined;
  derivedKey: any;
  setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setGiphyPicker: (p: { query: string; results: any[] }) => void;
};

type SlashResult = { kind: 'text' | 'action'; text: string } | null;

function slashCodeBlock(text: string): SlashResult {
  const lang = text.slice(5).trim();
  return { kind: 'text', text: '```' + lang + '\n' + (lang ? '// type your code here\n' : 'type your code here\n') + '```' };
}

function slashShrug(text: string): SlashResult {
  const rest = text.slice(6).trim();
  return { kind: 'text', text: (rest ? rest + ' ' : '') + String.raw`¯\_(ツ)_/¯` };
}

function slashWhisper(ctx: SlashCtx): SlashResult {
  const m = slashLookupMember(ctx.text.slice(3), ctx.data?.MEMBERS || []);
  if (!m) { slashNotify('No member matches that name.'); return null; }
  if (m.id === currentUserId()) { slashNotify('You cannot DM yourself.'); return null; }
  globalThis.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: m.id }));
  return null;
}

function slashInvite(text: string): SlashResult {
  const target = text.slice(8).trim();
  globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'invites' } }));
  slashNotify(target ? `Open Invites to create a link for ${target}.` : 'Open Invites to create a link.');
  return null;
}

function slashHelp(): SlashResult {
  globalThis.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'keys' } }));
  return null;
}

function slashTopic(ctx: SlashCtx): SlashResult {
  const topic = ctx.text.slice(6).trim();
  if (!ctx.activeTeamId || !ctx.channel || ctx.channel.type === 'dm') {
    slashNotify('Use /topic inside a team channel.');
    return null;
  }
  api.updateChannel(ctx.activeTeamId, ctx.channel.id, { topic }).then(() =>
    slashNotify('Updated topic for #' + ctx.channel.name + '.'),
  ).catch((err: unknown) => {
    console.warn('[slash] topic failed', err);
    slashNotify('Topic update failed — manage-channels permission required.');
  });
  return null;
}

function slashLock(ctx: SlashCtx, locked: boolean): SlashResult {
  if (!ctx.activeTeamId || !ctx.channel || ctx.channel.type === 'dm') {
    slashNotify('Use /lock or /unlock inside a team channel.');
    return null;
  }
  api.updateChannel(ctx.activeTeamId, ctx.channel.id, { locked }).then(() =>
    slashNotify((locked ? 'Locked ' : 'Unlocked ') + '#' + ctx.channel.name + '.'),
  ).catch((err: unknown) => {
    console.warn('[slash] lock failed', err);
    slashNotify('Lock failed — manage-channels permission required.');
  });
  return null;
}

function slashNick(ctx: SlashCtx): SlashResult {
  const nick = ctx.text.slice(6).trim();
  if (!ctx.activeTeamId) { slashNotify('Sign in first.'); return null; }
  api.updateMember(ctx.activeTeamId, currentUserId(), { nickname: nick }).then(() =>
    slashNotify(nick ? 'Nickname set to ' + nick + '.' : 'Nickname cleared.'),
  ).catch((err: unknown) => {
    console.warn('[slash] nick failed', err);
    slashNotify('Nickname update failed.');
  });
  return null;
}

function slashPoll(ctx: SlashCtx): SlashResult {
  const args = ctx.text.slice(6).split('|').map((s) => s.trim()).filter(Boolean);
  if (args.length < 2) {
    slashNotify('Poll needs at least one option — /poll <question> | <opt1> | <opt2>');
    return null;
  }
  if (!ctx.activeTeamId) { slashNotify('Sign in first.'); return null; }
  const question = args[0];
  const opts = args.slice(1);
  void (async () => {
    try {
      const created: any = await api.createPoll(ctx.activeTeamId!, ctx.activeChannel, { question, options: opts });
      usePollStore.getState().upsert(normalizePoll(created));
    } catch (err) {
      console.warn('[slash] poll create failed', err);
      slashNotify('Poll create failed.');
    }
  })();
  return null;
}

async function runGiphySearch(ctx: SlashCtx, q: string): Promise<void> {
  try {
    const res = await api.searchGif(ctx.activeTeamId!, q, 3);
    const results = res.results?.length > 0
      ? res.results
      : [{ url: res.url, preview: res.url }];
    ctx.setGiphyPicker({ query: q, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('503') || msg.toLowerCase().includes('not configured')) {
      slashNotify('Gif search is disabled — an admin can add a Giphy API key in Team Settings → Integrations.');
      return;
    }
    if (msg.includes('404') || msg.toLowerCase().includes('no gif')) {
      slashNotify(`No gif matches "${q}".`);
      return;
    }
    console.warn('[slash] giphy failed', err);
    await slashSendRawText('https://giphy.com/search/' + encodeURIComponent(q), ctx);
  }
}

function slashGiphy(ctx: SlashCtx): SlashResult {
  const q = ctx.text.slice(7).trim();
  if (!q) { slashNotify('Usage: /giphy <search>'); return null; }
  if (!ctx.activeTeamId) { slashNotify('Sign in first.'); return null; }
  void runGiphySearch(ctx, q);
  return null;
}

function dispatchSlashCommand(ctx: SlashCtx): SlashResult {
  const text = ctx.text;
  if (text.startsWith('/me ')) return { kind: 'action', text: text.slice(4) };
  if (text === '/me') return { kind: 'text', text };
  if (text.startsWith('/shrug')) return slashShrug(text);
  if (text.startsWith('/poll ')) return slashPoll(ctx);
  if (text.startsWith('/giphy ')) return slashGiphy(ctx);
  if (text.startsWith('/code')) return slashCodeBlock(text);
  if (text === '/help' || text.startsWith('/help ')) return slashHelp();
  if (text.startsWith('/w ')) return slashWhisper(ctx);
  if (text.startsWith('/invite ')) return slashInvite(text);
  if (text.startsWith('/topic')) return slashTopic(ctx);
  if (text === '/lock' || text === '/unlock') return slashLock(ctx, text === '/lock');
  if (text.startsWith('/nick ')) return slashNick(ctx);
  if (text.startsWith('/')) {
    slashNotify('Unknown command: ' + text.split(' ')[0] + ' — try /help.');
    return null;
  }
  return { kind: 'text', text };
}

async function slashSendRawText(
  body: string,
  ctx: {
    channel: any;
    activeChannel: string;
    activeTeamId: string | null | undefined;
    derivedKey: any;
    setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
    setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  },
): Promise<void> {
  const { channel, activeChannel, activeTeamId, derivedKey, setDmMessages, setMessages } = ctx;
  const ts = new Date();
  const optimistic = { id: 'new-' + Date.now(), author: currentUserId(), at: ts, kind: 'text', text: body, replyTo: null };
  if (channel?.type === 'dm') {
    setDmMessages(prev => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), optimistic] }));
    if (activeTeamId) {
      api.sendDMMessage(activeTeamId, channel.id, body).catch((err) => console.warn('[slash] DM send failed', err));
    }
    return;
  }
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

function slashLookupMember(query: string, list: any[]): any {
  const q = query.replace(/^@/, '').toLowerCase().trim();
  if (!q) return null;
  return list.find((m) => m.name?.toLowerCase() === q || m.id === q)
    || list.find((m) => m.name?.toLowerCase().startsWith(q))
    || null;
}

function openProfileFromTarget(target: HTMLElement, memberId: string, placement: 'right' | 'below'): void {
  const r = target.getBoundingClientRect();
  const detail = placement === 'right'
    ? { memberId, x: r.right + 8, y: r.top }
    : { memberId, x: r.left, y: r.bottom + 4 };
  globalThis.dispatchEvent(new CustomEvent('dilla:open-profile', { detail }));
}

function persistPresence(nextStatus: string, nextCustom: string): void {
  const teamId = useTeamStore.getState().activeTeamId;
  if (!teamId || isMockSession()) return;
  api.updatePresence(teamId, nextStatus, nextCustom || undefined).catch((err) =>
    console.warn('[UserPanel] updatePresence failed', err),
  );
}

function applyToggleReaction(m: any, emoji: string): any {
  const rxns = m.reactions ? [...m.reactions] : [];
  const idx = rxns.findIndex((r: { e: string }) => r.e === emoji);
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
}

function findSavedMessage(savedId: string, allMessages: Record<string, any[]>): { msg: any; chanName: string } | null {
  for (const [chId, list] of Object.entries(allMessages)) {
    const f = list.find((x: any) => x.id === savedId);
    if (f) return { msg: f, chanName: chId };
  }
  return null;
}

function PinnedPop({
  channel,
  pinnedMsgs,
  membersById,
  onClose,
  setPinnedOpen,
  feedRef,
}: Readonly<{
  channel: { name: string };
  pinnedMsgs: any[];
  membersById: Record<string, any>;
  onClose: () => void;
  setPinnedOpen: (open: boolean) => void;
  feedRef: { current: HTMLElement | null };
}>): JSX.Element {
  return (
    <div className="pin-pop">
      <div className="pin-head">
        <span>Pinned in #{channel.name}</span>
        <button className="pin-x" onClick={onClose}>×</button>
      </div>
      {pinnedMsgs.length === 0 ? (
        <div className="pin-empty">no pinned messages yet · pin one via the message menu</div>
      ) : (
        <div className="pin-list">
          {pinnedMsgs.map((pm) => {
            const a = membersById[pm.author] || { name: pm.author, color: '#666', initials: '??' };
            return (
              <button
                type="button"
                key={pm.id}
                className="pin-row"
                onClick={() => jumpToPinnedMessage(setPinnedOpen, feedRef, pm.id)}
              >
                <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                <div>
                  <div className="pin-meta"><span className="pin-author">{a.name}</span> <span className="pin-time">· {timeShort(pm.at)}</span></div>
                  <div className="pin-text">{pm.text}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SavedPop({
  savedMsgs,
  data,
  onClose,
  onJump,
}: Readonly<{
  savedMsgs: Set<string>;
  data: any;
  onClose: () => void;
  onJump: (chanName: string) => void;
}>): JSX.Element {
  return (
    <div className="pin-pop">
      <div className="pin-head">
        <span>Saved messages · all kanals</span>
        <button className="pin-x" onClick={onClose}>×</button>
      </div>
      {savedMsgs.size === 0 ? (
        <div className="pin-empty">no saved messages yet · right-click a message to bookmark it</div>
      ) : (
        <div className="pin-list">
          {Array.from(savedMsgs).map((sid) => {
            const found = findSavedMessage(sid, data.MESSAGES);
            if (!found) return null;
            const { msg, chanName } = found;
            const a = data.byId[msg.author] || { name: msg.author, color: '#666', initials: '??' };
            return (
              <button
                key={sid}
                type="button"
                className="pin-row"
                onClick={() => onJump(chanName)}
              >
                <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                <div>
                  <div className="pin-meta"><span className="pin-author">{a.name}</span> <span className="pin-time">· #{chanName} · {timeShort(msg.at)}</span></div>
                  <div className="pin-text">{msg.text}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' kB';
}

function UploadTray({
  uploads,
}: Readonly<{
  uploads: Array<{ id: string; name: string; size: number; progress: number; phase: string }>;
}>): JSX.Element {
  return (
    <div className="upload-tray">
      {uploads.map((u) => (
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
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: Readonly<{
  attachment: { id: string; name: string; size: number; type?: string; previewUrl?: string };
  onRemove?: (id: string) => void;
}>): JSX.Element {
  const isImage = (attachment.type || '').startsWith('image/');
  return (
    <div className="reply-chip attach-chip">
      {isImage && attachment.previewUrl ? (
        <img src={attachment.previewUrl} alt="" className="ac-thumb" />
      ) : (
        <Icon.Attach size={12} />
      )}
      <span className="rc-label">Attaching</span>
      <span className="rc-author">{attachment.name}</span>
      <span className="rc-text">{formatAttachmentSize(attachment.size)}</span>
      <button
        className="rc-x"
        onClick={() => onRemove?.(attachment.id)}
        title="Remove attachment"
      >
        ×
      </button>
    </div>
  );
}

function ReplyChip({
  replyTo,
  messages,
  membersById,
  onCancel,
}: Readonly<{
  replyTo: string;
  messages: any[];
  membersById: Record<string, any>;
  onCancel: () => void;
}>): JSX.Element | null {
  const orig = messages.find((om) => om.id === replyTo);
  if (!orig) return null;
  const oa = membersById[orig.author] || { name: orig.author, color: '#666', initials: '??' };
  return (
    <div className="reply-chip">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <span className="rc-label">Replying to</span>
      <span className="rc-av" style={{ background: oa.color }}>{oa.initials}</span>
      <span className="rc-author">{oa.name}</span>
      <span className="rc-text">{(orig.text || '').slice(0, 90)}{(orig.text || '').length > 90 ? '…' : ''}</span>
      <button className="rc-x" onClick={onCancel} title="Cancel reply (esc)">×</button>
    </div>
  );
}

function SystemMessageRow({
  base,
  showDay,
  dayText,
}: Readonly<{
  base: { text: string; meta?: string };
  showDay: boolean;
  dayText: string;
}>): JSX.Element {
  return (
    <React.Fragment>
      {showDay && <div className="day-divider">{dayText}</div>}
      <div className="msg system">
        <div></div>
        <div>
          <div className="body">— {base.text}</div>
          {base.meta && <div className="meta">{base.meta}</div>}
        </div>
      </div>
    </React.Fragment>
  );
}

function MessageSeenGlyph({ m }: Readonly<{ m: { id: string; at: Date | string } }>): JSX.Element {
  // We don't have per-user read receipts yet, but we DO know the message
  // reached the server (echoed back with a server-assigned id — optimistic
  // locals are prefixed 'new-'). Show "Sending…" for optimistic, "Delivered"
  // once the echo lands with the server timestamp.
  const isLocal = typeof m.id === 'string' && m.id.startsWith('new-');
  const deliveryTime = m.at instanceof Date ? m.at.toLocaleString() : '';
  const tip = isLocal ? 'Sending…' : `Delivered · ${deliveryTime}`;
  return (
    <span className="msg-seen" title={tip}>
      <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
        <title>{tip}</title>
        <path d="M1 5l3 3 6-6M5 5l3 3 5-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </span>
  );
}

function ThreadsPop({
  channel,
  messages,
  members,
  onClose,
}: Readonly<{
  channel: { id: string; name: string };
  messages: any[];
  members: { byId: Record<string, any> };
  onClose: () => void;
}>): JSX.Element {
  const threads = messages.filter((m) => m.thread);
  return (
    <div className="pin-pop">
      <div className="pin-head">
        <span>Threads in #{channel.name}</span>
        <button className="pin-x" onClick={onClose}>×</button>
      </div>
      {threads.length === 0 ? (
        <div className="pin-empty">no active threads yet · click the thread icon on any message to start one</div>
      ) : (
        <div className="pin-list">
          {threads.map((tm) => (
            <ThreadRow
              key={tm.id}
              tm={tm}
              members={members}
              channelId={channel.id}
              onClose={onClose}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadRow({
  tm,
  members,
  channelId,
  onClose,
}: Readonly<{
  tm: any;
  members: { byId: Record<string, any> };
  channelId: string;
  onClose: () => void;
}>): JSX.Element {
  const a = members.byId[tm.author] || { name: tm.author, color: '#666', initials: '??' };
  const onClick = () => {
    onClose();
    globalThis.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId, messageId: tm.id } }));
  };
  return (
    <button type="button" className="pin-row" onClick={onClick}>
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
            {(tm.thread.participants || []).map((pid: string) => {
              const p = members.byId[pid];
              if (!p) return null;
              return <div key={pid} className="rr-av" style={{ background: p.color, marginLeft: -4 }}>{p.initials}</div>;
            })}
          </div>
        </div>
      </div>
    </button>
  );
}

function redirectToOnboarding(s: { kind: string; token?: string; name?: string }): void {
  // Adding a team requires server URL + identity binding — too much for a
  // single modal. Redirect into the onboarding flow with the appropriate
  // mode + token pre-filled. The user's existing identity is reused (no new
  // keypair).
  if (s.kind === 'join') {
    const tokenParam = encodeURIComponent(s.token || '');
    globalThis.location.assign(`/onboarding?mode=invite&token=${tokenParam}`);
    return;
  }
  const nameParam = encodeURIComponent(s.name || '');
  globalThis.location.assign(`/onboarding?mode=bootstrap&team=${nameParam}`);
}

function dispatchOpenThread(channelId: string, messageId: string): void {
  globalThis.dispatchEvent(new CustomEvent('dilla:open-thread', {
    detail: { channelId, messageId },
  }));
}

function MessageRow({
  m,
  idx,
  author,
  groupAuthor,
  channel,
  members,
  messages,
  feedRef,
  pinnedSet,
  editingId,
  editDraft,
  setEditDraft,
  saveEdit,
  setEditingId,
  openLightbox,
  onVote,
  onReact,
  onSetReply,
  textareaRef,
  setPicker,
  setDeleteConfirm,
  setContextMenu,
  setPinnedOpen,
}: Readonly<{
  m: any;
  idx: number;
  author: any;
  groupAuthor: string;
  channel: { id: string };
  members: any;
  messages: any[];
  feedRef: { current: HTMLElement | null };
  pinnedSet: Set<string> | undefined;
  editingId: string | null;
  editDraft: string;
  setEditDraft: (next: string) => void;
  saveEdit: () => void;
  setEditingId: (id: string | null) => void;
  openLightbox: (sources: string[], index: number) => void;
  onVote?: (id: string, oi: number) => void;
  onReact?: (id: string, e: string) => void;
  onSetReply?: (id: string | null) => void;
  textareaRef: { current: HTMLTextAreaElement | null };
  setPicker: (p: any) => void;
  setDeleteConfirm: (id: string | null) => void;
  setContextMenu: (m: any) => void;
  setPinnedOpen: (open: boolean) => void;
}>): JSX.Element {
  const isFirst = idx === 0;
  const hasMention = (m.mentions || []).includes(currentUserId());
  const isPinned = pinnedSet?.has(m.id) ?? false;
  const isMine = m.author === currentUserId();
  const cls = 'msg' + (isFirst ? '' : ' compact') + (hasMention ? ' has-mention' : '') + (m.replyTo ? ' has-reply' : '') + (isPinned ? ' is-pinned' : '');
  return (
    <article key={m.id} className={cls} data-msg-id={m.id}
         onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, msgId: m.id, isMine }); }}>
      {m.replyTo && (
        <ReplyRef replyToId={m.replyTo} messages={messages} membersById={members.byId} feedRef={feedRef} />
      )}
      {isFirst ? (
        <button type="button" style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}
                onClick={(e) => openProfileFromTarget(e.currentTarget, author.id || groupAuthor, 'right')}>
          <Avatar member={author} />
        </button>
      ) : (
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', right: 6, top: 4, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-3)', opacity: 0 }}
                className="hover-time">{timeShort(m.at)}</span>
        </div>
      )}
      <div>
        {isFirst && (
          <MessageHead m={m} author={author} groupAuthor={groupAuthor} isPinned={isPinned} setPinnedOpen={setPinnedOpen} />
        )}
        {isPinned && !isFirst && (
          <button type="button" className="msg-pin-chip msg-pin-chip-compact"
                  title="Pinned to this channel" onClick={() => setPinnedOpen(true)}>
            <Icon.Pin size={11} />
          </button>
        )}
        <div className="body">
          {editingId === m.id ? (
            <MessageEditor editDraft={editDraft} setEditDraft={setEditDraft} onSave={saveEdit} onCancel={() => setEditingId(null)} />
          ) : (
            <MessageBody m={m} members={members} authorName={author.name} openLightbox={openLightbox} onVote={onVote} />
          )}
        </div>
        <MessageReactions m={m} onReact={onReact} setPicker={setPicker} />
        {m.thread && <ThreadPreview m={m} channelId={channel.id} membersById={members.byId} />}
      </div>
      <MessageTools
        m={m} channelId={channel.id} isMine={isMine}
        onAddReaction={(e) => {
          const anchor = e.currentTarget.getBoundingClientRect();
          setPicker({ open: true, anchor, target: 'react:' + m.id });
        }}
        onReply={() => {
          if (onSetReply) onSetReply(m.id);
          if (textareaRef.current) textareaRef.current.focus();
        }}
        onEdit={() => { setEditingId(m.id); setEditDraft(m.text || ''); }}
        onDelete={() => setDeleteConfirm(m.id)}
      />
    </article>
  );
}

function MessageHead({
  m,
  author,
  groupAuthor,
  isPinned,
  setPinnedOpen,
}: Readonly<{
  m: { id: string; at: any; author: string };
  author: any;
  groupAuthor: string;
  isPinned: boolean;
  setPinnedOpen: (open: boolean) => void;
}>): JSX.Element {
  return (
    <div className="head">
      <button type="button" className="author"
              style={{ background: 'transparent', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
              onClick={(e) => openProfileFromTarget(e.currentTarget, author.id || groupAuthor, 'below')}>
        {author.name}
      </button>
      <span className="at">{timeShort(m.at)}</span>
      {m.author === currentUserId() && <MessageSeenGlyph m={m} />}
      {author.role === 'admin' && <span className="enc-badge" style={{ fontSize: 9, padding: '1px 5px' }}>admin</span>}
      {isPinned && (
        <button type="button" className="msg-pin-chip"
                title="Pinned to this channel — open the pin pop to see all pins"
                onClick={() => setPinnedOpen(true)}>
          <Icon.Pin size={11} />
        </button>
      )}
    </div>
  );
}

function DeleteMessageConfirm({
  previewText,
  onCancel,
  onConfirm,
}: Readonly<{
  previewText: string;
  onCancel: () => void;
  onConfirm: () => void;
}>): JSX.Element {
  return (
    <div className="modal-overlay modal-overlay--soft">
      <button
        type="button"
        className="modal-overlay-dismiss"
        aria-label="Cancel"
        onClick={onCancel}
      />
      <div className="confirm-dialog">
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
        <blockquote className="cd-preview">{previewText}</blockquote>
        <div className="cd-actions">
          <button className="btn" onClick={onCancel}>Cancel · esc</button>
          <button className="btn btn--danger" autoFocus onClick={onConfirm}>Delete · ↵</button>
        </div>
      </div>
    </div>
  );
}

function MessageBody({
  m,
  members,
  authorName,
  openLightbox,
  onVote,
}: Readonly<{
  m: any;
  members: any;
  authorName: string;
  openLightbox: (sources: string[], index: number) => void;
  onVote?: (id: string, oi: number) => void;
}>): JSX.Element {
  return (
    <>
      {(m.kind === 'image' || m.kind === 'file') && m.text && (
        <div style={{ marginBottom: 4 }}>{renderText(m.text, members)}</div>
      )}
      <MessageAttachments m={m} openLightbox={openLightbox} />
      {m.kind === 'text' && renderText(m.text, members)}
      {m.kind === 'action' && (
        <span className="msg-action"><em>* {authorName} {m.text}</em></span>
      )}
      {m.kind === 'poll' && <PollMessage m={m} onVote={onVote} />}
      {m.kind === 'text' && detectUnfurls(m.text).map((u: any, ui: number) => (
        <Unfurl key={`unfurl-${m.id}-${ui}-${u.url}`} url={u.url} host={u.host} />
      ))}
      {m.edited && (
        <span className="msg-edited" title={'edited ' + (m.editedAt ? timeShort(new Date(m.editedAt)) : '')}>
          (edited)
        </span>
      )}
    </>
  );
}

function MessageEditor({
  editDraft,
  setEditDraft,
  onSave,
  onCancel,
}: Readonly<{
  editDraft: string;
  setEditDraft: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}>): JSX.Element {
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(); return; }
    if (e.key === 'Escape') onCancel();
  };
  return (
    <div className="msg-edit">
      <textarea autoFocus value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={onKey}
                rows={Math.min(6, (editDraft.match(/\n/g) || []).length + 1)} />
      <div className="msg-edit-actions">
        <button onClick={onCancel}>Cancel · esc</button>
        <button className="primary" onClick={onSave} disabled={!editDraft.trim()}>Save · ↵</button>
      </div>
    </div>
  );
}

function MessageTools({
  m,
  channelId,
  isMine,
  onAddReaction,
  onReply,
  onEdit,
  onDelete,
}: Readonly<{
  m: { id: string };
  channelId: string;
  isMine: boolean;
  onAddReaction: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}>): JSX.Element {
  return (
    <div className="msg-tools">
      <button title="Add reaction" onClick={onAddReaction}>
        <Icon.Emoji size={13} />
      </button>
      <button title="Reply" onClick={onReply}>
        <Icon.Reply size={12} />
      </button>
      <button title="Open thread" onClick={() => dispatchOpenThread(channelId, m.id)}>
        <Icon.Thread size={13} />
      </button>
      {isMine && (
        <button title="Edit" onClick={onEdit}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M11.5 1.5l3 3L5 14H2v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {isMine && (
        <button title="Delete" onClick={onDelete}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ThreadPreview({
  m,
  channelId,
  membersById,
}: Readonly<{
  m: { id: string; thread: { participants: string[]; count: number; lastReplyAt: any } };
  channelId: string;
  membersById: Record<string, any>;
}>): JSX.Element {
  return (
    <button type="button" className="thread-preview" onClick={() => dispatchOpenThread(channelId, m.id)}>
      <div className="thread-stack">
        {m.thread.participants.map((pid) => {
          const p = membersById[pid];
          return <div key={pid} className={memberAvatarClass(p, 'avatar')} style={memberAvatarStyle(p)}>{!p.avatarUrl && p.initials}</div>;
        })}
      </div>
      <span style={{ fontWeight: 600 }}>{m.thread.count} replies</span>
      <span style={{ color: 'var(--fg-3)' }}>· last {timeShort(m.thread.lastReplyAt)}</span>
    </button>
  );
}

function MessageReactions({
  m,
  onReact,
  setPicker,
}: Readonly<{
  m: { id: string; reactions?: Array<{ e: string; n: number; mine?: boolean }> };
  onReact?: (id: string, emoji: string) => void;
  setPicker: (p: { open: boolean; anchor: any; target: string }) => void;
}>): JSX.Element | null {
  if (!m.reactions?.length) return null;
  return (
    <div className="rxns">
      {m.reactions.map((r, ri) => (
        <button type="button" key={`rxn-${m.id}-${ri}-${r.e}`}
              className={'rxn' + (r.mine ? ' mine' : '')}
              title={r.mine ? 'click to remove' : 'click to add yours'}
              onClick={() => onReact?.(m.id, r.e)}>
          <span>{r.e}</span><span>{r.n}</span>
        </button>
      ))}
      <button type="button" className="rxn rxn-add"
            title="Add reaction"
            onClick={(e) => {
              const anchor = e.currentTarget.getBoundingClientRect();
              setPicker({ open: true, anchor, target: 'react:' + m.id });
            }}>
        <Icon.Emoji size={11} />
      </button>
    </div>
  );
}

function PollMessage({
  m,
  onVote,
}: Readonly<{
  m: { id: string; question: string; options: Array<{ label: string; votes?: number; mine?: boolean }> };
  onVote?: (id: string, oi: number) => void;
}>): JSX.Element {
  const total = m.options.reduce((s, o) => s + (o.votes || 0), 0) || 1;
  // Seed each poll's color sequence from a hash of its id so colors stay
  // stable across reloads and matching options.
  const seed = [...String(m.id || '')].reduce((a, c) => (a * 31 + (c.codePointAt(0) ?? 0)) % 360, 0);
  return (
    <div className="msg-poll">
      <div className="poll-q">{m.question}</div>
      {m.options.map((o, oi) => {
        const hue = (seed + Math.round((360 / m.options.length) * oi)) % 360;
        return (
          <PollOption
            key={`poll-${m.id}-${oi}-${o.label}`}
            option={o}
            total={total}
            hue={hue}
            onClick={() => onVote?.(m.id, oi)}
          />
        );
      })}
      <div className="poll-foot">click to vote · {m.options.reduce((s, o) => s + (o.votes || 0), 0)} votes</div>
    </div>
  );
}

function PollOption({
  option,
  total,
  hue,
  onClick,
}: Readonly<{
  option: { label: string; votes?: number; mine?: boolean };
  total: number;
  hue: number;
  onClick: () => void;
}>): JSX.Element {
  const dot = `hsl(${hue} 65% 55%)`;
  const bar = `hsl(${hue} 60% 50% / 0.5)`;
  return (
    <button
      type="button"
      className={'poll-opt' + (option.mine ? ' mine' : '')}
      onClick={onClick}>
      <div className="poll-bar" style={{ width: ((option.votes || 0) / total * 100) + '%', background: bar }} />
      <span className="poll-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: '0 0 auto' }} />
        {option.label}
      </span>
      <span className="poll-count">{option.votes || 0}</span>
    </button>
  );
}

function MessageAttachments({
  m,
  openLightbox,
}: Readonly<{
  m: any;
  openLightbox: (sources: string[], index: number) => void;
}>): JSX.Element | null {
  const list = resolveAttachmentList(m);
  if (list.length === 0) return null;
  // Lightbox-eligible images for THIS message only — Left/Right inside the
  // modal cycles within the same bubble, not across the feed.
  const galleryImgs = list
    .filter((a) => a.kind === 'image' && a.src)
    .map((a) => a.src as string);
  return (
    <div className={'msg-attachments' + (list.length === 1 ? ' is-single' : '')}>
      {list.map((att, ai) => (
        att.kind === 'image' ? (
          <ImageAttachment key={`img-${att.id ?? ai}`} att={att} galleryImgs={galleryImgs} openLightbox={openLightbox} />
        ) : (
          <a
            key={`file-${att.id ?? ai}`}
            className="attach-file"
            href={att.src}
            download={att.label || 'file'}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="attach-file-icon"><Icon.File size={16} /></span>
            <span className="attach-file-meta">
              <span className="attach-file-name">{att.label || 'file'}</span>
              {att.size != null && (
                <span className="attach-file-size">{Math.max(1, Math.round(att.size / 1024))} KB</span>
              )}
            </span>
            <span className="attach-file-action" title="Download">
              <Icon.Download size={14} />
            </span>
          </a>
        )
      ))}
    </div>
  );
}

function ImageAttachment({
  att,
  galleryImgs,
  openLightbox,
}: Readonly<{
  att: any;
  galleryImgs: string[];
  openLightbox: (sources: string[], index: number) => void;
}>): JSX.Element {
  const onClick = () => {
    const idx = galleryImgs.indexOf(att.src as string);
    openLightbox(galleryImgs, Math.max(0, idx));
  };
  return (
    <div className="attach">
      {att.src ? (
        <button
          type="button"
          className="attach-img-btn"
          onClick={onClick}
          style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in' }}
        >
          <img
            className="attach-img"
            src={att.src}
            alt={att.label || ''}
            style={{ display: 'block', objectFit: 'cover', borderRadius: 4 }}
          />
        </button>
      ) : (
        <div className="attach-img" style={{ background: att.tint }}></div>
      )}
      <div className="attach-name">
        {att.label}
        {att.size != null && ` · ${Math.max(1, Math.round(att.size / 1024))} KB`}
      </div>
    </div>
  );
}

function ReplyRef({
  replyToId,
  messages,
  membersById,
  feedRef,
}: Readonly<{
  replyToId: string;
  messages: any[];
  membersById: Record<string, any>;
  feedRef: { current: HTMLElement | null };
}>): JSX.Element {
  const orig = messages.find((om) => om.id === replyToId);
  if (!orig) {
    return (
      <div className="reply-ref reply-ref-missing" title="Original message not loaded">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <span className="rr-text rr-text-missing">original message not loaded</span>
      </div>
    );
  }
  const oa = membersById[orig.author] || { name: orig.author, color: '#666', initials: '??' };
  return (
    <button type="button" className="reply-ref"
         onClick={() => flashMessage(feedRef.current, orig.id)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <span className="rr-av" style={{ background: oa.color }}>{oa.initials}</span>
      <span className="rr-author">{oa.name}</span>
      <span className="rr-text">{(orig.text || '').slice(0, 80)}{(orig.text || '').length > 80 ? '…' : ''}</span>
    </button>
  );
}

function updateVolumeFor(
  setVolumes: (updater: (v: Record<string, number>) => Record<string, number>) => void,
  id: string,
  rawValue: string,
): void {
  setVolumes((v) => ({ ...v, [id]: Number.parseInt(rawValue, 10) }));
}

function focusTextareaAtEnd(
  textareaRef: { current: HTMLTextAreaElement | null },
  pos: number,
): void {
  setTimeout(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
    }
  }, 0);
}

function applyMentionToDraft(
  name: string,
  draft: string,
  textareaRef: { current: HTMLTextAreaElement | null },
  setDraft: (next: string) => void,
  setMention: (m: any) => void,
  setMentionIdx: (i: number) => void,
): void {
  const ta = textareaRef.current;
  if (!ta) return;
  const pos = ta.selectionStart;
  const before = draft.slice(0, pos);
  const after = draft.slice(pos);
  const newBefore = before.replace(/@\w*$/, '@' + name + ' ');
  setDraft(newBefore + after);
  setMention(null);
  setMentionIdx(0);
  focusTextareaAtEnd(textareaRef, newBefore.length);
}

function applySlashCommand(
  cmd: { cmd: string; args?: string },
  textareaRef: { current: HTMLTextAreaElement | null },
  setDraft: (next: string) => void,
  setSlash: (s: any) => void,
  setSlashIdx: (i: number) => void,
): void {
  const next = cmd.cmd + (cmd.args ? ' ' : '');
  setDraft(next);
  setSlash(null);
  setSlashIdx(0);
  focusTextareaAtEnd(textareaRef, next.length);
}

const SLASH_COMMANDS = [
  { cmd: '/me',      args: '<action>',  desc: 'narrate an action in italics' },
  { cmd: '/code',    args: '<language>', desc: 'start a code block' },
  { cmd: '/shrug',   args: '',          desc: String.raw`appends ¯\_(ツ)_/¯` },
  { cmd: '/poll',    args: '<question> | <opt1> | <opt2>', desc: 'post a poll · react with numbers to vote' },
  { cmd: '/giphy',   args: '<search>',  desc: 'post a giphy search link' },
  { cmd: '/topic',   args: '<text>',    desc: 'set the channel topic (needs manage-channels)' },
  { cmd: '/lock',    args: '',          desc: 'lock this voice channel (needs manage-channels)' },
  { cmd: '/unlock',  args: '',          desc: 'unlock this voice channel (needs manage-channels)' },
  { cmd: '/nick',    args: '<name>',    desc: 'set your nickname for this team' },
  { cmd: '/invite',  args: '<user>',    desc: 'open Invites to create a link' },
  { cmd: '/w',       args: '<user>',    desc: 'open a private message (whisper)' },
  { cmd: '/help',    args: '',          desc: 'show keyboard shortcuts' },
];

function trackJumpButtonVisibility(
  feedRef: { current: HTMLElement | null },
  setShowJump: (visible: boolean) => void,
): (() => void) | undefined {
  const el = feedRef.current;
  if (!el) return undefined;
  const onScroll = () => {
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(dist > 120);
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  return () => el.removeEventListener('scroll', onScroll);
}

function trackFeedScrollPosition(
  feedRef: { current: HTMLElement | null },
  userPagedUpRef: { current: boolean },
): (() => void) | undefined {
  const el = feedRef.current;
  if (!el) return undefined;
  const onScroll = () => {
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    userPagedUpRef.current = dist > 30;
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => el.removeEventListener('scroll', onScroll);
}

function queueFileUploads(
  files: File[],
  setUploads: (updater: (prev: any[]) => any[]) => void,
  onAttach?: (file: File) => Promise<void> | void,
): void {
  if (files.length === 0) return;
  const phases = [
    { ms: 100, p: 25, phase: 'reading' },
    { ms: 100, p: 55, phase: 'encrypting' },
    { ms: 200, p: 85, phase: 'uploading' },
  ];
  for (const file of files) {
    const id = shortId('up');
    setUploads((prev) => [...prev, { id, name: file.name, size: file.size, progress: 0, phase: 'reading' }]);
    schedulePhaseUpdates(phases, id, setUploads);
    Promise.resolve(onAttach?.(file)).finally(() => removeUploadById(setUploads, id));
  }
}

function handleDraftChange(
  value: string,
  caret: number,
  ctx: {
    setDraft: (next: string) => void;
    setMention: (m: { query: string } | null) => void;
    setMentionIdx: (i: number) => void;
    setSlash: (s: { query: string } | null) => void;
    setSlashIdx: (i: number) => void;
  },
): void {
  const { setDraft, setMention, setMentionIdx, setSlash, setSlashIdx } = ctx;
  setDraft(value);
  const before = value.slice(0, caret);
  const mm = /(?:^|\s)@(\w*)$/.exec(before);
  if (mm) {
    setMention({ query: mm[1].toLowerCase() });
    setMentionIdx(0);
    setSlash(null);
    return;
  }
  const sm = /^\/(\w*)$/.exec(before);
  if (sm) {
    setSlash({ query: sm[1].toLowerCase() });
    setSlashIdx(0);
    setMention(null);
    return;
  }
  setMention(null);
  setSlash(null);
}

function dispatchEmojiPick(
  emoji: string,
  target: string,
  draft: string,
  setDraft: (next: string) => void,
  onReact?: (msgId: string, e: string) => void,
): void {
  if (target === 'draft') {
    setDraft(draft + emoji);
    return;
  }
  if (target.startsWith('react:')) {
    const msgId = target.slice(6);
    if (onReact) onReact(msgId, emoji);
  }
}

function copyMessageLink(data: any, channel: { id: string; name: string }, msgId: string): void {
  const host = data?.SERVERS?.[0]?.node || 'local';
  navigator.clipboard?.writeText(`dilla://${host}/channels/${channel.id}/messages/${msgId}`);
  globalThis.dispatchEvent(new CustomEvent('dilla:notify', {
    detail: { kind: 'message', channel: channel.name, author: 'system', text: 'Link copied to clipboard.', duration: 3000 },
  }));
}

function toggleSavedBookmark(
  msgId: string,
  savedMsgs: Set<string>,
  setSavedMsgs: (updater: (prev: Set<string>) => Set<string>) => void,
): void {
  const wasIn = savedMsgs.has(msgId);
  setSavedMsgs((prev) => {
    const next = new Set(prev);
    if (next.has(msgId)) next.delete(msgId);
    else next.add(msgId);
    return next;
  });
  globalThis.dispatchEvent(new CustomEvent('dilla:notify', {
    detail: {
      author: 'saved',
      text: wasIn ? 'Removed from saved messages.' : 'Saved. Find it in your bookmarks.',
      duration: 2200,
    },
  }));
}

function togglePinForMessage(channelId: string, msgId: string): void {
  const teamId = useTeamStore.getState().activeTeamId;
  const ps = usePinStore.getState();
  const already = ps.isPinned(channelId, msgId);
  // Optimistic flip so the icon updates instantly; rollback on failure.
  // The server echoes message:pin-update to converge other clients.
  if (already) ps.unpin(channelId, msgId);
  else ps.pin(channelId, msgId);
  if (!teamId) return;
  const call = already ? api.unpinMessage(teamId, channelId, msgId) : api.pinMessage(teamId, channelId, msgId);
  if (isMockSession()) {
    call.catch(() => {});
    return;
  }
  call.catch((err) => {
    if (already) ps.pin(channelId, msgId);
    else ps.unpin(channelId, msgId);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', {
      detail: { author: 'pins', text: (err as Error).message || 'Pin failed — manage-messages permission required.', duration: 3500 },
    }));
  });
}

function markUnreadFromMessage(
  msgId: string,
  channelId: string,
  messages: any[] | undefined,
  data: any,
  setUnreadAt: (id: string) => void,
): void {
  setUnreadAt(msgId);
  const all = messages || [];
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  const myId = data?.currentUserId;
  const fromHere = all.slice(idx).filter((m) => m.author !== myId).length;
  useUnreadStore.setState((s) => ({ counts: { ...s.counts, [channelId]: fromHere } }));
  const teamId = useTeamStore.getState().activeTeamId;
  if (!teamId || isMockSession()) return;
  const prevId = idx > 0 ? all[idx - 1].id : '';
  // Empty string is intentional — server treats it as "mark from very first
  // message" which is the right behaviour for selecting the first message.
  try { ws.markChannelRead(teamId, channelId, prevId); } catch { /* ignore */ }
}

function snapInstant(el: HTMLElement): void {
  // scrollTo({ behavior: 'instant' }) bypasses smooth-scroll so the snap
  // never strands the viewport mid-animation.
  el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
}

function scheduleFeedSnapRetries(
  feedRef: { current: HTMLElement | null },
  userPagedUpRef: { current: boolean },
): () => void {
  userPagedUpRef.current = false;
  const el = feedRef.current;
  if (el) snapInstant(el);
  const retries = [50, 150, 400, 900].map((ms) =>
    globalThis.setTimeout(() => {
      if (userPagedUpRef.current) return;
      if (feedRef.current) snapInstant(feedRef.current);
    }, ms),
  );
  return () => {
    retries.forEach((id) => globalThis.clearTimeout(id));
  };
}

function observeFeedForLateMedia(
  el: HTMLElement | null,
  userPagedUpRef: { current: boolean },
): (() => void) | undefined {
  if (!el) return undefined;
  let raf = 0;
  const snap = () => {
    raf = 0;
    if (!userPagedUpRef.current) snapInstant(el);
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
}

function handleLightboxKey(
  e: KeyboardEvent,
  setLightbox: (next: any) => void,
): void {
  if (e.key === 'Escape') { setLightbox(null); return; }
  if (e.key === 'ArrowLeft') {
    setLightbox((cur: any) => cur ? { ...cur, index: (cur.index - 1 + cur.sources.length) % cur.sources.length } : cur);
    return;
  }
  if (e.key === 'ArrowRight') {
    setLightbox((cur: any) => cur ? { ...cur, index: (cur.index + 1) % cur.sources.length } : cur);
  }
}

function flashMessageElement(el: Element): void {
  el.classList.add('msg-flash');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('msg-flash'), 1400);
}

function jumpToPinnedMessage(
  setPinnedOpen: (open: boolean) => void,
  feedRef: { current: HTMLElement | null },
  msgId: string,
): void {
  setPinnedOpen(false);
  setTimeout(() => {
    const el = feedRef.current?.querySelector('[data-msg-id="' + msgId + '"]');
    if (el) flashMessageElement(el);
  }, 0);
}

function removeUploadById(
  setUploads: (updater: (prev: any[]) => any[]) => void,
  id: string,
): void {
  setUploads((prev) => prev.filter((u) => u.id !== id));
}

function makeToggleThreadRxn(
  setReplies: (updater: (prev: any[]) => any[]) => void,
  replyId: string,
  emoji: string,
): () => void {
  return () => setReplies((prev) => toggleThreadReaction(prev, replyId, emoji));
}

function toggleThreadReaction(prev: any[], replyId: string, emoji: string): any[] {
  return prev.map((rr) => {
    if (rr.id !== replyId) return rr;
    const list = [...(rr.reactions || [])];
    const idx = list.findIndex((x: { e: string }) => x.e === emoji);
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
  });
}

function resolveAttachmentList(m: { attachments?: any[]; attachment?: any }): any[] {
  if (m.attachments?.length) return m.attachments;
  if (m.attachment) return [m.attachment];
  return [];
}

function renderChannelTitle(channel: any, dmPartner: any) {
  if (channel.type !== 'dm') {
    return (
      <>
        <Icon.Hash size={15} />
        <span>{channel.name}</span>
      </>
    );
  }
  if (channel.group) {
    return (
      <>
        <Icon.People size={15} />
        <span>{channel.name}</span>
      </>
    );
  }
  if (dmPartner) {
    return (
      <>
        <span className="dm-avatar" style={{ background: dmPartner.color }}>
          {dmPartner.initials}
          <span className={'presence ' + dmPartner.status}></span>
        </span>
        <span>{dmPartner.name}</span>
      </>
    );
  }
  return (
    <>
      <Icon.Chat size={15} />
      <span>{channel.name}</span>
    </>
  );
}

function renderText(text, _members) {
  if (!text) return null;
  // Delegate to react-markdown via MessageMarkdown — gives us bold,
  // italic, strikethrough, lists, blockquotes, code fences, tables,
  // links and inline images, plus the @mention chip that renderText
  // used to hand-roll. Headings are disallowed (chat-bubble context).
  const me = (globalThis as { SHELL_DATA?: { byId?: Record<string, { name?: string; username?: string }>; currentUserId?: string } }).SHELL_DATA;
  const myId = me?.currentUserId ?? null;
  const myRec = myId ? me?.byId?.[myId] : null;
  const myHandle = myRec?.username || myRec?.name || null;
  return <MessageMarkdown text={text} currentUserId={myId} currentUserHandle={myHandle} />;
}

// Mock unfurl content keyed by hostname — Dilla repo + a couple of others.
// Match the host exactly (or as a subdomain). Using includes() would
// accept evilgithub.com / github.com.evil.com etc.; CodeQL flagged it
// as incomplete-url-substring-sanitization.
export function isHost(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith('.' + suffix);
}
export function mockUnfurl(host, url) {
  if (isHost(host, 'github.com')) {
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
  if (isHost(host, 'figma.com')) return {
    title: 'channel-list refinements · v3',
    desc: 'last edited by mira · 4 frames',
    kind: 'figma',
    meta: 'figma',
  };
  return { title: url.replace(/^https?:\/\//, ''), desc: '', kind: 'web', meta: host };
}
export function Unfurl({ url, host }) {
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
export function detectUnfurls(text) {
  if (!text) return [];
  // Skip URLs inside triple-backtick code fences
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  // The host group is mandatory; the path/query suffix is optional but
  // the inner group requires at least one allowed char (no empty-match
  // alternatives — S5842).
  const re = /https?:\/\/([^\s/?#)]+)([^\s)]+)?/g;
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
export function VoiceChannel({ channel, members, voiceConnection, onJoin, onLeave, mute, setMute, deaf, setDeaf, cam, setCam, screen, setScreen, rich, membersOpen, onToggleMembers }) {
  const nodes = globalThis.MeshChrome?.MEMBER_NODES || {};
  const participants = (channel.participants || []).map(id => members.byId[id]);
  const isConnected = voiceConnection?.channelId === channel.id;
  const meIsAdmin = !!members?.byId?.[currentUserId()]?.isAdmin;
  const lockedForMe = !!channel.locked && !meIsAdmin;
  // Resolve viewer perms so the right-click context menu can include
  // moderation actions (e.g. Server-mute) only for users who actually
  // hold PERM_MUTE_VOICE — matches the server-side gate.
  const vcTeamId = useTeamStore((s) => s.activeTeamId) as string | null;
  const vcTeamMembers = useTeamStore((s) => (vcTeamId ? s.members.get(vcTeamId) ?? EMPTY_LIST : EMPTY_LIST)) as any[];
  const vcPerms = useMemo(() => resolvePermissions(vcTeamMembers, currentUserId()), [vcTeamMembers]);
  // Per-user RTT cache. Each peer publishes their own RTT via the
  // voice:latency WS event; the server fans out as voice:latency-
  // update, and WebRTCService writes the map. Cards look up by
  // member id so every tile shows the right user's number.
  const peerLatencies = useVoiceStore((s) => s.peerLatencies);
  // Focused stream: a tuple of (participant_id, VoiceFocusKind). Tracking
  // the kind separately lets you focus the webcam alone, the screen alone,
  // or swap between them — previously a participant with both shared their
  // screen with the webcam stuck as a small PIP that couldn't be promoted.
  const [focused, setFocusedState] = useState<{ id: string; kind: VoiceFocusKind } | null>(null);
  // Per-user memory of the last kind ('cam' / 'screen') the viewer
  // had focused for that participant. Used so clicking back to a card
  // restores the last view we were on for that user — e.g. flip from
  // Alice's screen to Bob's cam, click Alice again → land back on
  // her screen, not the default.
  const lastFocusKindRef = useRef<Record<string, VoiceFocusKind>>({});
  const setFocused = useCallback((next: { id: string; kind: VoiceFocusKind } | null) => {
    if (next) lastFocusKindRef.current[next.id] = next.kind;
    setFocusedState(next);
  }, []);
  const focusRef = useRef<HTMLDivElement | null>(null);
  // Tab-level fullscreen: the focused stage covers the whole client
  // viewport (everything inside the browser tab — sidebar, header,
  // member list all hidden). Separate from the browser Fullscreen API
  // (which takes over the entire monitor) — both are useful in
  // different contexts.
  const [tabFs, setTabFs] = useState(false);
  // Mirror document.fullscreenElement so the browser-fullscreen
  // button can toggle and reflect external exits (e.g. user pressed
  // Esc, which is intercepted by the browser before our handler
  // sees it).
  const [browserFs, setBrowserFs] = useState(false);
  useEffect(() => {
    const onChange = () => setBrowserFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const [volumes, setVolumes] = useState({}); // memberId -> 0..100
  function vol(id) { return volumes[id] === undefined ? 100 : volumes[id]; }
  // While someone is sharing their screen, exit-focus is disabled —
  // the share IS the call, dismissing it would just leave the viewer
  // staring at avatars. The user can still switch focus between
  // users by clicking another card; they just can't dismiss focus
  // mode entirely until the sharer stops.
  const channelSharerId = useVoiceStore((s) => s.screenSharingUserId);
  const voicePeers = useVoiceStore((s) => s.peers);
  const remoteScreenStreamsForFocus = useVoiceStore((s) => s.remoteScreenStreams);
  // Resolve the effective focus, with a few layered fallbacks:
  // 1. If the user's manually-focused peer is currently sharing a
  //    screen, force kind='screen' regardless of what the user picked
  //    — screen-share always wins over webcam for that peer. Matches
  //    Discord-style UX where the share IS the call once it's on, so
  //    a cam-first → screen-second start auto-promotes the screen
  //    even if the viewer had clicked into the cam already.
  // 2. Otherwise honour the explicit manual focus.
  // 3. Otherwise fall back to the channel's active sharer so a
  //    late-joiner lands on the share instead of the card grid.
  // Compute the "first cam sharer" fallback up front so we can use it
  // in BOTH the effective-focus derivation and the auto-focus effect.
  const firstCamSharerIdEarly = useMemo(() => {
    const ids = Object.values(voicePeers ?? {})
      .filter((p) => p.webcam_sharing && p.user_id !== currentUserId())
      .map((p) => p.user_id)
      .sort((a, b) => a.localeCompare(b));
    return ids[0] ?? null;
  }, [voicePeers]);
  const effectiveFocused = resolveEffectiveFocused({
    focused, voicePeers, remoteScreenStreamsForFocus,
    channelSharerId, firstCamSharerIdEarly,
  });
  // Resolve the focused user. Prefer the shell's member record (full
  // profile data) but fall back through voiceStore.peers so a late
  // joiner can render the sharer before channel.participants has
  // caught up via the WS roster broadcast.
  const focusedMember = resolveFocusedMember(effectiveFocused, participants, members, voicePeers);
  const canExitFocus = !channelSharerId;

  useEffect(() => {
    if (!focused) return;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      // Esc unwinds one layer at a time: tab-fullscreen first, then
      // (only when exit-focus is permitted) the focus itself.
      if (tabFs) setTabFs(false);
      else if (canExitFocus) setFocused(null);
    }
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [focused, tabFs, canExitFocus]);

  // Whenever focus clears, drop tab-fullscreen too — otherwise the
  // sidebar would stay hidden after leaving focus mode.
  useEffect(() => { if (!focused) setTabFs(false); }, [focused]);

  // Auto-flip into focus mode the moment any peer starts a video
  // stream — screen-share OR webcam. Screen wins over cam (so a
  // cam-then-screen sequence promotes the screen to the stage). When
  // every video stops, clear focus so the card grid returns. Manual
  // focus picks made by the viewer still take precedence via the
  // setFocused override.
  useEffect(() => {
    if (!isConnected) return;
    if (channelSharerId) {
      setFocused({ id: channelSharerId, kind: 'screen' });
    } else if (firstCamSharerIdEarly) {
      setFocused({ id: firstCamSharerIdEarly, kind: 'cam' });
    } else {
      setFocused(null);
    }
  }, [channelSharerId, firstCamSharerIdEarly, isConnected]);

  // Fullscreen the focused stage. Uses the browser Fullscreen API and
  // bails silently if the user denies the request or fullscreen isn't
  // available (e.g. iOS Safari which is restrictive on non-video els).
  function toggleBrowserFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err) => console.warn('[voice] exit fullscreen failed', err));
      return;
    }
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
  const remoteScreenStreams = useVoiceStore((s) => s.remoteScreenStreams);
  const localWebcamStream = useVoiceStore((s) => s.localWebcamStream);
  const remoteWebcamStreams = useVoiceStore((s) => s.remoteWebcamStreams);
  // Per-peer sharing flags so we can hide tiles when a peer toggles
  // a track off (the underlying stream is intentionally kept alive
  // in the store across toggles — see voice:webcam-update handler).

  // Keep the focused stage useful as the underlying streams change:
  //   - both gone → exit focus (nothing to show)
  //   - focused kind gone, other kind still live → flip focus to it
  //   - focused kind still live → no change
  // Same liveness gating as the showCam/showScreen rule in cardFor.
  useEffect(() => {
    if (!focused) return;
    const next = resolveFocusedKind(focused, { cam, screen, voicePeers });
    if (next === focused.kind) return;
    if (next === null) setFocused(null);
    else setFocused({ id: focused.id, kind: next });
  }, [focused, voicePeers, cam, screen]);

  return (
    <main className="main">
      <div className="main-head">
        <button className="btn btn--ghost btn--icon btn--sm" title="Open menu" onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:toggle-drawer'))}>
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
          function cardFor(p, isMini, focusKind?: VoiceFocusKind) {
            const cardState = resolveVoiceCardState({
              participant: p,
              isConnected,
              mute, deaf, cam, screen,
              channelOccupants,
              voicePeers,
              localScreenStream, localWebcamStream,
              remoteScreenStreams, remoteWebcamStreams,
            });
            return (
              <VoiceCard
                p={p}
                isMini={isMini}
                focusKind={focusKind}
                cardState={cardState}
                speaking={p.id === 'ada' && isConnected}
                node={(nodes[p.id] || '').split('.')[0] || 'local'}
                latency={peerLatencies[p.id] ?? '--'}
                effectiveFocused={effectiveFocused}
                focused={focused}
                setFocused={setFocused}
                canExitFocus={canExitFocus}
                canMuteVoice={vcPerms.has(PERM_MUTE_VOICE)}
                vcTeamId={vcTeamId}
                channelId={channel.id}
                lastFocusKindRef={lastFocusKindRef}
                vol={vol}
                setVolumes={setVolumes}
              />
            );
          }

          // Always render the participant grid in .voice-stage. When
          // someone is sharing (cam or screen) we additionally render
          // .voice-focus on top of it as an overlay — so the cards
          // never disappear when the focused stream appears or goes
          // away, they're just covered by the focus stage.
          const fm = focusedMember;
          const isSelf = effectiveFocused && fm?.id === currentUserId();
          const hasCam = isSelf ? cam : false;
          const hasScreen = isSelf ? screen : false;
          const showSwap = effectiveFocused && (
            (effectiveFocused.kind === 'cam' && hasScreen) ||
            (effectiveFocused.kind === 'screen' && hasCam)
          );
          return (
            <div className={'voice-stage-wrap' + (effectiveFocused && focusedMember ? ' has-focus' : '')}>
              {effectiveFocused && focusedMember && (
                <div className={'voice-focus' + (tabFs ? ' is-tab-fs' : '')} ref={focusRef}>
                  <div className="voice-focus-actions">
                    {showSwap && (
                      <button className="voice-unfocus" onClick={() => setFocused({ id: effectiveFocused.id, kind: effectiveFocused.kind === 'cam' ? 'screen' : 'cam' })} title={effectiveFocused.kind === 'cam' ? 'Switch to screen' : 'Switch to webcam'}>
                        {effectiveFocused.kind === 'cam' ? <Icon.Screen size={14} /> : <Icon.Video size={14} />}
                        {effectiveFocused.kind === 'cam' ? 'screen' : 'webcam'}
                      </button>
                    )}
                    {effectiveFocused.kind === 'screen' && (
                      <VoiceFullscreenSelector
                        tabFs={tabFs}
                        browserFs={browserFs}
                        setTabFs={setTabFs}
                        toggleBrowserFullscreen={toggleBrowserFullscreen}
                      />
                    )}
                  </div>
                  {cardFor(focusedMember, false, effectiveFocused.kind)}
                </div>
              )}
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
            </div>
          );
        })()}

        <div className="voice-controls-bar">
          {isConnected ? (
            <button className="btn btn--danger btn--icon" onClick={onLeave} title="Disconnect">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor"/></svg>
            </button>
          ) : (
            <button
              className="btn btn--primary"
              disabled={lockedForMe}
              title={lockedForMe ? 'Channel is locked' : 'Join voice'}
              onClick={() => { if (!lockedForMe) onJoin(); }}
            >
              {lockedForMe ? 'Locked' : 'Join'}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

// ───────────── member list ─────────────
function groupMembersByRole(membersArr: any[]): {
  offline: any[];
  groupOrder: string[];
  groupMeta: Record<string, { name: string; color: string; position: number }>;
  groups: Record<string, any[]>;
  onlineDefault: any[];
} {
  const offline: any[] = [];
  const groupOrder: string[] = [];
  const groupMeta: Record<string, { name: string; color: string; position: number }> = {};
  const groups: Record<string, any[]> = {};
  const onlineDefault: any[] = [];
  membersArr.forEach((m: any) => {
    if (m.status === 'offline') { offline.push(m); return; }
    const top = m.roles?.[0] || null;
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
  return { offline, groupOrder, groupMeta, groups, onlineDefault };
}

function markLatestRead(
  teamId: string,
  viewId: string,
  msgs: Array<{ id: string }> | undefined,
): void {
  const lastId = msgs?.at(-1)?.id ?? '';
  if (!lastId) return;
  try { ws.markChannelRead(teamId, viewId, lastId); } catch { /* ignore */ }
}

function resolveEffectiveFocused(args: {
  focused: { id: string; kind: VoiceFocusKind } | null;
  voicePeers: Record<string, any> | undefined;
  remoteScreenStreamsForFocus: Record<string, MediaStream> | undefined;
  channelSharerId: string | null | undefined;
  firstCamSharerIdEarly: string | null;
}): { id: string; kind: VoiceFocusKind } | null {
  const { focused, voicePeers, remoteScreenStreamsForFocus, channelSharerId, firstCamSharerIdEarly } = args;
  if (focused) {
    const peer = voicePeers?.[focused.id];
    const hasLiveScreen = !!(peer?.screen_sharing && remoteScreenStreamsForFocus?.[focused.id]);
    if (hasLiveScreen && focused.kind !== 'screen') {
      return { id: focused.id, kind: 'screen' };
    }
    return focused;
  }
  if (channelSharerId) return { id: channelSharerId, kind: 'screen' };
  if (firstCamSharerIdEarly) return { id: firstCamSharerIdEarly, kind: 'cam' };
  return null;
}

function resolveFocusedMember(
  effectiveFocused: { id: string } | null,
  participants: Array<{ id: string }>,
  members: { byId?: Record<string, any> } | undefined,
  voicePeers: Record<string, any> | undefined,
): any {
  if (!effectiveFocused) return null;
  const fromParticipants = participants.find((p) => p.id === effectiveFocused.id);
  if (fromParticipants) return fromParticipants;
  const fromMembers = members?.byId?.[effectiveFocused.id];
  if (fromMembers) return fromMembers;
  const peer = voicePeers?.[effectiveFocused.id];
  return peer
    ? { id: peer.user_id, name: peer.username, initials: peer.username.slice(0, 2).toUpperCase() }
    : null;
}

function toggleVoiceMute(next: any, current: boolean): void {
  const target = typeof next === 'function' ? next(current) : next;
  if (target === current) return;
  // Must route through webrtcService (not voice.toggleMute, which is just a
  // store action that flips the boolean). The service actually stops/restarts
  // the mic track + updates SFU state — the OS mic indicator only turns off
  // via this path.
  import('../services/webrtc').then(({ webrtcService }) => {
    webrtcService.toggleMute();
  });
}

function toggleVoiceDeafen(next: any, current: boolean): void {
  const target = typeof next === 'function' ? next(current) : next;
  if (target === current) return;
  import('../services/webrtc').then(({ webrtcService }) => {
    webrtcService.toggleDeafen();
  });
}

async function applyMediaToggle(target: boolean, kind: 'webcam' | 'screen'): Promise<void> {
  const { webrtcService } = await import('../services/webrtc');
  if (kind === 'webcam') {
    if (target) await webrtcService.startWebcam();
    else await webrtcService.stopWebcam();
    return;
  }
  if (target) await webrtcService.startScreenShare();
  else await webrtcService.stopScreenShare();
}

function toggleLocalMedia(
  next: boolean | ((v: boolean) => boolean),
  current: boolean,
  setRaw: (v: boolean) => void,
  kind: 'webcam' | 'screen',
): void {
  const target = typeof next === 'function' ? next(current) : next;
  if (target === current) return;
  // Optimistic flip so the button reacts instantly; rewind if the media
  // request rejects (permission denied, no camera, etc.).
  setRaw(target);
  applyMediaToggle(target, kind).catch((err) => {
    console.warn(`[Voice] ${kind} toggle failed`, err);
    setRaw(!target);
  });
}

const TYPING_EXPIRY_MS = 5000;

function useChatAppVoiceState(data: any): {
  voice: ReturnType<typeof useVoiceConnection>;
  voiceConnection: { channelId: string; channel: string } | null;
  mute: boolean;
  deaf: boolean;
  cam: boolean;
  screen: boolean;
  setMute: (next: any) => void;
  setDeaf: (next: any) => void;
  setCam: (next: boolean | ((v: boolean) => boolean)) => void;
  setScreen: (next: boolean | ((v: boolean) => boolean)) => void;
} {
  const voice = useVoiceConnection();
  const voiceCh = data.CHANNELS?.find((c: any) => c.id === voice.currentChannelId);
  const voiceConnection = voice.connected && voiceCh
    ? { channelId: voice.currentChannelId, channel: voiceCh.name }
    : null;
  const [cam, setCamRaw] = useState(false);
  const [screen, setScreenRaw] = useState(false);
  // Reset cam/screen when voice disconnects so the user-panel icons go back
  // to off — leaveChannel already stops the media tracks in the store.
  useEffect(() => {
    if (!voice.connected) {
      setCamRaw(false);
      setScreenRaw(false);
    }
  }, [voice.connected]);
  const setMute = (next: any) => toggleVoiceMute(next, voice.muted);
  const setDeaf = (next: any) => toggleVoiceDeafen(next, voice.deafened);
  const setCam = (next: boolean | ((v: boolean) => boolean)) =>
    toggleLocalMedia(next, cam, setCamRaw, 'webcam');
  const setScreen = (next: boolean | ((v: boolean) => boolean)) =>
    toggleLocalMedia(next, screen, setScreenRaw, 'screen');
  return {
    voice, voiceConnection,
    mute: voice.muted, deaf: voice.deafened,
    cam, screen,
    setMute, setDeaf, setCam, setScreen,
  };
}

function useActiveChannelTyping(activeChannel: string): string[] {
  const myUserId = currentUserId();
  const typingUsersForActive = useMessageStore((s) => s.typing.get(activeChannel));
  const clearTyping = useMessageStore((s) => s.clearTyping);
  const [typingTick, setTypingTick] = useState(0);
  useEffect(() => {
    if (!typingUsersForActive || typingUsersForActive.length === 0) return;
    const id = setInterval(() => setTypingTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [typingUsersForActive]);
  useEffect(() => {
    if (!typingUsersForActive) return;
    const now = Date.now();
    for (const u of typingUsersForActive) {
      if (now - u.timestamp > TYPING_EXPIRY_MS) {
        clearTyping(activeChannel, u.userId);
      }
    }
  }, [typingUsersForActive, typingTick, activeChannel, clearTyping]);
  // typingTick is intentionally a dep so the filter re-evaluates each second
  // as entries cross the expiry threshold.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const now = Date.now();
    return (typingUsersForActive ?? [])
      .filter((u) => u.userId !== myUserId)
      .filter((u) => now - u.timestamp < TYPING_EXPIRY_MS)
      .map((u) => u.username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingUsersForActive, myUserId, typingTick]);
}

function dropStagedAttachment(
  prev: Record<string, StagedAttachment[]>,
  attId: string,
): Record<string, StagedAttachment[]> {
  const next: Record<string, StagedAttachment[]> = {};
  for (const [cid, list] of Object.entries(prev)) {
    const removed = list.find((a) => a.id === attId);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    next[cid] = list.filter((a) => a.id !== attId);
  }
  return next;
}

function deriveActiveMutedChannels(mutedMap: Map<string, string | null>): Set<string> {
  const out = new Set<string>();
  const now = Date.now();
  for (const [cid, until] of mutedMap.entries()) {
    if (until === null || new Date(until).getTime() > now) out.add(cid);
  }
  return out;
}

function tickActiveSlowLocks(
  slowLocks: Record<string, { strikes: number; until: number }>,
  tickSlowLocks: (updater: (n: number) => number) => void,
  setSlowLocks: (updater: (prev: Record<string, { strikes: number; until: number }>) => Record<string, { strikes: number; until: number }>) => void,
): (() => void) | undefined {
  const hasActive = Object.values(slowLocks).some((l) => l.until > Date.now());
  if (!hasActive) return undefined;
  const id = globalThis.setInterval(() => {
    tickSlowLocks((n) => n + 1);
    setSlowLocks((prev) => pruneExpiredSlowLocks(prev));
  }, 1000);
  return () => globalThis.clearInterval(id);
}

function handleMessageRejected(
  payload: any,
  me: string,
  setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void,
  setDrafts: (updater: (d: Record<string, any>) => Record<string, any>) => void,
  setSlowLocks: (updater: (prev: Record<string, { strikes: number; until: number }>) => Record<string, { strikes: number; until: number }>) => void,
): void {
  const channelId = payload?.channel_id;
  if (!channelId) return;
  setMessages((prev) => rollbackOptimistic(prev, channelId, me, setDrafts));
  const retryIn = Number(payload?.retry_in ?? 0);
  if (payload?.reason === 'slow_mode' && retryIn > 0) {
    setSlowLocks((prev) => addSlowLockStrike(prev, channelId, retryIn));
  }
}

function insertMentionIntoDraft(
  name: string,
  targetId: string | null | undefined,
  setDrafts: (updater: (prev: Record<string, string>) => Record<string, string>) => void,
): void {
  if (!name || !targetId) return;
  setDrafts((prev) => ({
    ...prev,
    [targetId]: ((prev[targetId] || '').trimEnd() + ' @' + name + ' ').trimStart(),
  }));
}

function closeDmFromEvent(
  dmId: string,
  ctx: {
    data: any;
    activeDM: string | null;
    activeChannel: string;
    setActiveDM: (id: string | null) => void;
    setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void;
  },
): void {
  if (!dmId) return;
  // Drop from local DM list. Server-side DM channels stick around for
  // history retention; users can re-open from a member profile.
  ctx.data.DMS = ctx.data.DMS.filter((x: any) => x.id !== dmId);
  if (ctx.activeDM === dmId) {
    ctx.setActiveDM(null);
    ctx.setActiveView({ kind: 'channel', id: ctx.activeChannel });
  }
}

function handlePickChannelEvent(
  id: string,
  data: any,
  setActiveChannel: (id: string) => void,
  setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void,
  setTab: (t: string) => void,
): void {
  if (!data.CHANNELS.some((c: any) => c.id === id)) return;
  setActiveChannel(id);
  setActiveView({ kind: 'channel', id });
  setTab('kanals');
}

async function openDmForMember(
  memberId: string,
  ctx: {
    data: any;
    activeTeamId: string | null | undefined;
    setActiveDM: (id: string) => void;
    setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void;
    setTab: (t: string) => void;
  },
): Promise<void> {
  if (!memberId) return;
  const { data, activeTeamId, setActiveDM, setActiveView, setTab } = ctx;
  const optimisticId = 'dm-' + memberId;
  if (!data.DMS.some((d: any) => d.id === optimisticId)) {
    data.DMS.push({ id: optimisticId, with: memberId, preview: '', at: new Date(), unread: 0 });
  }
  setActiveDM(optimisticId);
  setActiveView({ kind: 'dm', id: optimisticId });
  setTab('pms');
  if (!activeTeamId || isMockSession()) return;
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

function lookupChannelById(id: string): any {
  const tid = useTeamStore.getState().activeTeamId;
  if (!tid) return undefined;
  return (useTeamStore.getState().channels.get(tid) ?? []).find((c: any) => c.id === id);
}

function lookupGroupById(id: string): any {
  const tid = useTeamStore.getState().activeTeamId;
  if (!tid) return undefined;
  return (useTeamStore.getState().groups.get(tid) ?? []).find((x: any) => x.id === id);
}

function runToggleReaction(args: {
  channelId: string;
  msgId: string;
  emoji: string;
  activeTeamId: string | null | undefined;
  dmMessages: Record<string, any[]>;
  messages: Record<string, any[]>;
  setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
}): void {
  const { channelId, msgId, emoji, activeTeamId, dmMessages, messages, setDmMessages, setMessages } = args;
  const isDM = channelId.startsWith('dm-');
  const setter = isDM ? setDmMessages : setMessages;
  // Capture the pre-toggle mine flag before optimistic state changes — used
  // to decide add vs remove on the backend.
  const currentList = isDM ? dmMessages[channelId] : messages[channelId];
  const currentMsg = currentList?.find((m) => m.id === msgId);
  const wasMine = !!currentMsg?.reactions?.find((r: any) => r.e === emoji)?.mine;
  setter((prev) => {
    const arr = prev[channelId] || [];
    return {
      ...prev,
      [channelId]: arr.map((m) => m.id === msgId ? applyToggleReaction(m, emoji) : m),
    };
  });
  // Real reaction toggle (channel only — DM reactions API not exposed yet).
  if (!activeTeamId || isDM) return;
  const call = wasMine
    ? api.removeReaction(activeTeamId, channelId, msgId, emoji)
    : api.addReaction(activeTeamId, channelId, msgId, emoji);
  call.catch((err) => console.warn('[ChatApp] reaction toggle failed', err));
}

function runVoteOnPoll(args: {
  channelId: string;
  msgId: string;
  optIdx: number;
  activeTeamId: string | null | undefined;
}): void {
  const { channelId, msgId, optIdx, activeTeamId } = args;
  if (channelId.startsWith('dm-')) return; // polls only in team channels
  if (!activeTeamId) return;
  const me = currentUserId();
  const state = usePollStore.getState();
  const current = (state.polls.get(channelId) ?? []).find((p) => p.id === msgId);
  if (!current) return;
  const alreadyMine = (current.voters[optIdx] || []).includes(me);
  const nextVoters = current.voters.map((arr: string[], i: number) => {
    if (i === optIdx) return alreadyMine ? arr.filter((u) => u !== me) : Array.from(new Set([...arr, me]));
    return arr.filter((u) => u !== me); // single-choice
  });
  state.upsert({
    ...current,
    tallies: nextVoters.map((arr: string[]) => arr.length),
    voters: nextVoters,
  });
  const promise = alreadyMine
    ? api.unvotePoll(activeTeamId, msgId)
    : api.votePoll(activeTeamId, msgId, optIdx);
  promise.catch((err) => console.warn('[poll] vote failed', err));
}

async function sendChannelEdit(
  activeTeamId: string,
  channelId: string,
  msgId: string,
  newText: string,
  derivedKey: any,
): Promise<void> {
  try {
    const encrypted = await tryEncrypt(newText, channelId, derivedKey);
    ws.editMessage(activeTeamId, msgId, channelId, encrypted);
  } catch (err) {
    console.warn('[ChatApp] channel edit failed', err);
  }
}

function runEditMessage(args: {
  channelId: string;
  msgId: string;
  newText: string;
  activeTeamId: string | null | undefined;
  derivedKey: any;
  setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
}): void {
  const { channelId, msgId, newText, activeTeamId, derivedKey, setDmMessages, setMessages } = args;
  const isDM = channelId.startsWith('dm-');
  const setter = isDM ? setDmMessages : setMessages;
  setter((prev) => ({
    ...prev,
    [channelId]: (prev[channelId] || []).map((m) =>
      m.id === msgId ? { ...m, text: newText, edited: true, editedAt: Date.now() } : m,
    ),
  }));
  if (!activeTeamId) return;
  if (isDM) {
    api.editDMMessage(activeTeamId, channelId, msgId, newText).catch((err) =>
      console.warn('[ChatApp] DM edit failed', err),
    );
    return;
  }
  if (!isMockSession()) {
    void sendChannelEdit(activeTeamId, channelId, msgId, newText, derivedKey);
  }
}

function runDeleteMessage(args: {
  channelId: string;
  msgId: string;
  activeTeamId: string | null | undefined;
  setDmMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
  setMessages: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void;
}): void {
  const { channelId, msgId, activeTeamId, setDmMessages, setMessages } = args;
  const isDM = channelId.startsWith('dm-');
  const setter = isDM ? setDmMessages : setMessages;
  setter((prev) => ({
    ...prev,
    [channelId]: (prev[channelId] || []).filter((m) => m.id !== msgId),
  }));
  if (!activeTeamId) return;
  if (isDM) {
    api.deleteDMMessage(activeTeamId, channelId, msgId).catch((err) =>
      console.warn('[ChatApp] DM delete failed', err),
    );
    return;
  }
  ws.deleteMessage(activeTeamId, msgId, channelId);
}

const SHELL_KBD_CHANNEL_ORDER = ['general', 'design', 'dev', 'mesh', 'random'];

async function stageAttachment(
  file: File,
  channel: { id: string; name: string },
  activeTeamId: string | null | undefined,
  setPendingAttachments: (updater: (prev: Record<string, any[]>) => Record<string, any[]>) => void,
): Promise<void> {
  // Upload immediately so we have the server attachment id by the time the
  // user hits Send, but stage on the composer instead of firing a message.
  if (!activeTeamId || isMockSession()) return;
  const isImage = file.type?.startsWith('image/');
  const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
  try {
    const att = await api.uploadFile(activeTeamId, file);
    setPendingAttachments((prev) => ({
      ...prev,
      [channel.id]: [
        ...(prev[channel.id] || []),
        {
          id: att.id,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          previewUrl,
        },
      ],
    }));
  } catch (err) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    console.warn('[ChatApp] attachment upload failed', err);
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', {
      detail: { channel: channel.name, author: 'system', text: 'Upload failed — ' + (err as Error).message, duration: 4000 },
    }));
  }
}

function resolveSlowModeLock(
  lock: { strikes: number; until: number } | undefined,
): { secondsLeft: number } | null {
  if (!lock || lock.strikes < 3) return null;
  const secondsLeft = Math.max(0, Math.ceil((lock.until - Date.now()) / 1000));
  return secondsLeft > 0 ? { secondsLeft } : null;
}

function handleShellGlobalKey(
  e: KeyboardEvent,
  ctx: {
    voiceConnection: any;
    setActiveChannel: (id: string) => void;
    setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void;
    setTab: (t: string) => void;
    setMute: (next: (v: boolean) => boolean) => void;
    setDeaf: (next: (v: boolean) => boolean) => void;
  },
): void {
  const inField = (e.target as Element | null)?.matches?.('input, textarea, [contenteditable="true"]');
  if (inField) return;
  const { voiceConnection, setActiveChannel, setActiveView, setTab, setMute, setDeaf } = ctx;
  if ((e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) {
    const id = SHELL_KBD_CHANNEL_ORDER[Number.parseInt(e.key, 10) - 1];
    if (id) {
      e.preventDefault();
      setActiveChannel(id);
      setActiveView({ kind: 'channel', id });
      setTab('kanals');
    }
    return;
  }
  if (!voiceConnection) return;
  const key = e.key.toLowerCase();
  if (key === 'm') {
    e.preventDefault();
    setMute((v) => !v);
    return;
  }
  if (key === 'd') {
    e.preventDefault();
    setDeaf((v) => !v);
  }
}

function toggleChannelMuteState(id: string): void {
  const teamId = useTeamStore.getState().activeTeamId;
  const muteStore = useChannelMuteStore.getState();
  if (!teamId || isMockSession()) {
    // Mock session — flip the local store only.
    if (muteStore.isMuted(id)) muteStore.clear(id);
    else muteStore.setMuted(id, null);
    return;
  }
  const currentlyMuted = muteStore.isMuted(id);
  // Optimistic so the icon flips instantly; WS echo arrives shortly.
  if (currentlyMuted) {
    muteStore.clear(id);
    api.unmuteChannel(teamId, id).catch((err) => {
      console.warn('[mute] unmute failed', err);
      useChannelMuteStore.getState().setMuted(id, null);
    });
    return;
  }
  muteStore.setMuted(id, null);
  api.muteChannel(teamId, id, null).catch((err) => {
    console.warn('[mute] mute failed', err);
    useChannelMuteStore.getState().clear(id);
  });
}

function handlePickChannel(
  id: string,
  data: any,
  setActiveChannel: (id: string) => void,
  setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void,
): void {
  setActiveChannel(id);
  setActiveView({ kind: 'channel', id });
  // Mirror local activeChannel into useTeamStore so the global message:new
  // listener can suppress the unread bump for the channel you're viewing.
  useTeamStore.getState().setActiveChannel(id);
  useDMStore.getState().setActiveDM(null);
  useUnreadStore.getState().markRead(id);
  const teamId = useTeamStore.getState().activeTeamId;
  if (teamId && !isMockSession()) {
    markLatestRead(teamId, id, data?.MESSAGES?.[id]);
  }
}

function handlePickDM(
  id: string,
  data: any,
  setActiveDM: (id: string) => void,
  setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void,
): void {
  setActiveDM(id);
  setActiveView({ kind: 'dm', id });
  useDMStore.getState().setActiveDM(id);
  useUnreadStore.getState().markRead(id);
  const teamId = useTeamStore.getState().activeTeamId;
  if (teamId && !isMockSession()) {
    markLatestRead(teamId, id, data?.DM_MESSAGES?.[id]);
  }
}

function handleSidebarTabSwitch(
  next: string,
  ctx: {
    setTab: (t: string) => void;
    setActiveDM: (id: string) => void;
    setActiveView: (v: { kind: 'channel' | 'dm'; id: string }) => void;
    setActiveChannel: (id: string) => void;
    activeDM: string | null;
    activeChannel: string;
    dms: Array<{ id: string }>;
    channelsForServer: Array<{ id: string; type: string }>;
  },
): void {
  const { setTab, setActiveDM, setActiveView, setActiveChannel,
    activeDM, activeChannel, dms, channelsForServer } = ctx;
  setTab(next);
  if (next === 'pms') {
    const target = activeDM ?? dms[0]?.id ?? null;
    if (target) {
      setActiveDM(target);
      setActiveView({ kind: 'dm', id: target });
    }
    return;
  }
  if (next === 'kanals') {
    const target = activeChannel || (channelsForServer.find((c) => c.type === 'text')?.id ?? null);
    if (target) {
      setActiveChannel(target);
      setActiveView({ kind: 'channel', id: target });
      useTeamStore.getState().setActiveChannel(target);
      useDMStore.getState().setActiveDM(null);
    }
  }
}

function syncActiveViewToStores(activeView: { kind: string; id: string }, data: any): void {
  if (!activeView.id) return;
  const teamId = useTeamStore.getState().activeTeamId;
  if (activeView.kind === 'channel') {
    useTeamStore.getState().setActiveChannel(activeView.id);
    useDMStore.getState().setActiveDM(null);
    useUnreadStore.getState().markRead(activeView.id);
    if (teamId && !isMockSession()) {
      markLatestRead(teamId, activeView.id, data?.MESSAGES?.[activeView.id]);
    }
    return;
  }
  if (activeView.kind === 'dm') {
    useDMStore.getState().setActiveDM(activeView.id);
    // Clear the channel id so a channel echo doesn't think it's "live"
    // while a DM is on screen.
    useTeamStore.getState().setActiveChannel('');
    useUnreadStore.getState().markRead(activeView.id);
    if (teamId && !isMockSession()) {
      markLatestRead(teamId, activeView.id, data?.DM_MESSAGES?.[activeView.id]);
    }
  }
}

function buildMemberContextItems(m: any, memberPerms: any, teamName: string): any[] {
  const items: any[] = [
    { label: 'Send message', icon: <Icon.Chat size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: m.id })) },
    { label: 'Mention in current kanal', icon: <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 13 }}>@</span>, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:insert-mention', { detail: m.name })) },
    { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: m.id, x: 200, y: 200 } })) },
    { label: 'Verify safety number', icon: <Icon.Shield size={12} />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: m.id })) },
    { sep: true },
    useBlockStore.getState().isBlocked(m.id)
      ? { label: 'Unblock', icon: <Icon.Shield size={12} />, onClick: () => unblockMember(m.id) }
      : { label: 'Block', danger: true, icon: <Icon.Shield size={12} />, onClick: () => blockMember(m.id, m.name) },
    { label: 'Mute', icon: <Icon.Mic size={13} off />, onClick: () => globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: teamName, author: 'system', text: m.name + ' muted in voice channels.', duration: 2200 } })) },
  ];
  if (memberPerms.has(PERM_MANAGE_MEMBERS) && m.id !== currentUserId()) {
    items.push(
      { label: 'Kick from team', danger: true, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 4V2H3v12h7v-2M6 8h9M12 5l3 3-3 3M9 3v0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>, onClick: () => kickMember(m.id, m.name, teamName) },
      { label: 'Ban from team', danger: true, icon: <Icon.Lock size={12} />, onClick: () => banMember(m.id, m.name, teamName) },
    );
  }
  return items;
}

function MemberRow({ m, ctx }) {
  const { nodes, fps, rich, federated, teamName, memberPerms } = ctx;
  const off = m.status === 'offline';
  const node = nodes[m.id] || '';
  const fed = node && !node.includes('gbg-1');
  return (
    <button type="button" className={'member' + (off ? ' offline' : '')}
         onClick={(e) => {
           const r = e.currentTarget.getBoundingClientRect();
           globalThis.dispatchEvent(new CustomEvent('dilla:open-profile', {
             detail: { memberId: m.id, x: r.left - 270, y: r.top }
           }));
         }}
         onContextMenu={(e) => {
           e.preventDefault();
           globalThis.dispatchEvent(new CustomEvent('dilla:open-menu', {
             detail: { x: e.clientX, y: e.clientY, items: buildMemberContextItems(m, memberPerms, teamName) },
           }));
         }}>
      <Avatar member={m} />
      <span style={{ minWidth: 0, flex: 1, display: 'block' }}>
        <span className="member-name" style={{ display: 'block' }}>{m.name}</span>
        <span className="member-status" style={{ display: 'block' }}>{m.custom || m.status}</span>
      </span>
      {rich && fed && federated && (
        <span className="node-tag fed" title={`Account hosted on federated node "${node}" — relayed to gbg-1 over the dilla mesh.`}>
          {node.replace('.io','').replace('.dilla.local','')}
        </span>
      )}
      {rich && fps[m.id] && (
        <span className="member-fingerprint">
          <span style={{ color: 'var(--accent)', marginBottom: 2 }}>SAFETY NUMBER · {node || 'local'}</span>
          {fps[m.id]}
        </span>
      )}
    </button>
  );
}

export function MemberList({ members, voiceConnection, rich, federated }) {
  // Resolve the viewer's perms once per render so menu items can hide
  // admin actions for non-admins instead of toasting 'permission required'
  // after a 403. teamMembers comes from the store so role changes flow in
  // without a prop drill.
  const memberListTeamId = useTeamStore((s) => s.activeTeamId);
  const memberListTeamMembers = useTeamStore((s) => (memberListTeamId ? s.members.get(memberListTeamId) ?? EMPTY_LIST : EMPTY_LIST)) as any[];
  const memberPerms = useMemo(
    () => resolvePermissions(memberListTeamMembers, currentUserId()),
    [memberListTeamMembers],
  );
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
  const teamName = data?.SERVERS?.[0]?.name || '';
  const MC = globalThis.MeshChrome || {};
  const nodes = MC.MEMBER_NODES || {};
  const fps = MC.FINGERPRINTS || {};
  const { offline, groupOrder, groupMeta, groups, onlineDefault } = groupMembersByRole(members.MEMBERS);

  const rowCtx = { nodes, fps, rich, federated, teamName, memberPerms };

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
          {groups[key].map((m: any) => <MemberRow key={m.id} m={m} ctx={rowCtx} />)}
        </React.Fragment>
      ))}
      {onlineDefault.length > 0 && (
        <>
          <div className="members-section">Online — {onlineDefault.length}</div>
          {onlineDefault.map((m: any) => <MemberRow key={m.id} m={m} ctx={rowCtx} />)}
        </>
      )}
      {offline.length > 0 && (
        <>
          <div className="members-section">Offline — {offline.length}</div>
          {offline.map((m: any) => <MemberRow key={m.id} m={m} ctx={rowCtx} />)}
        </>
      )}
    </aside>
  );
}

// ───────────── root ─────────────
function ChatApp({ theme, opts = {}, rich = false, controller }) {
  // Live shell data via context. Replaces the old `globalThis.SHELL_DATA`
  // global read so re-renders are React-driven and tests can inject a
  // provider without monkey-patching globalThis. Handlers below close over
  // this binding instead of re-reading the global.
  const data = (useShellDataContext() as any) || EMPTY_SHELL_DATA;
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
  React.useEffect(() => syncActiveViewToStores(activeView, data), [activeView.kind, activeView.id]);
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
  useEffect(() => tickActiveSlowLocks(slowLocks, tickSlowLocks, setSlowLocks), [slowLocks]);

  // Server-side rejections (slow mode, future quota/perm gates) — roll
  // back the optimistic message, restore its text to the composer, and
  // bump the strike count so we can disable the composer after three.
  useEffect(() => {
    const me = currentUserId();
    const unsub = ws.on('message:rejected', (payload: any) =>
      handleMessageRejected(payload, me, setMessages, setDrafts, setSlowLocks),
    );
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
  const voiceUi = useChatAppVoiceState(data);
  const { voice, voiceConnection, mute, deaf, cam, screen, setMute, setDeaf, setCam, setScreen } = voiceUi;
  // Channel typing indicator: read straight from useMessageStore which
  // useChannelEvents populates on every typing:indicator WS event. We
  // filter ourselves out, drop entries older than 5s (typing decay),
  // and project to a list of usernames so TextChannel's existing
  // render path (which expects string[]) works unchanged.
  const typing = useActiveChannelTyping(activeChannel);
  const [dmTyping] = useState({}); // channelId -> [names]
  const [settings, setSettings] = useState({ open: false, mode: 'user', tab: null });
  const [membersOpen, setMembersOpen] = useState(true);
  const [profilePop, setProfilePop] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replyTo, setReplyTo] = useState({}); // channelId -> msgId
  // Files attached to the composer but not yet sent. Each entry is the
  // already-uploaded attachment row, keyed by channel id, so switching
  // channels keeps each channel's staged set independent. The composer
  // renders a chip per entry with an × to drop it; the actual message
  // send pulls all attachment ids in one go and then clears the bucket.
  const [pendingAttachments, setPendingAttachments] =
    useState<Record<string, StagedAttachment[]>>({});
  // Stable reference so TextChannel's effects don't re-fire each render.
  // The setter reads channel.id off the closure of the parent send-path
  // (chip × buttons pass attId in directly), so we only need the channel
  // currently rendered in the active TextChannel; resolve it through
  // the channel state at call time.
  const removeStagedAttachment = useCallback((attId: string) => {
    setPendingAttachments((prev) => dropStagedAttachment(prev, attId));
  }, []);
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
  const mutedChannels = useMemo(() => deriveActiveMutedChannels(mutedMap), [mutedMap]);
  const [newDmOpen, setNewDmOpen] = useState(false);
  function openMenu(e, items) {
    e.preventDefault();
    setMenuPop({ x: e.clientX, y: e.clientY, items });
  }

  useEffect(() => {
    function onAddSrv()  { setNewServerOpen(true); }
    function onAddCh()   { setNewChanOpen(true); }
    function onProfile(e) { setProfilePop(e.detail); }
    function onThread(e)  { setActiveThread(e.detail); }
    function onDrawer()   { setDrawerOpen(o => !o); }
    function onInsertMention(e) {
      insertMentionIntoDraft(e.detail, channel?.id || activeChannel, setDrafts);
    }
    function onChannelSettings(e) {
      const ch = lookupChannelById(e.detail);
      if (ch) setChanSettings(ch);
    }
    function onChannelAccess(e) {
      const ch = lookupChannelById(e.detail);
      if (ch) setChanAccess(ch);
    }
    function onGroupAccess(e) {
      const g = lookupGroupById(e.detail);
      if (g) setGroupAccess({ id: g.id, name: g.name, accessRoleIds: g.accessRoleIds, hiddenIfRestricted: g.hiddenIfRestricted });
    }
    function onGroupSettings(e) {
      const g = lookupGroupById(e.detail);
      if (g) setGroupSettings({ id: g.id, name: g.name });
    }
    function onCloseDm(e) {
      closeDmFromEvent(e.detail, { data, activeDM, activeChannel, setActiveDM, setActiveView });
    }
    function onOpenDm(e) {
      void openDmForMember(e.detail, { data, activeTeamId, setActiveDM, setActiveView, setTab });
    }
    function onPickChannel(e) {
      handlePickChannelEvent(e.detail, data, setActiveChannel, setActiveView, setTab);
    }
    function onMenu(e) { setMenuPop(e.detail); }
    globalThis.addEventListener('dilla:open-profile', onProfile);
    globalThis.addEventListener('dilla:open-thread', onThread);
    globalThis.addEventListener('dilla:toggle-drawer', onDrawer);
    globalThis.addEventListener('dilla:pickchannel', onPickChannel);
    globalThis.addEventListener('dilla:open-add-server', onAddSrv);
    globalThis.addEventListener('dilla:open-new-channel', onAddCh);
    globalThis.addEventListener('dilla:open-menu', onMenu);
    globalThis.addEventListener('dilla:open-dm', onOpenDm);
    globalThis.addEventListener('dilla:close-dm', onCloseDm);
    globalThis.addEventListener('dilla:insert-mention', onInsertMention);
    globalThis.addEventListener('dilla:open-channel-settings', onChannelSettings);
    globalThis.addEventListener('dilla:open-channel-access', onChannelAccess);
    globalThis.addEventListener('dilla:open-group-access', onGroupAccess);
    globalThis.addEventListener('dilla:open-group-settings', onGroupSettings);
    function onKey(e) {
      handleShellGlobalKey(e, {
        voiceConnection, setActiveChannel, setActiveView, setTab, setMute, setDeaf,
      });
    }
    globalThis.addEventListener('keydown', onKey);
    return () => {
      globalThis.removeEventListener('dilla:open-profile', onProfile);
      globalThis.removeEventListener('dilla:open-thread', onThread);
      globalThis.removeEventListener('dilla:toggle-drawer', onDrawer);
      globalThis.removeEventListener('dilla:pickchannel', onPickChannel);
      globalThis.removeEventListener('dilla:open-add-server', onAddSrv);
      globalThis.removeEventListener('dilla:open-new-channel', onAddCh);
      globalThis.removeEventListener('dilla:open-dm', onOpenDm);
      globalThis.removeEventListener('dilla:close-dm', onCloseDm);
      globalThis.removeEventListener('dilla:insert-mention', onInsertMention);
      globalThis.removeEventListener('dilla:open-channel-settings', onChannelSettings);
      globalThis.removeEventListener('dilla:open-channel-access', onChannelAccess);
      globalThis.removeEventListener('dilla:open-group-access', onGroupAccess);
      globalThis.removeEventListener('dilla:open-group-settings', onGroupSettings);
      globalThis.removeEventListener('dilla:open-menu', onMenu);
      globalThis.removeEventListener('keydown', onKey);
    };
  }, []);

  function toggleReaction(channelId, msgId, emoji) {
    runToggleReaction({ channelId, msgId, emoji, activeTeamId, dmMessages, messages, setDmMessages, setMessages });
  }

  function voteOnPoll(channelId, msgId, optIdx) {
    runVoteOnPoll({ channelId, msgId, optIdx, activeTeamId });
  }

  useEffect(() => {
    function onOpen(e) {
      const d = e.detail;
      if (typeof d === 'string') setSettings({ open: true, mode: d, tab: null });
      else if (d && typeof d === 'object') setSettings({ open: true, mode: d.mode || 'user', tab: d.tab || null });
      else setSettings({ open: true, mode: 'user', tab: null });
    }
    globalThis.addEventListener('dilla:open-settings', onOpen);
    return () => globalThis.removeEventListener('dilla:open-settings', onOpen);
  }, []);

  // Handoff cycled fake typing here ('ada', 'mira'). Disabled — real
  // typing arrives via websocket → useMessageStore.typing. Wire that up
  // here in a later step.

  // DM typing also disabled — same plan as channel typing above.

  // Expose imperative controls to a parent via the optional `controller` object.
  useEffect(() => {
    if (!controller) return;
    controller.pickChannel = (id) => {
      if (data.CHANNELS.some(c => c.id === id)) {
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
    const onPick = (e: Event) => handleGiphyPick(e, {
      channel, activeChannel, activeTeamId, derivedKey,
      setDmMessages, setMessages,
    });
    globalThis.addEventListener('dilla:giphy-pick', onPick);
    return () => globalThis.removeEventListener('dilla:giphy-pick', onPick);
  }, [channel, activeChannel, activeTeamId, derivedKey]);

  function processSlash(text) {
    const slashCtx: SlashCtx = {
      text,
      data,
      channel,
      activeChannel,
      activeTeamId,
      derivedKey,
      setDmMessages,
      setMessages,
      setGiphyPicker,
    };
    return dispatchSlashCommand(slashCtx);
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
      sendDmFromComposer({
        channel, drafts, pendingAttachments, replyTo,
        activeTeamId, processSlash,
        setDmMessages, setDrafts, setReplyTo, setPendingAttachments,
      });
      return;
    }
    sendChannelFromComposer({
      activeChannel, drafts, pendingAttachments, replyTo,
      activeTeamId, derivedKey, processSlash,
      setMessages, setDrafts, setReplyTo, setPendingAttachments,
    });
  }

  function editMessage(channelId, msgId, newText) {
    runEditMessage({ channelId, msgId, newText, activeTeamId, derivedKey, setDmMessages, setMessages });
  }

  function deleteMessage(channelId, msgId) {
    runDeleteMessage({ channelId, msgId, activeTeamId, setDmMessages, setMessages });
  }

  const rootStyle = globalThis.THEMES.themeVars(theme, opts);
  rootStyle['--sidebar-w'] = (opts.sidebar || 240) + 'px';
  const isDM = channel.type === 'dm';
  const showFourth = activeThread || (membersOpen && !isDM);
  rootStyle['--members-w'] = membersWidth(showFourth, activeThread, opts.members) + 'px';

  return (
    <div className="chat" data-style={theme.style} data-drawer={drawerOpen ? '1' : '0'} style={rootStyle}>
      <ServerRail servers={data.SERVERS} activeServer={activeServer} onPick={setActiveServer} />
      <ChannelSidebar
        team={team}
        tab={tab}
        onTab={(next) => handleSidebarTabSwitch(next, {
          setTab, setActiveDM, setActiveView, setActiveChannel,
          activeDM, activeChannel, dms: data.DMS, channelsForServer,
        })}
        channels={channelsForServer}
        activeChannel={activeChannel}
        onPickChannel={(id) => handlePickChannel(id, data, setActiveChannel, setActiveView)}
        members={data}
        dms={data.DMS}
        activeDM={activeView.kind === 'dm' ? activeView.id : null}
        onPickDM={(id) => handlePickDM(id, data, setActiveDM, setActiveView)}
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
        toggleMuteChannel={toggleChannelMuteState}
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
          slowModeLock={resolveSlowModeLock(slowLocks[channel.id])}
          onSend={send}
          replyTo={replyTo[channel.id]}
          onSetReply={(id) => setReplyTo(prev => ({ ...prev, [channel.id]: id }))}
          onReact={(msgId, emoji) => toggleReaction(channel.id, msgId, emoji)}
          onVote={(msgId, optIdx) => voteOnPoll(channel.id, msgId, optIdx)}
          onEdit={(msgId, text) => editMessage(channel.id, msgId, text)}
          onDelete={(msgId) => deleteMessage(channel.id, msgId)}
          onAttach={(file) => stageAttachment(file, channel, activeTeamId, setPendingAttachments)}
          pendingAttachments={pendingAttachments[channel.id] ?? EMPTY_LIST}
          onRemoveAttachment={removeStagedAttachment}
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
        const SettingsModal = globalThis.Settings;
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
        onDM={(id) => globalThis.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: id }))}
        federated={opts.federated !== false}
      />
      {menuPop && (
        <div className="ctx-overlay">
          <button
            type="button"
            className="ctx-overlay-dismiss"
            aria-label="Close menu"
            onClick={() => setMenuPop(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenuPop(null); }}
          />
          <div className="ctx-menu"
               style={{ left: Math.min(menuPop.x, globalThis.innerWidth - 220), top: Math.min(menuPop.y, globalThis.innerHeight - (menuPop.items.length * 36 + 16)) }}>
            {menuPop.items.map((it, i) => it.sep ? (
              <div key={`sep-${i}-${menuPop.items[i + 1]?.label ?? 'end'}`} className="ctx-sep" />
            ) : (
              <button key={`item-${it.label}-${i}`} className={it.danger ? 'danger' : ''} disabled={!!it.disabled} onClick={() => { if (!it.disabled) { it.onClick?.(); setMenuPop(null); } }}>
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
                globalThis.dispatchEvent(new CustomEvent('dilla:giphy-pick', { detail: { url } }));
                return;
              }
              const att = await api.embedGif(teamId, url);
              const attUrl = api.getAttachmentUrl(teamId, att.id);
              globalThis.dispatchEvent(new CustomEvent('dilla:giphy-pick', { detail: {
                url: attUrl,
                attachment: att,
              } }));
            } catch (err) {
              console.warn('[giphy] embed failed, falling back to URL', err);
              globalThis.dispatchEvent(new CustomEvent('dilla:giphy-pick', { detail: { url } }));
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
          globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Kanal created.', duration: 3500 } }));
        }} />
      )}
      {newServerOpen && (
        <NewServerModal onClose={() => setNewServerOpen(false)} onCreate={(s) => {
          setNewServerOpen(false);
          redirectToOnboarding(s);
        }} />
      )}
      {newDmOpen && (
        <NewDmModal
          members={data}
          onClose={() => setNewDmOpen(false)}
          onPick={async (id) => {
            setNewDmOpen(false);
            await openDmForMember(id, { data, activeTeamId, setActiveDM, setActiveView, setTab });
          }}
        />
      )}
      <button
        type="button"
        className="chat-backdrop"
        aria-label="Close drawer"
        onClick={() => setDrawerOpen(false)}
      />
    </div>
  );
}

export default ChatApp;
