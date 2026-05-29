// @ts-nocheck
// Settings modal for Dilla, ported verbatim from
// design_handoff_dilla_mesh/settings.jsx. Strict TS types come later.
// Two entry points: the team-header cog opens Team settings,
// the user-panel cog opens User preferences.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './icons';
import { randomTail } from '../utils/randomId';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { useBlockStore } from '../stores/blockStore';
import { useVerifiedContacts } from '../stores/verifiedContactsStore';
import { dillaConfirm } from '../stores/confirmStore';
import PasskeyManager from '../components/PasskeyManager/PasskeyManager';
import { api } from '../services/api';
import { cryptoService } from '../services/crypto';
import { ws } from '../services/websocket';
import { isMockSession } from '../services/mockSession';
import { exportIdentityBlob } from '../services/keyStore';
import { useShellDataContext } from './ShellDataContext';
import { startMicTest, stopMicTest, type MicTestSession } from '../services/micTest';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';
import { resolvePermissions } from '../hooks/usePermissions';

const { useState: useStateS, useEffect: useEffectS, useRef: useRefS, useMemo, useCallback: useCallbackS } = React;

// Stable empty array for selector fallbacks. Returning a fresh `[]`
// from a Zustand selector triggers infinite re-renders under jsdom
// (useSyncExternalStore can't dedupe by-value); a frozen shared
// reference makes the selectors stable across calls.
const EMPTY_LIST: never[] = [];

// Debounced save helper for autosaved text fields. The handler clears any
// in-flight timer and schedules a new one — keeps API traffic to one POST
// per ~700ms of idle, matching typical settings UX.
async function performLeaveTeam(args: { onClose: () => void; navigate: (path: string) => void }): Promise<void> {
  const teamId = useTeamStore.getState().activeTeamId;
  const teamName = teamId
    ? useTeamStore.getState().teams.get(teamId)?.name ?? 'this team'
    : 'this team';
  if (!teamId) return;
  const confirmed = await dillaConfirm({
    title: 'Leave ' + teamName + '?',
    body: 'You\'ll lose access to its channels and messages until you re-join with an invite.',
    confirmLabel: 'Leave team',
    danger: true,
  });
  if (!confirmed) return;
  try {
    if (!isMockSession()) await api.leaveTeam(teamId);
    const auth = useAuthStore.getState();
    if (typeof (auth as { removeTeam?: (id: string) => void }).removeTeam === 'function') {
      (auth as { removeTeam: (id: string) => void }).removeTeam(teamId);
    }
    const ts = useTeamStore.getState();
    const next = Array.from(ts.teams.keys()).find((id) => id !== teamId);
    if (next) ts.setActiveTeam(next);
    args.onClose();
    if (!next) args.navigate('/join');
  } catch (err) {
    const msg = (err as Error).message || 'Could not leave the team.';
    globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: msg, duration: 4500 } }));
  }
}

async function performSignOut(args: { onClose: () => void; navigate: (path: string) => void }): Promise<void> {
  args.onClose();
  if (!isMockSession()) {
    const auth = useAuthStore.getState();
    const seen = new Set<string>();
    const calls: Array<Promise<boolean>> = [];
    for (const [, server] of auth.servers) {
      if (!server.baseUrl || !server.token || seen.has(server.baseUrl)) continue;
      seen.add(server.baseUrl);
      calls.push(api.logoutServer(server.baseUrl, server.token));
    }
    if (calls.length > 0) {
      const results = await Promise.all(calls);
      if (results.some((ok) => !ok)) {
        globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: {
          author: 'system',
          text: 'Signed out locally, but the server-side token revocation may have failed for one or more servers. The token will expire on its own.',
          duration: 6000,
        }}));
      }
    }
  }
  try { useAuthStore.getState().logout(); } catch { /* ignore */ }
  args.navigate('/login');
}

function leaveOrSignOut(args: { mode: string; onClose: () => void; navigate: (path: string) => void }): void {
  if (args.mode === 'team') void performLeaveTeam(args);
  else void performSignOut(args);
}

function parseAuditDetails(details: string | null | undefined): Record<string, unknown> | null {
  if (!details) return null;
  try { return JSON.parse(details) as Record<string, unknown>; } catch { return null; }
}

function describeRoleAudit(action: string, name: string): string | null {
  switch (action) {
    case 'role.create':  return `created role ${name || '—'}`;
    case 'role.update':  return `updated role ${name || '—'}`;
    case 'role.delete':  return `deleted role ${name || '—'}`;
    case 'role.reorder': return `reordered roles`;
    default: return null;
  }
}

function describeChannelAudit(action: string, name: string, detail: Record<string, unknown> | null): string | null {
  const detailType = detail?.type as string | undefined;
  switch (action) {
    case 'channel.create':        return `created channel #${name || '—'}${detailType ? ' · ' + detailType : ''}`;
    case 'channel.delete':        return `deleted channel #${name || '—'}`;
    case 'channel.lock':          return `locked channel #${name || '—'}`;
    case 'channel.unlock':        return `unlocked channel #${name || '—'}`;
    case 'channel.update':        return `updated channel #${name || '—'}`;
    case 'channel.access.update': return `changed access for channel`;
    default: return null;
  }
}

function describeMemberAudit(action: string, targetUser: string | null, e: { target_id?: string }, detail: Record<string, unknown> | null): string | null {
  const who = targetUser || e.target_id || '?';
  switch (action) {
    case 'member.roles.update': return `changed roles for @${who}`;
    case 'member.kick':         return `kicked @${who}`;
    case 'member.ban': {
      const reason = detail?.reason as string | undefined;
      const reasonText = reason ? ` — ${reason}` : '';
      return `banned @${who}${reasonText}`;
    }
    default: return null;
  }
}

function describeMiscAudit(action: string, name: string, detail: Record<string, unknown> | null): string | null {
  if (action === 'team.update') return `updated team settings${name ? ' · ' + name : ''}`;
  if (action === 'invite.create') {
    const max = detail?.max_uses as number | undefined;
    const exp = detail?.expires_at as string | undefined;
    return `created an invite${max ? ' · max ' + max : ''}${exp ? ' · expires ' + exp : ''}`;
  }
  if (action === 'invite.revoke') return `revoked an invite`;
  return null;
}

function describeAuditEventInline(
  e: { action: string; target_id?: string; target_type?: string; details?: string },
  membersById: Map<string, { username?: string }>,
): string {
  const detail = parseAuditDetails(e.details);
  const targetUser = e.target_type === 'user' && e.target_id
    ? membersById.get(e.target_id)?.username ?? null
    : null;
  const name = (detail && ((detail.name as string) || (detail.reason as string))) || '';
  return (
    describeRoleAudit(e.action, name)
    ?? describeChannelAudit(e.action, name, detail)
    ?? describeMemberAudit(e.action, targetUser, e, detail)
    ?? describeMiscAudit(e.action, name, detail)
    ?? e.action
  );
}

function describeRotationResult(rotated: number): string {
  if (!rotated) return 'No active sender keys to rotate yet.';
  const noun = rotated === 1 ? 'channel' : 'channels';
  return `Rotated sender keys for ${rotated} ${noun}.`;
}

function escapeToClose(e: KeyboardEvent, onClose: () => void): void {
  if (e.key === 'Escape') onClose();
}

function applyAvatarUrl(url: string, userId?: string): void {
  if (!userId) return;
  const ts = useTeamStore.getState();
  for (const [teamId, list] of ts.members) {
    const idx = list.findIndex((m) => m.userId === userId);
    if (idx < 0) continue;
    const next = list.map((m, i) => (i === idx ? { ...m, avatarUrl: url } : m));
    ts.setMembers(teamId, next);
  }
}

function clampCrop(next: { x: number; y: number; size: number }, w: number, h: number) {
  const size = Math.max(40, Math.min(next.size, w, h));
  const x = Math.max(0, Math.min(next.x, w - size));
  const y = Math.max(0, Math.min(next.y, h - size));
  return { x, y, size };
}

function cssColorToHex(cssColor: string, fallback: string): string {
  const m = /rgba?\(([^)]+)\)/i.exec(cssColor);
  if (!m) return fallback;
  const parts = m[1].split(',').map((s) => Number.parseFloat(s.trim()));
  const [r, g, b] = parts;
  if ([r, g, b].some((n) => Number.isNaN(n))) return fallback;
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function formatExpiry(expiresAt: Date | null): string {
  if (!expiresAt) return '—';
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (days >= 1) return expiresAt.toLocaleDateString();
  if (hours >= 1) return `in ${hours}h ${mins}m`;
  if (mins >= 1) return `in ${mins}m ${secs}s`;
  return `in ${secs}s`;
}

function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function giphyHint(configured: boolean | null | undefined): string {
  if (configured == null) return 'Loading…';
  if (configured) return 'A key is on file. Paste a new one to replace it, or clear it below.';
  return 'No key yet — admins can paste one from developers.giphy.com.';
}

function useDebouncedSave<T>(action: (value: T) => void, delay = 700) {
  const ref = useRefS<ReturnType<typeof setTimeout> | null>(null);
  return (value: T) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => action(value), delay);
  };
}

// Resolve the active team's baseUrl + token (or null if no auth yet / mock
// session). Used by sections that PATCH /api/v1/users/me etc.
function useActiveTeamAuth(): { baseUrl: string; token: string; teamId: string } | null {
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const team = useAuthStore((s) => (activeTeamId ? s.teams.get(activeTeamId) : null));
  if (!activeTeamId || !team || isMockSession()) return null;
  return { baseUrl: team.baseUrl ?? '', token: team.token ?? '', teamId: activeTeamId };
}

export const USER_TABS = [
  { id: 'account',  name: 'Account' },
  { id: 'devices',  name: 'Devices' },
  { id: 'notif',    name: 'Notifications' },
  { id: 'voice',    name: 'Voice & video' },
  { id: 'appear',   name: 'Appearance' },
  { id: 'privacy',  name: 'Privacy & encryption' },
  { id: 'keys',     name: 'Keyboard shortcuts' },
];
export const TEAM_TABS = [
  { id: 'team',         name: 'Team info' },
  { id: 'invites',      name: 'Invites' },
  { id: 'members',      name: 'Members' },
  { id: 'roles',        name: 'Roles & permissions' },
  { id: 'integrations', name: 'Integrations' },
  { id: 'federation',   name: 'Federation' },
  { id: 'audit',        name: 'Audit log' },
];

function Settings({ open, mode, defaultTab, onClose }) {
  const tabs = mode === 'team' ? TEAM_TABS : USER_TABS;
  const [active, setActive] = useStateS(defaultTab || tabs[0].id);
  const navigate = useNavigate();
  // ALL hooks must run on every render — keeping useShellDataContext below
  // the `if (!open) return null` early return was a hook-order violation
  // that React only flagged once an in-modal re-render (e.g. avatar upload
  // updating the team store) gave it a second chance to compare counts.
  const data = useShellDataContext() as any;
  useEffectS(() => { if (open) setActive(defaultTab || tabs[0].id); }, [open, mode, defaultTab]);
  useEffectS(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => escapeToClose(e, onClose);
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const meId = data?.currentUserId;
  const me = meId ? data?.byId?.[meId] : null;
  const team = data?.SERVERS?.[0];
  const subLabel = mode === 'team'
    ? (team?.name?.toUpperCase() || '')
    : (me?.name || '');

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-overlay-dismiss"
        aria-label="Close settings"
        onClick={onClose}
      />
      <div className="settings">
        <aside className="set-nav">
          <div className="set-nav-head">
            <div className="set-nav-title">{mode === 'team' ? 'Team' : 'User'}</div>
            <div className="set-nav-sub">{subLabel}</div>
          </div>
          {tabs.map(t => (
            <button key={t.id}
                    className={'set-nav-item' + (active === t.id ? ' active' : '')}
                    onClick={() => setActive(t.id)}>
              {t.name}
            </button>
          ))}
          <div className="set-nav-foot">
            <button
              className="set-nav-item danger"
              onClick={() => leaveOrSignOut({ mode, onClose, navigate })}
            >
              {mode === 'team' ? 'Leave team' : 'Sign out'}
            </button>
          </div>
        </aside>
        <main className="set-pane">
          <header className="set-pane-head">
            <h2>{tabs.find(t => t.id === active)?.name}</h2>
            <button className="set-close" onClick={onClose} title="Close (Esc)">×</button>
          </header>
          <div className="set-body">
            {mode === 'user'  && active === 'account'   && <UserAccount />}
            {mode === 'user'  && active === 'devices'   && <UserDevices />}
            {mode === 'user'  && active === 'notif'     && <UserNotif />}
            {mode === 'user'  && active === 'voice'     && <UserVoice />}
            {mode === 'user'  && active === 'appear'    && <UserAppear />}
            {mode === 'user'  && active === 'privacy'   && <UserPrivacy />}
            {mode === 'user'  && active === 'keys'      && <UserKeys />}
            {mode === 'team'  && active === 'team'      && <TeamInfo />}
            {mode === 'team'  && active === 'invites'   && <TeamInvites />}
            {mode === 'team'  && active === 'members'   && <TeamMembers />}
            {mode === 'team'  && active === 'roles'     && <TeamRoles />}
            {mode === 'team'  && active === 'integrations' && <TeamIntegrations />}
            {mode === 'team'  && active === 'federation'&& <TeamFederation />}
            {mode === 'team'  && active === 'audit'     && <TeamAudit />}
          </div>
          <footer className="set-foot">
            <span className="set-foot-hint">changes are saved per-device · push to peers on save</span>
            {/* Per-form Save / Discard buttons live inside each tab now
                (TeamInfo, UserAccount, UserNotif). The old footer had a
                'Save changes' button that did nothing because the
                fields had already auto-saved via useDebouncedSave —
                drop it so the modal is honest about its model. */}
            <div className="set-foot-actions">
              <button className="btn" onClick={onClose}>Close · esc</button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

// ───────── shared form atoms ─────────
export function Row({ label, hint, children }) {
  return (
    <div className="set-row">
      <div className="set-row-l">
        <div className="set-row-label">{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-r">{children}</div>
    </div>
  );
}
export function Group({ title, hint, children }) {
  return (
    <section className="set-group">
      <h3>{title}</h3>
      {hint && <p className="set-group-hint">{hint}</p>}
      {children}
    </section>
  );
}
export function Toggle({ value, onChange }) {
  return (
    <button className="set-toggle" data-on={value ? '1' : '0'} onClick={() => onChange(!value)}>
      <i />
    </button>
  );
}
export function TextField({ value, onChange, placeholder, mono, readOnly }) {
  return <input className={'set-input' + (mono ? ' mono' : '') + (readOnly ? ' set-input-readonly' : '')} value={value} placeholder={placeholder}
                readOnly={readOnly}
                onChange={readOnly ? undefined : (e => onChange(e.target.value))} />;
}
export function Select({ value, onChange, options }) {
  return (
    <select className="set-input" value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
export function Btn({ children, danger, onClick }) {
  return <button className={'btn' + (danger ? ' btn--danger' : '')} onClick={onClick}>{children}</button>;
}

// Shared dirty-state action bar for forms in the modal. Sits at the
// bottom of a tab; Save commits, Discard reverts. 'Saved' chip fades
// in for 2s after a successful save so the user knows the round-trip
// landed. Replaces the modal's old footer Save/Cancel pair which
// didn't actually do anything (debounced autosave had already
// committed before the user clicked).
export function FormBar({
  dirty,
  saving,
  savedAt,
  onSave,
  onDiscard,
}: Readonly<{
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  onSave: () => void;
  onDiscard: () => void;
}>) {
  const [showSaved, setShowSaved] = useStateS(false);
  useEffectS(() => {
    if (!savedAt) return;
    setShowSaved(true);
    const id = globalThis.setTimeout(() => setShowSaved(false), 2000);
    return () => globalThis.clearTimeout(id);
  }, [savedAt]);
  return (
    <div className="set-form-bar">
      {showSaved && <span className="set-form-bar-saved">Saved</span>}
      <Btn onClick={onDiscard}>Discard</Btn>
      <button
        className="btn btn--primary"
        onClick={onSave}
        disabled={!dirty || saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

// ───────── USER tabs ─────────
// Square crop tool that runs between file pick and upload. The user sees
// the source image with a draggable + corner-resizable square overlay,
// and on Save we render the selection into a fixed 256x256 canvas and
// return a JPEG Blob. Kept self-contained — no third-party crop libs.
export function CropModal({
  file,
  onCancel,
  onConfirm,
}: Readonly<{ file: File; onCancel: () => void; onConfirm: (blob: Blob) => void }>) {
  // Preview-space coords are pixel offsets relative to the rendered <img>;
  // we scale them back to natural-image coords when drawing the canvas so
  // the output uses full source resolution.
  const [imgUrl, setImgUrl] = useStateS<string | null>(null);
  const [imgSize, setImgSize] = useStateS<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useStateS<{ x: number; y: number; size: number } | null>(null);
  const imgRef = useRefS<HTMLImageElement | null>(null);
  const dragRef = useRefS<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; orig: { x: number; y: number; size: number } } | null>(null);

  useEffectS(() => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffectS(() => {
    const onKey = (e: KeyboardEvent) => escapeToClose(e, onCancel);
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const w = e.currentTarget.clientWidth;
    const h = e.currentTarget.clientHeight;
    const size = Math.min(w, h);
    setImgSize({ w, h });
    setCrop({ x: (w - size) / 2, y: (h - size) / 2, size });
  }

  function startDrag(e: React.MouseEvent, mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') {
    e.preventDefault();
    if (!crop) return;
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...crop } };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', stopDrag);
  }
  function onDragMove(e: MouseEvent) {
    const d = dragRef.current;
    if (!d || !crop || !imgSize) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    let next: typeof d.orig;
    if (d.mode === 'move') {
      next = { ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy };
    } else {
      // Corner resize: keep crop square by averaging dx/dy along the corner's
      // outward direction, and reposition so the opposite corner stays put.
      const right = d.mode.endsWith('e');
      const bottom = d.mode.startsWith('s');
      const horizGrowth = right ? dx : -dx;
      const vertGrowth = bottom ? dy : -dy;
      const delta = (horizGrowth + vertGrowth) / 2;
      const size = d.orig.size + delta;
      const x = right ? d.orig.x : d.orig.x + (d.orig.size - size);
      const y = bottom ? d.orig.y : d.orig.y + (d.orig.size - size);
      next = { x, y, size };
    }
    setCrop(clampCrop(next, imgSize.w, imgSize.h));
  }
  function stopDrag() {
    dragRef.current = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', stopDrag);
  }

  async function save() {
    const img = imgRef.current;
    if (!img || !crop || !imgSize) return;
    // Map preview-space crop back to natural pixels.
    const scaleX = img.naturalWidth / imgSize.w;
    const scaleY = img.naturalHeight / imgSize.h;
    const sx = crop.x * scaleX;
    const sy = crop.y * scaleY;
    const sSize = Math.min(crop.size * scaleX, img.naturalWidth - sx);
    const out = 256;
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, sSize, crop.size * scaleY, 0, 0, out, out);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9),
    );
    if (blob) onConfirm(blob);
  }

  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-overlay-dismiss"
        aria-label="Cancel"
        onClick={onCancel}
      />
      <div className="modal-card crop-card">
        <header className="modal-head">
          <h2>Crop avatar</h2>
          <button className="modal-x" onClick={onCancel}>×</button>
        </header>
        <div className="modal-body">
          <div className="crop-stage">
            {/* Frame wraps the image so crop coordinates share its space.
                The old layout put the box inside .crop-stage but
                centered the image with flex padding, so the box could
                only travel within the image-sized area — anywhere past
                the image edge clamped early on the right and bottom. */}
            <div className="crop-frame" style={imgSize ? { width: imgSize.w, height: imgSize.h } : undefined}>
              {(() => {
                // Defensive: imgUrl only ever comes from
                // URL.createObjectURL() above, but rendering it into
                // an <img src> is a sink CodeQL flags as xss-through-
                // dom. Validate via the URL constructor and the
                // `blob:` scheme; refuse anything else.
                let safeImgUrl: string | null = null;
                if (imgUrl) {
                  try {
                    const parsed = new URL(imgUrl);
                    if (parsed.protocol === 'blob:') safeImgUrl = parsed.toString();
                  } catch {
                    safeImgUrl = null;
                  }
                }
                return safeImgUrl ? (
                  // codeql[js/xss-through-dom]: URL.protocol === 'blob:'
                  // upstream is the sanitizer; the data-flow analysis
                  // doesn't model URL parsing.
                  <img ref={imgRef} src={safeImgUrl} onLoad={onImgLoad} className="crop-img" alt="" draggable={false} />
                ) : null;
              })()}
              {crop && (
                <button
                  type="button"
                  aria-label="Drag to reposition crop area"
                  className="crop-box"
                  onMouseDown={(e) => startDrag(e, 'move')}
                  style={{ left: crop.x, top: crop.y, width: crop.size, height: crop.size }}
                >
                  <button type="button" aria-label="Resize from top-left" className="crop-handle nw" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'nw'); }} />
                  <button type="button" aria-label="Resize from top-right" className="crop-handle ne" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'ne'); }} />
                  <button type="button" aria-label="Resize from bottom-left" className="crop-handle sw" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'sw'); }} />
                  <button type="button" aria-label="Resize from bottom-right" className="crop-handle se" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'se'); }} />
                </button>
              )}
            </div>
          </div>
          <p className="modal-hint">Drag to reposition, corners to resize. Output is a 256×256 square.</p>
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Save</button>
        </footer>
      </div>
    </div>
  );
}

// Avatar upload widget. Real upload pipeline: file picker → crop tool →
// api.uploadFile → api.getAttachmentUrl → api.updateMe({ avatar_url }).
// Updates the local member record so the rest of the UI flips immediately
// without waiting for a re-sync. Mock sessions keep the cropped blob as
// an object URL so /mesh demos the same flow.
export function AvatarUploader() {
  const data = useShellDataContext() as any;
  const meId = data?.currentUserId;
  const me = meId ? data?.byId?.[meId] : null;
  const auth = useActiveTeamAuth();
  const inputRef = useRefS<HTMLInputElement | null>(null);
  const [busy, setBusy] = useStateS(false);
  const [err, setErr] = useStateS<string | null>(null);
  // Source file held between pick and the user confirming a crop. While
  // this is set the CropModal is open.
  const [pendingFile, setPendingFile] = useStateS<File | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice re-fires
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setErr('Pick an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErr('Avatar must be under 5 MB.');
      return;
    }
    setErr(null);
    setPendingFile(file);
  }

  async function onCropped(blob: Blob) {
    setPendingFile(null);
    setBusy(true);
    try {
      // Repackage the blob as a File so api.uploadFile + the server's
      // multipart handler still see a proper filename + content-type.
      const cropped = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
      if (!auth || isMockSession()) {
        const url = URL.createObjectURL(cropped);
        applyAvatarUrl(url, meId);
        return;
      }
      const att = await api.uploadFile(auth.teamId, cropped);
      const url = api.getAttachmentUrl(auth.teamId, att.id);
      await api.updateMe(auth.baseUrl, auth.token, { avatar_url: url });
      applyAvatarUrl(url, meId);
    } catch (error_) {
      setErr((error_ as Error).message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setErr(null);
    setBusy(true);
    try {
      if (auth && !isMockSession()) {
        await api.updateMe(auth.baseUrl, auth.token, { avatar_url: '' });
      }
      applyAvatarUrl('', meId);
    } catch (error_) {
      setErr((error_ as Error).message || 'Clear failed.');
    } finally {
      setBusy(false);
    }
  }


  const avatarColor = me?.color || 'var(--muted)';
  const initials = me?.initials || '?';
  const hasImage = !!me?.avatarUrl;
  return (
    <div className="set-avatar-row">
      <div
        className={'set-avatar' + (hasImage ? ' has-image' : '')}
        style={hasImage
          ? { backgroundImage: `url(${me!.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'transparent' }
          : { backgroundColor: avatarColor }}
      >
        {!hasImage && initials}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={onPick}
      />
      <Btn onClick={() => inputRef.current?.click()}>{busy ? 'Uploading…' : 'Upload…'}</Btn>
      {hasImage && <Btn danger onClick={clear}>Remove</Btn>}
      {err && <span style={{ color: 'var(--danger)', fontSize: 11, marginLeft: 8 }}>{err}</span>}
      {pendingFile && (
        <CropModal
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onConfirm={onCropped}
        />
      )}
    </div>
  );
}

export function UserAccount() {
  // Read the current user from globalThis.SHELL_DATA (set up by useShellData).
  // No hardcoded mock fallback — empty when the data hasn't loaded yet.
  const data = useShellDataContext() as any;
  const meId = data?.currentUserId;
  const me = meId ? data?.byId?.[meId] : null;
  const auth = useActiveTeamAuth();
  const origName = me?.name || '';
  const origStatus = me?.custom || '';
  const [name, setName] = useStateS(origName);
  const [status, setStatus] = useStateS(origStatus);
  const [saving, setSaving] = useStateS(false);
  const [savedAt, setSavedAt] = useStateS<number | null>(null);
  useEffectS(() => {
    // Pull-in from server-side changes only when the field isn't dirty.
    setName((v) => (v === origName ? me?.name || '' : v));
    setStatus((v) => (v === origStatus ? me?.custom || '' : v));
     
  }, [me?.name, me?.custom]);
  const publicKey =
    useAuthStore((s) => s.publicKey) ||
    data?.publicKey ||
    '';

  const dirty = name !== origName || status !== origStatus;

  async function save() {
    if (!auth || saving || !dirty) return;
    setSaving(true);
    try {
      const updates: Parameters<typeof api.updateMe>[2] = {};
      if (name !== origName) updates.display_name = name;
      if (status !== origStatus) updates.status_text = status;
      await api.updateMe(auth.baseUrl, auth.token, updates);
      // Custom status also rides over the presence broadcast so it
      // surfaces immediately in the member list. Independent of the
      // PATCH so a transient WS hiccup doesn't fail the save.
      if (status !== origStatus) {
        api.updatePresence(auth.teamId, 'online', status)
          .catch((err) => console.warn('[Settings] presence update failed', err));
      }
      setSavedAt(Date.now());
    } catch (err) {
      console.warn('[Settings] account update failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'account', text: 'Save failed — try again.', duration: 3500 } }));
    } finally {
      setSaving(false);
    }
  }
  function discard() {
    setName(origName);
    setStatus(origStatus);
  }

  return (
    <>
      <Group title="Identity" hint="Your display name and status are visible to everyone on the team.">
        <Row label="Display name"><TextField value={name} onChange={setName} /></Row>
        <Row label="Custom status" hint="Visible next to your name in the member list.">
          <TextField value={status} onChange={setStatus} />
        </Row>
        <Row label="Avatar"><AvatarUploader /></Row>
        <Row label="Public key" hint="ed25519 — verified by your safety number.">
          <TextField mono readOnly value={publicKey} onChange={() => {}} />
        </Row>
      </Group>
      <FormBar dirty={dirty} saving={saving} savedAt={savedAt} onSave={save} onDiscard={discard} />
    </>
  );
}

// H-14: per-user device list + revoke. Lists every device this user
// has enrolled (multi-device auth from commit 0d55d30). Operators
// can revoke a stolen / unrecognized device from any other still-
// trusted device. Server refuses to revoke the user's LAST active
// device with a 400 — surfaced via an error toast.
export function UserDevices() {
  const auth = useActiveTeamAuth();
  const [devices, setDevices] = useStateS<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useStateS(true);
  const [err, setErr] = useStateS('');
  const [revokingId, setRevokingId] = useStateS<string | null>(null);

  const refresh = useCallbackS(async () => {
    if (!auth) { setLoading(false); return; }
    setErr('');
    setLoading(true);
    try {
      const list = await api.listDevices(auth.teamId);
      setDevices(list);
    } catch (e) {
      setErr((e as Error).message || 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, [auth?.teamId]);

  useEffectS(() => { refresh(); }, [refresh]);

  async function revoke(deviceId: string, label: string) {
    if (!auth) return;
    const ok = await dillaConfirm({
      title: 'Revoke device?',
      body: `${label || 'This device'} will be signed out and won't be able to use its current keys to talk to the server. The next login from that device will need to re-enroll.`,
      confirmLabel: 'Revoke',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    setRevokingId(deviceId);
    try {
      await api.revokeDevice(auth.teamId, deviceId);
      await refresh();
    } catch (e) {
      setErr((e as Error).message || 'Revoke failed (server may have refused the last-device guard)');
    } finally {
      setRevokingId(null);
    }
  }

  if (!auth) {
    return (
      <Group title="Devices">
        <div className="set-hint">Sign in to manage devices.</div>
      </Group>
    );
  }
  if (loading) {
    return (
      <Group title="Devices">
        <div className="set-hint">Loading…</div>
      </Group>
    );
  }
  if (err) {
    return (
      <Group title="Devices">
        <div className="set-hint" style={{ color: 'var(--danger)' }}>{err}</div>
      </Group>
    );
  }

  return (
    <Group
      title="Devices"
      hint="Each device that talks to this server uses its own Ed25519 keypair. Revoking a device immediately invalidates its sessions."
    >
      {devices.length === 0 && (
        <div className="set-hint">No devices enrolled yet.</div>
      )}
      {devices.map((d) => {
        const id = toStr(d.id ?? d.device_id);
        const label = toStr(d.device_label ?? d.label) || 'Unlabelled device';
        const revokedAt = toStr(d.revoked_at);
        const lastSeenIp = toStr(d.last_seen_ip);
        const lastSeenCountry = toStr(d.last_seen_country);
        const lastSeenAt = toStr(d.last_seen_at);
        const createdAt = toStr(d.created_at);
        const active = !revokedAt;
        return (
          <div key={id} className="set-row" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.75rem 0',
            borderBottom: '1px solid var(--hairline)',
            opacity: active ? 1 : 0.55,
          }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{label}</div>
              <div className="set-hint" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                {lastSeenAt && <>Last seen {lastSeenAt}</>}
                {lastSeenIp && <> · {lastSeenIp}</>}
                {lastSeenCountry && <> · {lastSeenCountry}</>}
                {!lastSeenAt && createdAt && <>Enrolled {createdAt}</>}
                {!active && revokedAt && <> · revoked {revokedAt}</>}
              </div>
            </div>
            {active && (
              <button
                className="btn btn--danger btn--sm"
                disabled={revokingId === id}
                onClick={() => revoke(id, label)}
              >
                {revokingId === id ? 'Revoking…' : 'Revoke'}
              </button>
            )}
          </div>
        );
      })}
    </Group>
  );
}

function computeNotifMode(desktop: boolean, sound: boolean): string {
  if (desktop) return 'all';
  if (sound) return 'mentions';
  return 'nothing';
}

export function UserNotif() {
  // Notify mode is derived from desktopNotifications + a per-channel filter
  // we don't track yet. For now: desktop on = all, desktop off + sound on =
  // mentions, both off = nothing. Editing the segment toggles the booleans
  // to match.
  const desktopNotifications = useUserSettingsStore((s) => s.desktopNotifications);
  const soundNotifications = useUserSettingsStore((s) => s.soundNotifications);
  const setDesktop = useUserSettingsStore((s) => s.setDesktopNotifications);
  const setSound = useUserSettingsStore((s) => s.setSoundNotifications);
  const mode = computeNotifMode(desktopNotifications, soundNotifications);
  const setMode = (m: string) => {
    if (m === 'all') {
      setDesktop(true);
      setSound(true);
    } else if (m === 'mentions') {
      setDesktop(false);
      setSound(true);
    } else {
      setDesktop(false);
      setSound(false);
    }
  };
  // Quiet hours are server-backed via PATCH /users/me so the window
  // follows the identity across devices. Local draft until the user
  // hits Save; useUserMeSync hydrates the original values at boot so
  // the form opens with the saved globalThis.
  const auth = useActiveTeamAuth();
  const storedQuiet = useUserSettingsStore((s) => s.quietHoursEnabled);
  const storedFrom = useUserSettingsStore((s) => s.quietHoursFrom);
  const storedTo = useUserSettingsStore((s) => s.quietHoursTo);
  const setQuietHours = useUserSettingsStore((s) => s.setQuietHours);
  const [quiet, setQuiet] = useStateS(storedQuiet);
  const [quietFrom, setQuietFrom] = useStateS(storedFrom);
  const [quietTo, setQuietTo] = useStateS(storedTo);
  const [saving, setSaving] = useStateS(false);
  const [savedAt, setSavedAt] = useStateS<number | null>(null);
  // Pull-in store changes when the field isn't dirty (e.g. another
  // device updated the quiet hours and useUserMeSync hydrated us).
  useEffectS(() => {
    setQuiet((v) => (v === storedQuiet ? storedQuiet : v));
    setQuietFrom((v) => (v === storedFrom ? storedFrom : v));
    setQuietTo((v) => (v === storedTo ? storedTo : v));
     
  }, [storedQuiet, storedFrom, storedTo]);

  const dirty = quiet !== storedQuiet || quietFrom !== storedFrom || quietTo !== storedTo;

  async function save() {
    if (!auth || saving || !dirty) return;
    setSaving(true);
    try {
      const body: Parameters<typeof api.updateMe>[2] = {};
      if (quiet !== storedQuiet) body.quiet_hours_enabled = quiet;
      if (quietFrom !== storedFrom) body.quiet_hours_from = quietFrom;
      if (quietTo !== storedTo) body.quiet_hours_to = quietTo;
      await api.updateMe(auth.baseUrl, auth.token, body);
      // Sync the store so other consumers (e.g. notification gating)
      // pick up the new window without re-fetching /me.
      setQuietHours({ enabled: quiet, from: quietFrom, to: quietTo });
      setSavedAt(Date.now());
    } catch (err) {
      console.warn('[Settings] quiet hours update failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'notif', text: 'Save failed — try again.', duration: 3500 } }));
    } finally {
      setSaving(false);
    }
  }
  function discard() {
    setQuiet(storedQuiet);
    setQuietFrom(storedFrom);
    setQuietTo(storedTo);
  }

  return (
    <>
      <Group title="Default behaviour">
        <Row label="Notify me for">
          <div className="set-seg">
            {['all', 'mentions', 'nothing'].map(m => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
        </Row>
        <Row label="Sound on new message">
          <Toggle value={soundNotifications} onChange={setSound} />
        </Row>
      </Group>
      <Group title="Quiet hours" hint="Suppress all push notifications during this globalThis. Mentions still show in-app.">
        <Row label="Enable quiet hours"><Toggle value={quiet} onChange={setQuiet} /></Row>
        <Row label="From → to">
          <div className="set-range">
            <TextField value={quietFrom} onChange={setQuietFrom} mono />
            <span>→</span>
            <TextField value={quietTo} onChange={setQuietTo} mono />
          </div>
        </Row>
      </Group>
      <FormBar dirty={dirty} saving={saving} savedAt={savedAt} onSave={save} onDiscard={discard} />
    </>
  );
}
export function UserVoice() {
  // Input/output devices persist via useUserSettingsStore (the voice
  // subsystem reads from the same store when it acquires a media stream).
  const inputDevice = useUserSettingsStore((s) => s.selectedInputDevice);
  const outputDevice = useUserSettingsStore((s) => s.selectedOutputDevice);
  const setInputDevice = useUserSettingsStore((s) => s.setSelectedInputDevice);
  const setOutputDevice = useUserSettingsStore((s) => s.setSelectedOutputDevice);
  const inputVolume = useUserSettingsStore((s) => s.inputVolume);

  // Audio processing toggles live in the dedicated audio store so the
  // voice subsystem and this UI see the same source of truth.
  const ec = useAudioSettingsStore((s) => s.echoCancellation);
  const setEc = useAudioSettingsStore((s) => s.setEchoCancellation);
  const ns = useAudioSettingsStore((s) => s.noiseSuppression);
  const setNs = useAudioSettingsStore((s) => s.setNoiseSuppression);
  const pttKey = useAudioSettingsStore((s) => s.pushToTalkKey);
  const setPttKey = useAudioSettingsStore((s) => s.setPushToTalkKey);
  // PTT capture is a "press the next key" mode. Hooking on globalThis with
  // capture=true so the keystroke isn't swallowed by any open input;
  // preventDefault keeps the captured key (Space, modifiers) from also
  // triggering whatever it would normally do.
  const [capturingPtt, setCapturingPtt] = useStateS(false);
  useEffectS(() => {
    if (!capturingPtt) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPttKey(e.code);
      setCapturingPtt(false);
    };
    globalThis.addEventListener('keydown', handler, true);
    return () => globalThis.removeEventListener('keydown', handler, true);
  }, [capturingPtt, setPttKey]);
  // Strip the KeyboardEvent.code prefix into something a user reads as a
  // key cap. "KeyV" -> "V", "ArrowLeft" -> "Arrow Left", "Space" -> "Space".
  const pttLabel = (() => {
    if (capturingPtt) return 'Press a key…';
    if (pttKey.startsWith('Key')) return pttKey.slice(3);
    if (pttKey.startsWith('Digit')) return pttKey.slice(5);
    return pttKey.replace(/([a-z])([A-Z])/g, '$1 $2');
  })();

  // Camera + mirror persist via audioSettingsStore (now a media-
  // settings store) so the choices survive reloads and any future
  // WebRTC sender code can read them off a single source of truth.
  const camera = useAudioSettingsStore((s) => s.videoDeviceId);
  const setCamera = useAudioSettingsStore((s) => s.setVideoDeviceId);
  const mirror = useAudioSettingsStore((s) => s.mirrorPreview);
  const setMirror = useAudioSettingsStore((s) => s.setMirrorPreview);
  const [videoDevs, setVideoDevs] = useStateS<Array<{ id: string; label: string }>>([
    { id: 'default', label: 'Default' },
  ]);

  // Real device enumeration. `enumerateDevices()` only returns labels
  // after the user has granted mic permission once — we request that
  // explicitly the first time the panel opens. If permission is
  // denied, fall back to a single "Default" entry so the dropdown
  // isn't empty.
  const [inputDevs, setInputDevs] = useStateS<Array<{ id: string; label: string }>>([
    { id: 'default', label: 'Default' },
  ]);
  const [outputDevs, setOutputDevs] = useStateS<Array<{ id: string; label: string }>>([
    { id: 'default', label: 'Default' },
  ]);
  const [permError, setPermError] = useStateS<string | null>(null);

  useEffectS(() => {
    let cancelled = false;
    (async () => {
      try {
        // Triggers the permission prompt; without this enumerateDevices
        // returns blank labels.
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        const devs = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const ins = devs
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ id: d.deviceId || 'default', label: d.label || 'Microphone' }));
        const outs = devs
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({ id: d.deviceId || 'default', label: d.label || 'Speakers' }));
        // Video devices come back from the same enumerateDevices call.
        // Labels still require a permission grant; we only ask for
        // audio above (video would surface an extra prompt the user
        // hasn't consented to from this panel), so the labels will be
        // empty if camera permission has never been granted — fall
        // back to a generic "Camera N" string in that case.
        const cams = devs
          .filter((d) => d.kind === 'videoinput')
          .map((d, i) => ({
            id: d.deviceId || 'default',
            label: d.label || `Camera ${i + 1}`,
          }));
        setInputDevs(ins.length ? [{ id: 'default', label: 'Default' }, ...ins] : [{ id: 'default', label: 'Default' }]);
        setOutputDevs(outs.length ? [{ id: 'default', label: 'Default' }, ...outs] : [{ id: 'default', label: 'Default' }]);
        setVideoDevs(cams.length ? [{ id: 'default', label: 'Default' }, ...cams] : [{ id: 'default', label: 'Default' }]);
        setPermError(null);
      } catch (err) {
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[Settings] device enumeration failed:', msg);
        if (!cancelled) setPermError(msg);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live input-level meter. Acquires the mic, plumbs through the same
  // gain node the voice subsystem uses, samples RMS in
  // requestAnimationFrame. The session is torn down when the user
  // clicks Stop or navigates away from the panel.
  const [testing, setTesting] = useStateS(false);
  const [level, setLevel] = useStateS(0);
  const sessionRef = useRefS<MicTestSession | null>(null);
  const [testError, setTestError] = useStateS<string | null>(null);

  useEffectS(() => () => {
    stopMicTest(sessionRef.current);
    sessionRef.current = null;
  }, []);

  // Keep gain in sync if the user moves a volume slider while testing.
  useEffectS(() => {
    if (sessionRef.current) sessionRef.current.gainNode.gain.value = inputVolume;
  }, [inputVolume]);

  const startTest = async () => {
    setTestError(null);
    try {
      const constraints = useAudioSettingsStore.getState().getAudioConstraints(inputDevice);
      console.log('[MicTest] starting with constraints', constraints, 'deviceId=', inputDevice);
      const session = await startMicTest({
        audioConstraints: constraints,
        inputVolume,
        onLevelUpdate: setLevel,
      });
      sessionRef.current = session;
      setTesting(true);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error('[MicTest] start failed:', msg);
      setTestError(msg);
    }
  };

  const stopTest = () => {
    stopMicTest(sessionRef.current);
    sessionRef.current = null;
    setLevel(0);
    setTesting(false);
  };

  // Map the 0..1 RMS level to the 22-cell meter. Cells light up
  // proportionally; the last few stay dimmed unless the signal
  // genuinely clips.
  const litCells = Math.round(level * 22);

  return (
    <>
      <Group title="Devices">
        <Row label="Input">
          <Select
            value={inputDevs.find((d) => d.id === inputDevice)?.label ?? inputDevice}
            onChange={(label) => {
              const dev = inputDevs.find((d) => d.label === label);
              setInputDevice(dev?.id ?? 'default');
            }}
            options={inputDevs.map((d) => d.label)}
          />
        </Row>
        <Row label="Output">
          <Select
            value={outputDevs.find((d) => d.id === outputDevice)?.label ?? outputDevice}
            onChange={(label) => {
              const dev = outputDevs.find((d) => d.label === label);
              setOutputDevice(dev?.id ?? 'default');
            }}
            options={outputDevs.map((d) => d.label)}
          />
        </Row>
        <Row label="Input level" hint={(() => {
          if (testError) return `Mic error: ${testError}`;
          if (permError) return `Permission: ${permError}`;
          return 'Speak normally to verify levels.';
        })()}>
          <div className="set-meter-row">
            <div className="set-meter">
              {Array.from({ length: 22 }).map((_, i) => {
                let bg: string;
                if (i < 11) bg = 'var(--accent)';
                else if (i < 17) bg = 'var(--warn)';
                else bg = 'var(--danger)';
                return (
                  <span
                    key={`cell-${i}-${bg}`}
                    style={{
                      background: bg,
                      opacity: i < litCells ? 1 : 0.18,
                    }}
                  />
                );
              })}
            </div>
            <Btn onClick={testing ? stopTest : startTest}>
              {testing ? 'Stop test' : 'Test mic'}
            </Btn>
          </div>
        </Row>
      </Group>
      <Group title="Processing">
        <Row label="Echo cancellation"><Toggle value={ec} onChange={setEc} /></Row>
        <Row label="Noise suppression"><Toggle value={ns} onChange={setNs} /></Row>
        <Row label="Push to talk" hint="Hold a key to transmit; release to mute.">
          <div className="set-kbd-row">
            <button
              className={'set-input mono set-kbd-capture' + (capturingPtt ? ' capturing' : '')}
              onClick={() => setCapturingPtt((v) => !v)}
              aria-label="Click to bind a push-to-talk key"
            >
              {pttLabel}
            </button>
            <Btn onClick={() => setCapturingPtt(true)}>{capturingPtt ? 'Listening…' : 'Bind'}</Btn>
          </div>
        </Row>
      </Group>
      <Group title="Video">
        <Row label="Camera">
          {/* The dropdown stores the deviceId but shows the friendly
              label — using the device's own id as the value keeps the
              wire shape stable for getUserMedia({ video: { deviceId } }). */}
          <select
            className="set-input"
            value={camera}
            onChange={(e) => setCamera(e.target.value)}
          >
            {videoDevs.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </Row>
        <Row label="Mirror preview"><Toggle value={mirror} onChange={setMirror} /></Row>
      </Group>
    </>
  );
}
export function UserAppear() {
  // Theme persisted to useUserSettingsStore (themeStore reads from it and
  // updates --theme tokens). 'mesh' is the default per the v2 migration in
  // userSettingsStore.ts. Density also lives there.
  const theme = useUserSettingsStore((s) => s.theme);
  const setTheme = useUserSettingsStore((s) => s.setTheme);
  const density = useUserSettingsStore((s) => s.density);
  const setDensity = useUserSettingsStore((s) => s.setDensity);

  const motion = useUserSettingsStore((s) => s.reduceMotion);
  const setMotion = useUserSettingsStore((s) => s.setReduceMotion);
  const size = useUserSettingsStore((s) => s.baseFontPx);
  const setSize = useUserSettingsStore((s) => s.setBaseFontPx);

  return (
    <>
      <Group title="Theme">
        <Row label="Direction" hint="Pick a visual direction. Persists across sessions.">
          <div className="set-seg">
            {(['pulse','aurora','slate','mesh'] as const).map(m => (
              <button key={m} className={theme === m ? 'on' : ''} onClick={() => setTheme(m)}>{m}</button>
            ))}
          </div>
        </Row>
        <Row label="Density" hint="How tightly content packs.">
          <div className="set-seg">
            {(['compact','regular','cozy'] as const).map(m => (
              <button key={m} className={density === m ? 'on' : ''} onClick={() => setDensity(m)}>{m}</button>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Type & spacing">
        <Row label="Base font size" hint="Scales the whole UI proportionally — affects every rem-sized element.">
          <div className="set-stepper">
            <button onClick={() => setSize(size - 1)} disabled={size <= 11}>−</button>
            <span>{size}px</span>
            <button onClick={() => setSize(size + 1)} disabled={size >= 20}>+</button>
          </div>
        </Row>
        <Row label="Reduce motion" hint="Disable speaking pulses, typing-dot animations, and decorative transitions.">
          <Toggle value={motion} onChange={setMotion} />
        </Row>
      </Group>
    </>
  );
}

export function SafetyNumberQR({
  payload,
  label,
  onClose,
}: Readonly<{
  payload: string;
  label: string;
  onClose: () => void;
}>) {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    import('qrcode')
      .then((mod) => {
        if (cancelled || !ref.current) return;
        // qrcode wants #rrggbb(aa). getComputedStyle().color returns
        // "rgb(r, g, b)" or "rgba(r, g, b, a)", so parse and rebuild.
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        probe.style.color = 'var(--fg)';
        const fg = cssColorToHex(getComputedStyle(probe).color, '#e8ece8');
        probe.style.color = 'var(--surface-1)';
        const bg = cssColorToHex(getComputedStyle(probe).color, '#0d100e');
        probe.remove();
        mod.default.toCanvas(ref.current, payload, {
          width: 256,
          errorCorrectionLevel: 'M',
          color: { dark: fg, light: bg },
          margin: 1,
        });
      })
      .catch((err) => {
        console.warn('[SafetyNumberQR] failed to render', err);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);
  return (
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-overlay-dismiss"
        aria-label="Close"
        onClick={onClose}
      />
      <dialog open className="modal-card">
        <header className="modal-head">
          <h3>{label} — safety number</h3>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
          <canvas ref={ref} aria-label="Safety number QR code" />
          <p className="modal-hint" style={{ textAlign: 'center', maxWidth: '20rem' }}>
            Have your contact scan this QR (or compare digits) on a separate channel before
            trusting messages from this device.
          </p>
        </div>
      </dialog>
    </div>
  );
}

export function UserPrivacy() {
  const data = useShellDataContext() as any;
  const verified = useVerifiedContacts();
  const meId = data?.currentUserId; const me = meId ? data?.byId?.[meId] : null;
  const meName = me?.name || 'me';
  const [qrOpen, setQrOpen] = React.useState(false);
  // Safety number is derived from the user's real Ed25519 public key.
  // Members in byId carry `publicKeyHex` (64 hex chars = 32 bytes). We
  // split it into 12 4-hex groups laid out as two 3-row columns to mirror
  // the Signal visual style. Empty → em-dash placeholder so it's obvious
  // the key isn't loaded yet rather than displaying zero-padded fakery.
  const pkHex = (me?.publicKeyHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const pkReady = pkHex.length >= 48;
  function fp(start: number) {
    return [0, 1, 2].map((i) => {
      const chunk = pkHex.slice(start + i * 8, start + i * 8 + 8);
      if (chunk.length < 8) return '';
      return chunk.replace(/(.{4})(.{4})/, '$1 $2');
    });
  }
  const block1 = pkReady ? fp(0) : ['— — — —', '— — — —', '— — — —'];
  const block2 = pkReady ? fp(24) : ['— — — —', '— — — —', '— — — —'];
  // Verify contacts: iterate over real team members (excluding current user).
  const others = (data?.MEMBERS ?? []).filter((m: any) => m.id !== meId);
  return (
    <>
      <Group title="Your safety number" hint="Have a friend compare this number out-of-band before trusting your messages.">
        <div className="set-fingerprint">
          <div className="set-fp-block">
            {block1.map((row, i) => <div key={`b1-${i}-${row}`}>{row}</div>)}
          </div>
          <div className="set-fp-block">
            {block2.map((row, i) => <div key={`b2-${i}-${row}`}>{row}</div>)}
          </div>
          <div className="set-fp-actions">
            <Btn onClick={() => {
              const full = [...block1, ...block2].join(' ');
              navigator.clipboard?.writeText(full);
              globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Safety number copied.', duration: 2000 } }));
            }}>Copy</Btn>
            <Btn disabled={!pkReady} onClick={() => setQrOpen(true)}>Show QR</Btn>
          </div>
        </div>
      </Group>
      {qrOpen && pkReady && (
        <SafetyNumberQR
          payload={pkHex}
          label={meName}
          onClose={() => setQrOpen(false)}
        />
      )}
      <Group title="Encryption">
        <Row label="Double Ratchet sessions" hint="Currently active per-contact key chains.">
          <span className="set-stat">{others.length} session{others.length === 1 ? '' : 's'}</span>
        </Row>
        <Row label="Rotate session keys" hint="Forces new sender keys for every text channel you participate in. Old messages stay readable on devices that already have them.">
          <Btn onClick={async () => {
            const ok = await dillaConfirm({
              title: 'Rotate sender keys?',
              body: 'Generates a new sender key per channel and re-distributes it to every member. Use this after a suspected device compromise. Existing messages stay readable on devices that already received them.',
              confirmLabel: 'Rotate now',
              cancelLabel: 'Cancel',
            });
            if (!ok) return;
            try {
              const teamId = useTeamStore.getState().activeTeamId;
              if (!teamId) throw new Error('no active team');
              const derivedKey = useAuthStore.getState().derivedKey;
              if (!derivedKey) throw new Error('identity is locked');
              const channels = (useTeamStore.getState().channels.get(teamId) ?? [])
                .filter((c) => c.type === 'text');
              let rotated = 0;
              for (const ch of channels) {
                // Empty removedUserId = "no exclusion" — we just want a
                // fresh sender key broadcast to the current member set.
                // rotateChannelKey returns null when this client has no
                // session for the channel yet (e.g., a channel they've
                // never sent to); we skip those quietly.
                const dist = await cryptoService.rotateChannelKey(ch.id, '', derivedKey);
                if (!dist) continue;
                ws.distributeChannelKey(teamId, ch.id, dist);
                rotated += 1;
              }
              globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: {
                author: 'crypto',
                text: describeRotationResult(rotated),
                duration: 3500,
              } }));
            } catch (err) {
              console.warn('[Settings] bulk rotate failed', err);
              globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: {
                author: 'crypto',
                text: 'Rotate failed: ' + (err as Error).message,
                duration: 4500,
              } }));
            }
          }}>Rotate now</Btn>
        </Row>
        <Row label="Export identity backup" hint="Encrypted with your passphrase. Keep it offline.">
          <Btn onClick={async () => {
            try {
              const blob = await exportIdentityBlob();
              if (!blob) {
                globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'No identity to export.', duration: 3000 } }));
                return;
              }
              // Base64 string → trigger a file download.
              const a = document.createElement('a');
              a.href = 'data:application/octet-stream;base64,' + blob;
              a.download = `dilla-identity-${meName}.bin`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Identity backup downloaded.', duration: 3000 } }));
            } catch (err) {
              console.warn('[Settings] export identity failed', err);
              globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Export failed: ' + (err as Error).message, duration: 4000 } }));
            }
          }}>Export…</Btn>
        </Row>
      </Group>
      <Group title="Verify contacts" hint="Compare safety numbers with someone to confirm they are who they say they are — not the server impersonating them.">
        {others.length === 0 ? (
          <div className="set-empty">No contacts to verify yet.</div>
        ) : others.map((m: any) => {
          const peerHex = (m?.publicKeyHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
          const vstatus = peerHex ? verified.isVerified(m.id, peerHex) : 'unverified';
          return (
            <Row key={m.id} label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span
                  className={'set-avatar' + (m.avatarUrl ? ' has-image' : '')}
                  style={m.avatarUrl
                    ? { backgroundImage: `url(${m.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', width: 22, height: 22, fontSize: 10, color: 'transparent' }
                    : { backgroundColor: m.color, width: 22, height: 22, fontSize: 10 }}
                >{!m.avatarUrl && m.initials}</span>
                {m.name}
                {vstatus === 'verified' && (
                  <span className="set-verify-pill set-verify-ok" title="Safety number verified on this device">✓ verified</span>
                )}
                {vstatus === 'changed' && (
                  <span className="set-verify-pill set-verify-warn" title="Identity key changed since verification">⚠ key changed</span>
                )}
              </span>
            }>
              <Btn onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: m.id }))}>
                {vstatus === 'verified' ? 'Re-verify' : 'Verify'}
              </Btn>
            </Row>
          );
        })}
      </Group>
      <Group title="Passkeys" hint="Per-device WebAuthn credentials that unlock your identity blob. Add more devices or revoke ones you no longer use.">
        <PasskeyManager />
      </Group>
      <BlockListGroup />
    </>
  );
}

// Block list panel. sync:init seeds useBlockStore; this component shows
// the current list with an Unblock action per row. Adding to the list
// is done from the member context menu (Block @user) — surfacing a
// user picker here would duplicate that flow and asks the user to
// type a name they already see in a list elsewhere.
export function BlockListGroup() {
  const data = useShellDataContext() as any;
  const blocked = useBlockStore((s) => s.blocked);
  const setAll = useBlockStore((s) => s.setAll);
  const removeBlock = useBlockStore((s) => s.unblock);
  const teamId = useTeamStore((s) => s.activeTeamId);
  const [filter, setFilter] = useStateS('');
  const [busy, setBusy] = useStateS<string | null>(null);
  const [err, setErr] = useStateS<string | null>(null);

  // Hydrate once on mount in case sync:init landed before this panel
  // was rendered (the store is global, but on fresh open we double-check).
  useEffectS(() => {
    if (!teamId) return;
    let cancelled = false;
    api
      .listBlocks(teamId)
      .then((ids) => { if (!cancelled) setAll(ids); })
      .catch(() => { /* silent — store already has whatever sync:init delivered */ });
    return () => { cancelled = true; };
  }, [teamId, setAll]);

  async function unblock(userId: string) {
    if (!teamId) return;
    setBusy(userId);
    setErr(null);
    try {
      if (!isMockSession()) await api.unblockUser(teamId, userId);
      removeBlock(userId);
    } catch (e) {
      setErr((e as Error).message || 'Unblock failed.');
    } finally {
      setBusy(null);
    }
  }

  const ids = [...blocked];
  const rows = ids
    .map((id) => ({ id, member: data?.byId?.[id] as { name?: string; initials?: string; color?: string; avatarUrl?: string } | undefined }))
    .filter(({ id, member }) => {
      if (!filter) return true;
      const q = filter.toLowerCase();
      return (member?.name?.toLowerCase().includes(q) ?? false) || id.toLowerCase().includes(q);
    });

  return (
    <Group title="Block list" hint="Blocked users can't see that you blocked them. You won't see their messages or DMs.">
      <Row label="Filter">
        <TextField value={filter} onChange={setFilter} placeholder="search by name or id…" />
      </Row>
      {rows.length === 0 ? (
        <div className="set-empty">
          {ids.length === 0 ? 'no blocked users' : 'no matches'}
        </div>
      ) : (
        rows.map(({ id, member }) => (
          <Row key={id} label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span
                className={'set-avatar' + (member?.avatarUrl ? ' has-image' : '')}
                style={member?.avatarUrl
                  ? { backgroundImage: `url(${member.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', width: 22, height: 22, fontSize: 10, color: 'transparent' }
                  : { backgroundColor: member?.color || 'var(--muted)', width: 22, height: 22, fontSize: 10 }}
              >{!member?.avatarUrl && (member?.initials ?? '?')}</span>
              {member?.name || id.slice(0, 8) + '…'}
            </span>
          }>
            <Btn onClick={() => unblock(id)}>{busy === id ? 'Unblocking…' : 'Unblock'}</Btn>
          </Row>
        ))
      )}
      {err && <div className="set-empty" style={{ color: 'var(--danger)' }}>{err}</div>}
    </Group>
  );
}
export function UserKeys() {
  const rows = [
    ['Open command palette', '⌘ K'],
    ['Open search',           '/'],
    ['Toggle mute',           'M'],
    ['Toggle deafen',         'D'],
    ['Disconnect voice',      '⌘ ⇧ D'],
    ['Quick switch channel',  '⌘ + ↑/↓'],
    ['Mark all read',         '⇧ Esc'],
    ['Reply in thread',       'R'],
    ['React to last message', '+'],
  ];
  return (
    <Group title="Shortcuts" hint="Vim-ish navigation. Hover any action elsewhere in the UI to see its keybind.">
      <table className="set-kbd-table">
        <tbody>
          {rows.map(([action, key]) => (
            <tr key={action}>
              <td>{action}</td>
              <td><kbd>{key}</kbd></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Group>
  );
}

// ───────── TEAM tabs ─────────
export function TeamInfo() {
  const data = useShellDataContext() as any;
  const team = data?.SERVERS?.[0];
  const channels = data?.CHANNELS ?? [];
  const channelNames = channels
    .filter((c: any) => c.type === 'text')
    .map((c: any) => `#${c.name}`);
  const meId = data?.currentUserId; const me = meId ? data?.byId?.[meId] : null;
  const created = data?.teamCreatedAt
    ? `${data.teamCreatedAt} · by ${me?.name ?? 'admin'}`
    : `today · by ${me?.name ?? 'admin'}`;
  const auth = useActiveTeamAuth();
  // Local drafts. Save commits in one PATCH; Discard reverts to the
  // bridged team value. Previously fields PATCH'd on each keystroke,
  // which made the modal footer's 'Save changes' button purely
  // decorative and meant Cancel didn't actually cancel.
  const origName = team?.name ?? '';
  const origDescription = team?.description ?? '';
  const origDefaultChannel = channelNames[0] ?? '#general'; // best-effort — server doesn't surface this yet
  const origSlowMode = '0';
  const [name, setName] = useStateS(origName);
  const [description, setDescription] = useStateS(origDescription);
  const [defaultChannel, setDefaultChannel] = useStateS(origDefaultChannel);
  const [slowMode, setSlowMode] = useStateS(origSlowMode);
  const [saving, setSaving] = useStateS(false);
  const [savedAt, setSavedAt] = useStateS<number | null>(null);
  // Re-sync local state when the bridged team value changes (e.g. another
  // admin renames the team). Only patch if the field isn't dirty so we
  // don't yank a half-typed name out from under the user.
  useEffectS(() => {
    setName((v) => (v === origName || v === '' ? team?.name ?? '' : v));
    setDescription((v) => (v === origDescription || v === '' ? team?.description ?? '' : v));
  }, [team?.name, team?.description]);

  const dirty =
    name !== origName ||
    description !== origDescription ||
    defaultChannel !== origDefaultChannel ||
    slowMode !== origSlowMode;

  async function save() {
    if (!auth || saving || !dirty) return;
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (name !== origName) updates.name = name;
      if (description !== origDescription) updates.description = description;
      if (defaultChannel !== origDefaultChannel) {
        const ch = (data?.CHANNELS ?? []).find((c: any) => `#${c.name}` === defaultChannel);
        if (ch) updates.default_channel_id = ch.id;
      }
      if (slowMode !== origSlowMode) {
        const n = Number.parseInt(slowMode, 10);
        if (!Number.isNaN(n) && n >= 0) updates.slow_mode_seconds = n;
      }
      await api.updateTeam(auth.teamId, updates);
      setSavedAt(Date.now());
    } catch (err) {
      console.warn('[Settings] team update failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'team', text: 'Save failed — admin permission required.', duration: 3500 } }));
    } finally {
      setSaving(false);
    }
  }
  function discard() {
    setName(origName);
    setDescription(origDescription);
    setDefaultChannel(origDefaultChannel);
    setSlowMode(origSlowMode);
  }

  return (
    <>
      <Group title="Team">
        <Row label="Name"><TextField value={name} onChange={setName} /></Row>
        <Row label="Description"><TextField value={description} onChange={setDescription} /></Row>
        <Row label="Created"><span className="set-stat">{created}</span></Row>
        <Row label="Storage"><span className="set-stat">0 GB / 10 GB</span></Row>
      </Group>
      <Group title="Defaults">
        <Row label="Default channel">
          <Select
            value={defaultChannel}
            options={channelNames.length ? channelNames : ['#general']}
            onChange={setDefaultChannel}
          />
        </Row>
        <Row label="Slow mode (seconds)">
          <TextField
            mono
            value={slowMode}
            onChange={(v) => setSlowMode(v.replace(/\D/g, ''))}
          />
        </Row>
      </Group>
      <FormBar dirty={dirty} saving={saving} savedAt={savedAt} onSave={save} onDiscard={discard} />
    </>
  );
}
export function TeamInvites() {
  const data = useShellDataContext() as any;
  const meId = data?.currentUserId;
  const me = meId ? data?.byId?.[meId] : null;
  const myLabel = me ? `${me.name} · ${me.role || 'admin'}` : 'admin';
  const auth = useActiveTeamAuth();
  const [rows, setRows] = useStateS<any[]>([]);
  const [maxUsesOpt, setMaxUsesOpt] = useStateS<string>('inf');
  const [expiresOpt, setExpiresOpt] = useStateS<string>('never');
  // 1 s tick — re-renders the table so the live "expires" countdown
  // updates without an explicit setTimeout per row.
  const [, setNowTick] = useStateS(0);
  useEffectS(() => {
    const id = globalThis.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => globalThis.clearInterval(id);
  }, []);


  // Resolve a user_id to a human-friendly label using whatever the shell
  // bridge already loaded — falls back to a short id when the lookup
  // misses (e.g. revoked invites whose creator left the team).
  function userLabel(userId?: string): string {
    if (!userId) return myLabel;
    const m = data?.byId?.[userId];
    if (m?.name) return m.name;
    return userId.slice(0, 8) + '…';
  }

  // Hydrate from /api/v1/teams/:id/invites on mount. On /mesh the auth is
  // null — render empty list, let the user create local-only entries the
  // same as before.
  useEffectS(() => {
    if (!auth) return;
    const baseUrl = auth.baseUrl.replace(/\/$/, '');
    api
      .listInvites(auth.teamId)
      .then((list: any[]) => {
        setRows(
          list.map((inv: any) => {
            const token = inv.code || inv.token || inv.id;
            return {
              id: inv.id,
              code: `${baseUrl}/join/${token}`,
              uses: `${inv.uses ?? 0} / ${inv.max_uses ?? '∞'}`,
              // Keep the raw numbers + cap on the row so the render layer
              // can decide whether Revoke is meaningful (an invite that's
              // already hit max_uses or passed expires_at can't admit
              // anyone, so revoking is a no-op).
              usesUsed: inv.uses ?? 0,
              usesMax: inv.max_uses ?? null,
              expiresAt: inv.expires_at ? new Date(inv.expires_at + 'Z') : null,
              who: userLabel(inv.created_by),
            };
          }),
        );
      })
      .catch((err) => console.warn('[Settings] listInvites failed', err));
    // userLabel depends on data.byId; rebuilding the table when membership
    // loads matters for resolving newly-mapped creators on first paint.
     
  }, [auth?.teamId, data?.byId]);

  async function revoke(row: any) {
    if (
      !confirm(
        'Revoke invite ' +
          row.code +
          '? People who already have it can no longer use it.',
      )
    ) {
      return;
    }
    setRows((prev) => prev.filter((r) => r.code !== row.code));
    if (auth && row.id) {
      try {
        await api.revokeInvite(auth.teamId, row.id);
      } catch (err) {
        console.warn('[Settings] revokeInvite failed', err);
      }
    }
    globalThis.dispatchEvent(
      new CustomEvent('dilla:notify', {
        detail: { channel: 'system', author: 'team', text: 'Invite revoked.', duration: 3500 },
      }),
    );
  }

  async function create() {
    if (!auth) {
      // Mock fallback: keep the prior demo behavior so /mesh has something
      // to show.
      const code = 'dilla/invite/' + randomTail(4).toUpperCase();
      setRows((prev) => [...prev, { code, uses: '0 / ∞', expires: '—', who: myLabel }]);
      navigator.clipboard?.writeText(code);
      globalThis.dispatchEvent(
        new CustomEvent('dilla:notify', {
          detail: {
            channel: 'system',
            author: 'team',
            text: 'Invite link generated and copied to clipboard.',
            duration: 3500,
          },
        }),
      );
      return;
    }
    try {
      const maxUses = maxUsesOpt === 'inf' ? undefined : Number(maxUsesOpt);
      const expiresInHours = expiresOpt === 'never' ? undefined : Number(expiresOpt);
      const inv = (await api.createInvite(auth.teamId, maxUses, expiresInHours)) as any;
      const id = inv.id;
      const code = inv.code || inv.token || id;
      const url = `${auth.baseUrl.replace(/\/$/, '')}/join/${code}`;
      setRows((prev) => [
        ...prev,
        {
          id,
          code: url,
          uses: `0 / ${inv.max_uses ?? '∞'}`,
          usesUsed: 0,
          usesMax: inv.max_uses ?? null,
          expiresAt: inv.expires_at ? new Date(inv.expires_at + 'Z') : null,
          who: userLabel(inv.created_by ?? meId),
        },
      ]);
      navigator.clipboard?.writeText(url);
      globalThis.dispatchEvent(
        new CustomEvent('dilla:notify', {
          detail: {
            channel: 'system',
            author: 'team',
            text: 'Invite link generated and copied to clipboard.',
            duration: 3500,
          },
        }),
      );
    } catch (err) {
      console.warn('[Settings] createInvite failed', err);
      globalThis.dispatchEvent(
        new CustomEvent('dilla:notify', {
          detail: {
            channel: 'system',
            author: 'team',
            text: 'Invite creation failed — admin permission required.',
            duration: 4000,
          },
        }),
      );
    }
  }
  return (
    <Group title="Active invites" hint="Anyone with a working link can join this team. Revoke unused links.">
      <div className="set-table">
        <div className="set-th">
          <span>Link</span><span>Uses</span><span>Expires</span><span>Created by</span><span>Actions</span>
        </div>
        {rows.map(r => {
          // Revoke only does anything if the invite could still admit
          // someone. Past expiry or maxed-out uses → it's already
          // invalid; revoking is a no-op tidying action that masquerades
          // as a security gesture. Disable the button + tag the row so
          // the user reads it as "done" rather than "actionable".
          const expired = r.expiresAt instanceof Date && r.expiresAt.getTime() <= Date.now();
          const used = r.usesMax != null && r.usesUsed >= r.usesMax;
          const dead = expired || used;
          let deadReason: string;
          if (expired) deadReason = 'expired';
          else if (used) deadReason = 'all uses spent';
          else deadReason = '';
          return (
            <div key={r.code} className={'set-tr' + (r.stale ? ' stale' : '') + (dead ? ' set-tr-dead' : '')}>
              <span className="set-link-cell" title={r.code}>
                <code className="set-link-code">{r.code}</code>
                <Btn onClick={() => {
                  navigator.clipboard?.writeText(r.code);
                  globalThis.dispatchEvent(new CustomEvent('dilla:notify', {
                    detail: { channel: 'system', author: 'team', text: 'Invite link copied.', duration: 2000 },
                  }));
                }}>Copy</Btn>
              </span>
              <span>{r.uses}</span>
              <span>{formatExpiry(r.expiresAt)}</span>
              <span>{r.who}</span>
              {dead ? (
                <span
                  className="set-invite-dead"
                  title={'Already ' + deadReason + ' — no admin action needed'}
                >
                  {deadReason}
                </span>
              ) : (
                <Btn danger onClick={() => revoke(r)}>Revoke</Btn>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Btn onClick={create}>+ New invite link</Btn>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
          <span>uses</span>
          <select className="set-input" value={maxUsesOpt} onChange={(e) => setMaxUsesOpt(e.target.value)} style={{ width: 80 }}>
            <option value="inf">∞</option>
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="25">25</option>
            <option value="100">100</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
          <span>expires</span>
          <select className="set-input" value={expiresOpt} onChange={(e) => setExpiresOpt(e.target.value)} style={{ width: 90 }}>
            <option value="never">Never</option>
            <option value="1">1 hour</option>
            <option value="24">1 day</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </label>
      </div>
    </Group>
  );
}
export const PERM_FLAGS = [
  { bit: 1,        key: 'admin',            label: 'Admin (all permissions)' },
  { bit: 1 << 1,   key: 'manage_channels',  label: 'Manage channels' },
  { bit: 1 << 2,   key: 'manage_members',   label: 'Manage members (kick / ban)' },
  { bit: 1 << 3,   key: 'manage_roles',     label: 'Manage roles' },
  { bit: 1 << 4,   key: 'send_messages',    label: 'Send messages' },
  { bit: 1 << 5,   key: 'manage_messages',  label: 'Manage messages (delete / pin)' },
  { bit: 1 << 6,   key: 'create_invites',   label: 'Create invites' },
  { bit: 1 << 7,   key: 'manage_team',      label: 'Manage team settings' },
  { bit: 1 << 8,   key: 'bypass_slow_mode', label: 'Bypass slow mode' },
] as const;

export function permsSummary(permissions: number): string {
  if ((permissions & 1) !== 0) return 'all permissions';
  const labels = PERM_FLAGS.filter((f) => f.bit !== 1 && (permissions & f.bit) !== 0)
    .map((f) => f.label.toLowerCase().split(' (')[0]);
  return labels.length ? labels.join(' · ') : 'no permissions';
}

export function TeamRoles() {
  const auth = useActiveTeamAuth();
  const teamId = auth?.teamId;
  const storeRoles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const setRoles = useTeamStore((s) => s.setRoles);
  const [editing, setEditing] = useStateS<{ id: string } | null>(null);
  const [saving, setSaving] = useStateS(false);
  const [dragId, setDragId] = useStateS<string | null>(null);

  // Custom (non-default) roles are draggable; sorted high → low. The
  // default role (`everyone`) is pinned at the bottom as its own block.
  const customRoles = [...storeRoles]
    .filter((r) => !r.isDefault)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  const defaultRole = storeRoles.find((r) => r.isDefault);

  const countForRole = (roleId: string) =>
    members.filter((m) => (m.roles ?? []).some((r) => r.id === roleId)).length;

  async function refresh() {
    if (!teamId) return;
    try {
      const fresh = (await api.getRoles(teamId)) as any[];
      // Normalize snake_case → camelCase so isDefault works after refresh.
      const normalized = fresh.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color ?? '',
        position: r.position ?? 0,
        permissions: r.permissions ?? 0,
        isDefault: Boolean(r.isDefault ?? r.is_default),
      }));
      setRoles(teamId, normalized as any);
    } catch (err) {
      console.warn('[Settings] getRoles failed', err);
    }
  }

  async function createRole() {
    if (!teamId || saving) return;
    setSaving(true);
    try {
      const created = (await api.createRole(teamId, {
        name: 'New role',
        color: '#7a9aa7',
        permissions: 1 << 4, // send_messages
      })) as { id?: string };
      await refresh();
      if (created?.id) setEditing({ id: created.id });
    } catch (err) {
      console.warn('[Settings] createRole failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Create failed — manage-roles permission required.', duration: 3500 } }));
    } finally {
      setSaving(false);
    }
  }

  async function persistOrder(orderedHighFirst: any[]) {
    if (!teamId) return;
    // Server assigns position = index, so pass the array LOW → HIGH.
    // Our local list is high → low, plus the default role pinned at the
    // very bottom (position 0) regardless.
    const lowFirst: string[] = orderedHighFirst.slice().reverse().map((r) => r.id);
    if (defaultRole) lowFirst.unshift(defaultRole.id);
    try {
      await api.reorderRoles(teamId, lowFirst);
      await refresh();
    } catch (err) {
      console.warn('[Settings] reorderRoles failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Reorder failed — manage-roles permission required.', duration: 3500 } }));
      await refresh();
    }
  }

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const src = customRoles.findIndex((r) => r.id === dragId);
    const dst = customRoles.findIndex((r) => r.id === targetId);
    if (src < 0 || dst < 0) { setDragId(null); return; }
    const next = customRoles.slice();
    const [moved] = next.splice(src, 1);
    next.splice(dst, 0, moved);
    setDragId(null);
    persistOrder(next);
  }

  async function deleteRole(roleId: string) {
    if (!teamId) return;
    if (!(await dillaConfirm({
      title: 'Delete role?',
      body: 'Members keep their other roles. This can\'t be undone.',
      confirmLabel: 'Delete role',
      danger: true,
    }))) return;
    try {
      await api.deleteRole(teamId, roleId);
      await refresh();
    } catch (err) {
      console.warn('[Settings] deleteRole failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Delete failed — admin role required.', duration: 3500 } }));
    }
  }

  if (!auth) {
    return (
      <Group title="Roles" hint="Sign in to a real team to manage roles.">
        <div className="set-empty">Roles editor is disabled in mock sessions.</div>
      </Group>
    );
  }

  return (
    <>
      <Group title="Roles" hint="Drag rows to reorder. Higher rows win permission conflicts and become the group label on the member list.">
        <div className="set-table">
          {customRoles.length === 0 && !defaultRole && (
            <div className="set-empty">No roles defined yet.</div>
          )}
          {customRoles.map((r) => {
            const count = countForRole(r.id);
            const isDragging = dragId === r.id;
            return (
              <article
                key={r.id}
                className={'set-tr role' + (isDragging ? ' dragging' : '')}
                draggable
                onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={() => handleDrop(r.id)}
                onDragEnd={() => setDragId(null)}
                style={{ opacity: isDragging ? 0.5 : 1, cursor: 'grab' }}
              >
                <span className="set-role-dot" style={{ background: r.color || 'var(--fg-2)' }} />
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span>{count} member{count === 1 ? '' : 's'}</span>
                <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{permsSummary(r.permissions)}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Btn onClick={() => setEditing({ id: r.id })}>Edit</Btn>
                  <Btn danger onClick={() => deleteRole(r.id)}>Delete</Btn>
                </div>
              </article>
            );
          })}
        </div>

        {defaultRole && (
          <>
            <div style={{ color: 'var(--fg-3)', fontSize: 11, margin: '14px 0 6px' }}>DEFAULT — applies to every member</div>
            <div className="set-table">
              <div className="set-tr role" style={{ opacity: 0.85 }}>
                <span className="set-role-dot" style={{ background: defaultRole.color || 'var(--fg-2)' }} />
                <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {defaultRole.name}
                  <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', border: '1px solid var(--hairline)', padding: '1px 5px', borderRadius: 3 }}>default</span>
                </span>
                <span>{members.length} member{members.length === 1 ? '' : 's'}</span>
                <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{permsSummary(defaultRole.permissions)}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Btn onClick={() => setEditing({ id: defaultRole.id })}>Edit</Btn>
                </div>
              </div>
            </div>
          </>
        )}

        <div style={{ marginTop: 12 }}>
          <Btn onClick={createRole}>+ New role</Btn>
        </div>
      </Group>
      {editing && (
        <RoleEditor
          teamId={teamId!}
          role={storeRoles.find((r) => r.id === editing.id)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

export function RoleEditor({ teamId, role, onClose, onSaved }: Readonly<{ teamId: string; role: any; onClose: () => void; onSaved: () => void }>) {
  const [name, setName] = useStateS(role?.name ?? '');
  const [color, setColor] = useStateS(role?.color ?? '#7a9aa7');
  const [perms, setPerms] = useStateS<number>(role?.permissions ?? 0);
  const [saving, setSaving] = useStateS(false);
  // Privilege-escalation guard, UI side. Bits the current user doesn't
  // hold themselves are checked-but-disabled if already set on the role
  // (don't silently drop them on save) and hidden otherwise. The server
  // also rejects with 403 if a moderator tries to grant a bit past
  // their ceiling — this is the discoverability half of the same gate.
  const teamMembersForGuard = useTeamStore((s) => s.members.get(teamId) ?? EMPTY_LIST);
  const meIdForGuard = useShellDataContext()?.currentUserId ?? null;
  const myBits = useMemo(
    () => meIdForGuard
      ? resolvePermissions(teamMembersForGuard as any, meIdForGuard).bits
      : 0,
    [teamMembersForGuard, meIdForGuard],
  );

  if (!role) return null;

  function togglePerm(bit: number) {
    setPerms((prev: number) => (prev & bit ? prev & ~bit : prev | bit));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await api.updateRole(teamId, role.id, { name: name.trim() || role.name, color, permissions: perms });
      onSaved();
    } catch (err) {
      console.warn('[Settings] updateRole failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Save failed — admin role required.', duration: 3500 } }));
      setSaving(false);
    }
  }

  return (
    <div className="set-modal-overlay">
      <button
        type="button"
        className="modal-overlay-dismiss"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="set-modal">
        <header className="set-modal-head">
          <h3>Edit role</h3>
          <button className="set-x" onClick={onClose}>×</button>
        </header>
        <div className="set-modal-body">
          <Row label="Name">
            <TextField value={name} onChange={setName} />
          </Row>
          <Row label="Color">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 48, height: 28, border: '1px solid var(--hairline)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}
            />
          </Row>
          <div style={{ height: 8 }} />
          <div style={{ color: 'var(--fg-3)', fontSize: 11, marginBottom: 6 }}>PERMISSIONS</div>
          {(() => {
            const adminOn = (perms & 0x1) !== 0;
            // Full-admin viewers hold every bit; non-admins hold only
            // their union. Hide bits we don't hold AND that the role
            // doesn't already have — keeping the previously-granted
            // ones visible (read-only) so a save doesn't silently
            // strip permissions the role used to have. A viewer with
            // myBits === -1 (admin/owner) passes everything through.
            const iAmAdmin = (myBits & 0x1) !== 0 || myBits === -1;
            return PERM_FLAGS.flatMap((f) => {
              const isAdminBit = f.bit === 0x1;
              const covered = adminOn && !isAdminBit; // PERM_ADMIN swallows the rest
              const onTheRole = (perms & f.bit) !== 0;
              const iHoldIt = iAmAdmin || (myBits & f.bit) !== 0;
              if (!iHoldIt && !onTheRole) return []; // hide entirely
              const escalation = !iHoldIt && onTheRole;
              const disabled = covered || escalation;
              let tip: string | undefined;
              if (covered) tip = 'Covered by Admin (all permissions)';
              else if (escalation) tip = "You don't hold this permission yourself — it's read-only to you";
              else tip = undefined;
              return [
                <label
                  key={f.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 0',
                    cursor: disabled ? 'default' : 'pointer',
                    opacity: disabled ? 0.5 : 1,
                  }}
                  title={tip}
                >
                  <input
                    type="checkbox"
                    checked={covered || onTheRole}
                    disabled={disabled}
                    onChange={() => togglePerm(f.bit)}
                  />
                  <span>{f.label}</span>
                  {covered && (
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>
                      via Admin
                    </span>
                  )}
                  {escalation && (
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-3)' }}>
                      above your ceiling
                    </span>
                  )}
                </label>
              ];
            });
          })()}
          <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 14 }}>Assign this role to members from the <strong>Members</strong> tab.</div>
        </div>
        <footer className="set-modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save role'}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function TeamMembers() {
  const auth = useActiveTeamAuth();
  const teamId = auth?.teamId;
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const roles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const setMembers = useTeamStore((s) => s.setMembers);
  const [saving, setSaving] = useStateS(false);
  const [savedAt, setSavedAt] = useStateS<number | null>(null);
  // Local draft of role-id assignments, keyed by user_id. Edits only
  // mutate the draft — pressing Save in the FormBar commits the diff
  // to the server. Discard reverts everything back to the server state.
  const initialDraft = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const m of members) out[m.userId] = [...(m.roleIds ?? [])];
    return out;
  }, [members]);
  const [draft, setDraft] = useStateS<Record<string, string[]>>(initialDraft);
  // Re-seed the draft when the server state changes (e.g. after a save
  // round-trip or another admin's edit comes in via websocket).
  useEffectS(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  const dirty = useMemo(() => {
    for (const m of members) {
      const cur = (m.roleIds ?? []).slice().sort((a, b) => a.localeCompare(b)).join('|');
      const nxt = (draft[m.userId] ?? []).slice().sort((a, b) => a.localeCompare(b)).join('|');
      if (cur !== nxt) return true;
    }
    return false;
  }, [members, draft]);

  // Non-default roles are the ones admins explicitly assign. `everyone` is
  // applied implicitly to every member so we hide it from the toggles.
  const assignableRoles = roles
    .filter((r) => !r.isDefault)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));

  function toggleRole(memberId: string, roleId: string) {
    setDraft((prev) => {
      const cur = prev[memberId] ?? [];
      const next = cur.includes(roleId)
        ? cur.filter((id) => id !== roleId)
        : [...cur, roleId];
      return { ...prev, [memberId]: next };
    });
  }

  async function save() {
    if (!teamId || saving) return;
    setSaving(true);
    try {
      const rolesById = new Map(roles.map((r) => [r.id, r]));
      const PERM_ADMIN = 1;
      const updates: Array<{ memberId: string; roleIds: string[] }> = [];
      for (const m of members) {
        const cur = (m.roleIds ?? []).slice().sort((a, b) => a.localeCompare(b)).join('|');
        const nxt = (draft[m.userId] ?? []).slice().sort((a, b) => a.localeCompare(b)).join('|');
        if (cur !== nxt) updates.push({ memberId: m.userId, roleIds: draft[m.userId] ?? [] });
      }
      for (const u of updates) {
        await api.updateMember(teamId, u.memberId, { role_ids: u.roleIds });
      }
      // Optimistically reflect the new assignments locally so the store
      // matches the server without waiting for a re-sync.
      const updated = members.map((m) => {
        const nextIds = draft[m.userId] ?? m.roleIds ?? [];
        const nextRoles = nextIds.map((id) => rolesById.get(id)).filter(Boolean);
        const isAdmin = nextRoles.some((r: any) => (r.permissions & PERM_ADMIN) !== 0);
        return { ...m, roleIds: nextIds, roles: nextRoles, isAdmin };
      });
      setMembers(teamId, updated as any);
      setSavedAt(Date.now());
    } catch (err) {
      console.warn('[Settings] save members failed', err);
      globalThis.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'members', text: 'Update failed — manage-members permission required.', duration: 3500 } }));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(initialDraft);
  }

  if (!auth) {
    return (
      <Group title="Members" hint="Sign in to a real team to manage members.">
        <div className="set-empty">Members editor is disabled in mock sessions.</div>
      </Group>
    );
  }

  return (
    <>
      <Group title="Members" hint="Toggle a role to promote or demote a member, then press Save. The default role applies to everyone automatically.">
        <div className="set-table">
          {members.length === 0 && <div className="set-empty">No members yet.</div>}
          {members.map((m) => {
            const memberRoleIds = draft[m.userId] ?? m.roleIds ?? [];
            return (
              <div key={m.userId} className="set-tr" style={{ display: 'grid', gridTemplateColumns: '1.4fr 2fr', gap: 12, alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{m.displayName || m.username}</div>
                  <div style={{ color: 'var(--fg-3)', fontSize: 11 }}>{m.username}</div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {assignableRoles.length === 0 && (
                    <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>No roles to assign — create one in Roles & permissions.</span>
                  )}
                  {assignableRoles.map((r) => {
                    const has = memberRoleIds.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        onClick={() => toggleRole(m.userId, r.id)}
                        title={has ? `Remove ${r.name}` : `Grant ${r.name}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 9px',
                          border: '1px solid ' + (has ? r.color : 'var(--hairline)'),
                          background: has ? r.color + '22' : 'transparent',
                          color: has ? 'var(--fg)' : 'var(--fg-2)',
                          borderRadius: 999,
                          cursor: 'pointer',
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.color }} />
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Group>
      <FormBar dirty={dirty} saving={saving} savedAt={savedAt} onSave={save} onDiscard={discard} />
    </>
  );
}
// Team Settings → Integrations. Mirror of pages/TeamSettings/IntegrationsTab
// using this file's atoms (Row/Group/TextField/Btn) so it slots into the
// shell modal consistently with the other team tabs.
export function TeamIntegrations() {
  const auth = useActiveTeamAuth();
  const [configured, setConfigured] = useStateS<boolean | null>(null);
  const [apiKey, setApiKey] = useStateS('');
  const [busy, setBusy] = useStateS(false);
  const [msg, setMsg] = useStateS<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffectS(() => {
    if (!auth) { setConfigured(false); return; }
    let cancelled = false;
    api.getGiphyIntegration(auth.teamId)
      .then((res) => { if (!cancelled) setConfigured(res.configured); })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [auth?.teamId]);

  async function save(clear: boolean) {
    if (!auth) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.setGiphyApiKey(auth.teamId, clear ? '' : apiKey);
      setConfigured(res.configured);
      setApiKey('');
      setMsg({ kind: 'ok', text: res.configured ? 'Saved.' : 'Cleared.' });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Save failed — admin permission required.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group
      title="Giphy"
      hint="Powers the /giphy slash command. The key stays on the server and is never sent to clients."
    >
      <Row
        label="API key"
        hint={giphyHint(configured)}
      >
        <input
          className="set-input mono"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={configured ? 'paste a new key to replace' : 'paste your Giphy API key'}
          autoComplete="off"
        />
      </Row>
      {msg && (
        <div className="set-row" style={{ paddingTop: 0 }}>
          <div className="set-row-l" />
          <div className="set-row-r" style={{ color: msg.kind === 'ok' ? 'var(--ok)' : 'var(--danger)', fontSize: 12 }}>
            {msg.text}
          </div>
        </div>
      )}
      <Row label="" hint="">
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</Btn>
          {configured && <Btn danger onClick={() => save(true)}>Clear key</Btn>}
        </div>
      </Row>
    </Group>
  );
}

export function TeamFederation() {
  // Use real node identity surfaced through SHELL_DATA.SERVERS[].node.
  // Peers list stays empty until we wire a real peer status feed; the
  // Add-peer wizard is still available.
  const data = useShellDataContext() as any;
  const team = data?.SERVERS?.[0];
  const nodeHost = team?.node || 'local';
  return (
    <>
      <Group title="Mesh" hint="Peer nodes that replicate this team. Voice stays on the origin node, but messages, channels and presence sync across all peers.">
        <Row label="This node">
          <div>
            <code>{nodeHost}:8080</code>
            <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 2 }}>{team?.federated ? 'federated' : 'solo · not federated'}</div>
          </div>
        </Row>
        <Row label="Federation port" hint="Memberlist gossip listens here. Configured server-side via DILLA_FEDERATION_PORT."><TextField mono readOnly value="8081" onChange={() => {}} /></Row>
        <Row label="Advertise as" hint="Address other nodes see. Server-side env var; not editable from the client."><TextField mono readOnly value="auto" onChange={() => {}} /></Row>
      </Group>
      <Group title="Peers">
        <div className="set-table">
          <div className="set-th"><span>Address</span><span>State</span><span>Last sync</span><span>Lamport</span><span></span></div>
          <div className="set-empty">No federated peers yet. Click + Add peer below to invite another node onto this team's mesh.</div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Btn onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:add-peer'))}>+ Add peer</Btn>
          <Btn onClick={() => globalThis.dispatchEvent(new CustomEvent('dilla:add-peer'))}>Generate join command</Btn>
        </div>
      </Group>
    </>
  );
}
export function TeamAudit() {
  const auth = useActiveTeamAuth();
  const teamId = auth?.teamId;
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? EMPTY_LIST : EMPTY_LIST));
  const [events, setEvents] = useStateS<any[] | null>(null);
  const [error, setError] = useStateS<string | null>(null);

  const membersById = new Map(members.map((m) => [m.userId, m]));

  useEffectS(() => {
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = (await api.getAuditEvents(teamId, 200)) as any[];
        if (!cancelled) setEvents(list);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'failed to load audit log');
      }
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  if (!auth) {
    return (
      <Group title="Recent activity" hint="Sign in to a real team to view the audit log.">
        <div className="set-empty">Audit log is disabled in mock sessions.</div>
      </Group>
    );
  }
  if (error) {
    return (
      <Group title="Recent activity" hint="Server-stored log of admin actions for this team.">
        <div className="set-empty">{error}</div>
      </Group>
    );
  }
  if (events === null) {
    return (
      <Group title="Recent activity" hint="Server-stored log of admin actions for this team.">
        <div className="set-empty">Loading…</div>
      </Group>
    );
  }

  function describe(e: any) {
    return describeAuditEventInline(e, membersById);
  }

  return (
    <Group title="Recent activity" hint="Server-stored log of admin actions for this team.">
      <div className="set-audit">
        {events.length === 0 && (
          <div className="set-empty">No audit events yet — admin actions (role changes, channel locks, kicks/bans) will appear here.</div>
        )}
        {events.map((e: any) => {
          const actor = e.actor_user_id ? membersById.get(e.actor_user_id) : null;
          const actorName = actor?.username || (e.actor_user_id ? e.actor_user_id.slice(0, 8) : 'system');
          return (
            <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '110px 110px 1fr', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--hairline)' }}>
              <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.created_at}</span>
              <span style={{ fontWeight: 600 }}>@{actorName}</span>
              <span>{describe(e)}</span>
            </div>
          );
        })}
      </div>
    </Group>
  );
}

export default Settings;
