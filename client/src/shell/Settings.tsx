// @ts-nocheck
// Settings modal for Dilla, ported verbatim from
// design_handoff_dilla_mesh/settings.jsx. Strict TS types come later.
// Two entry points: the team-header cog opens Team settings,
// the user-panel cog opens User preferences.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from './icons';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';
import { api } from '../services/api';
import { isMockSession } from '../services/mockSession';
import { exportIdentityBlob } from '../services/keyStore';
import { useShellDataContext } from './ShellDataContext';
import { startMicTest, stopMicTest, type MicTestSession } from '../services/micTest';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';

const { useState: useStateS, useEffect: useEffectS, useRef: useRefS } = React;

// Debounced save helper for autosaved text fields. The handler clears any
// in-flight timer and schedules a new one — keeps API traffic to one POST
// per ~700ms of idle, matching typical settings UX.
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

const USER_TABS = [
  { id: 'account',  name: 'Account' },
  { id: 'notif',    name: 'Notifications' },
  { id: 'voice',    name: 'Voice & video' },
  { id: 'appear',   name: 'Appearance' },
  { id: 'privacy',  name: 'Privacy & encryption' },
  { id: 'keys',     name: 'Keyboard shortcuts' },
];
const TEAM_TABS = [
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
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const meId = data?.currentUserId;
  const me = meId ? data?.byId?.[meId] : null;
  const team = data?.SERVERS?.[0];
  const subLabel = mode === 'team'
    ? (team?.name?.toUpperCase() || '')
    : (me?.name || '');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings" onClick={e => e.stopPropagation()}>
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
              onClick={() => {
                if (mode === 'team') {
                  // Leave-team isn't wired yet (server-side endpoint TODO);
                  // surface that explicitly rather than silently no-op.
                  window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Leaving a team isn\'t implemented yet.', duration: 2500 } }));
                  return;
                }
                // Sign out: clear all auth/derivedKey/passphrase from
                // storage, reset crypto manager, disconnect every WS, and
                // bounce to /login.
                onClose();
                try { useAuthStore.getState().logout(); } catch { /* ignore */ }
                navigate('/login');
              }}
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
            <div className="set-foot-actions">
              <button className="sc-btn" onClick={onClose}>Cancel · esc</button>
              <button className="sc-btn primary" onClick={() => {
                window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: mode === 'team' ? (team?.name?.toUpperCase() || '') : null, author: 'preferences', text: 'Preferences saved.', duration: 3000 } }));
                onClose();
              }}>Save changes · ⌘↵</button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

// ───────── shared form atoms ─────────
function Row({ label, hint, children }) {
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
function Group({ title, hint, children }) {
  return (
    <section className="set-group">
      <h3>{title}</h3>
      {hint && <p className="set-group-hint">{hint}</p>}
      {children}
    </section>
  );
}
function Toggle({ value, onChange }) {
  return (
    <button className="set-toggle" data-on={value ? '1' : '0'} onClick={() => onChange(!value)}>
      <i />
    </button>
  );
}
function TextField({ value, onChange, placeholder, mono, readOnly }) {
  return <input className={'set-input' + (mono ? ' mono' : '') + (readOnly ? ' set-input-readonly' : '')} value={value} placeholder={placeholder}
                readOnly={readOnly}
                onChange={readOnly ? undefined : (e => onChange(e.target.value))} />;
}
function Select({ value, onChange, options }) {
  return (
    <select className="set-input" value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function Btn({ children, danger, onClick }) {
  return <button className={'set-btn' + (danger ? ' danger' : '')} onClick={onClick}>{children}</button>;
}

// ───────── USER tabs ─────────
// Square crop tool that runs between file pick and upload. The user sees
// the source image with a draggable + corner-resizable square overlay,
// and on Save we render the selection into a fixed 256x256 canvas and
// return a JPEG Blob. Kept self-contained — no third-party crop libs.
function CropModal({
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
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const w = e.currentTarget.clientWidth;
    const h = e.currentTarget.clientHeight;
    const size = Math.min(w, h);
    setImgSize({ w, h });
    setCrop({ x: (w - size) / 2, y: (h - size) / 2, size });
  }

  function clamp(next: { x: number; y: number; size: number }, w: number, h: number) {
    const size = Math.max(40, Math.min(next.size, w, h));
    const x = Math.max(0, Math.min(next.x, w - size));
    const y = Math.max(0, Math.min(next.y, h - size));
    return { x, y, size };
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
    let next = { ...d.orig };
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
    setCrop(clamp(next, imgSize.w, imgSize.h));
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
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card crop-card" onClick={(e) => e.stopPropagation()}>
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
              {imgUrl && (
                <img ref={imgRef} src={imgUrl} onLoad={onImgLoad} className="crop-img" alt="" draggable={false} />
              )}
              {crop && (
                <div
                  className="crop-box"
                  onMouseDown={(e) => startDrag(e, 'move')}
                  style={{ left: crop.x, top: crop.y, width: crop.size, height: crop.size }}
                >
                  <span className="crop-handle nw" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'nw'); }} />
                  <span className="crop-handle ne" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'ne'); }} />
                  <span className="crop-handle sw" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'sw'); }} />
                  <span className="crop-handle se" onMouseDown={(e) => { e.stopPropagation(); startDrag(e, 'se'); }} />
                </div>
              )}
            </div>
          </div>
          <p className="modal-hint">Drag to reposition, corners to resize. Output is a 256×256 square.</p>
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onCancel}>Cancel</button>
          <button className="sc-btn primary" onClick={save}>Save</button>
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
function AvatarUploader() {
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
    } catch (e2) {
      setErr((e2 as Error).message || 'Upload failed.');
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
    } catch (e2) {
      setErr((e2 as Error).message || 'Clear failed.');
    } finally {
      setBusy(false);
    }
  }

  function applyAvatarUrl(url: string, userId?: string) {
    if (!userId) return;
    const ts = useTeamStore.getState();
    for (const [teamId, list] of ts.members) {
      const idx = list.findIndex((m) => m.userId === userId);
      if (idx < 0) continue;
      const next = list.map((m, i) => (i === idx ? { ...m, avatarUrl: url } : m));
      ts.setMembers(teamId, next);
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

function UserAccount() {
  // Read the current user from window.SHELL_DATA (set up by useShellData).
  // No hardcoded mock fallback — empty when the data hasn't loaded yet.
  const data = useShellDataContext() as any;
  const meId = data?.currentUserId;
  const me = meId ? data?.byId?.[meId] : null;
  const auth = useActiveTeamAuth();
  const [name, setName] = useStateS(me?.name || '');
  const [status, setStatus] = useStateS(me?.custom || '');
  const initials = me?.initials || '?';
  const avatarColor = me?.color || 'var(--muted)';
  const publicKey =
    useAuthStore((s) => s.publicKey) ||
    data?.publicKey ||
    '';

  // Debounced persistence: PATCH /api/v1/users/me for display name + status.
  // On /mesh (auth === null) the field is local-only; the value still
  // updates in the form, just doesn't round-trip through a real backend.
  const persistName = useDebouncedSave((v: string) => {
    if (!auth) return;
    api
      .updateMe(auth.baseUrl, auth.token, { display_name: v })
      .catch((err) => console.warn('[Settings] display_name update failed', err));
  });
  const persistStatus = useDebouncedSave((v: string) => {
    if (!auth) return;
    // status_text rides on PATCH /users/me; presence-broadcast event uses
    // api.updatePresence so other clients see the change live.
    api
      .updateMe(auth.baseUrl, auth.token, { status_text: v })
      .catch((err) => console.warn('[Settings] status_text update failed', err));
    api
      .updatePresence(auth.teamId, 'online', v)
      .catch((err) => console.warn('[Settings] presence update failed', err));
  });

  return (
    <Group title="Identity" hint="Your display name and status are visible to everyone on the team.">
      <Row label="Display name">
        <TextField
          value={name}
          onChange={(v) => {
            setName(v);
            persistName(v);
          }}
        />
      </Row>
      <Row label="Custom status" hint="Visible next to your name in the member list.">
        <TextField
          value={status}
          onChange={(v) => {
            setStatus(v);
            persistStatus(v);
          }}
        />
      </Row>
      <Row label="Avatar">
        <AvatarUploader />
      </Row>
      <Row label="Public key" hint="ed25519 — verified by your safety number.">
        <TextField mono readOnly value={publicKey} onChange={() => {}} />
      </Row>
    </Group>
  );
}
function UserNotif() {
  // Notify mode is derived from desktopNotifications + a per-channel filter
  // we don't track yet. For now: desktop on = all, desktop off + sound on =
  // mentions, both off = nothing. Editing the segment toggles the booleans
  // to match.
  const desktopNotifications = useUserSettingsStore((s) => s.desktopNotifications);
  const soundNotifications = useUserSettingsStore((s) => s.soundNotifications);
  const setDesktop = useUserSettingsStore((s) => s.setDesktopNotifications);
  const setSound = useUserSettingsStore((s) => s.setSoundNotifications);
  const mode = desktopNotifications ? 'all' : soundNotifications ? 'mentions' : 'nothing';
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
  // Quiet hours are server-backed via PATCH /users/me so the window follows
  // the identity across devices. Optimistic local update + debounced PATCH;
  // the store value is the source of truth for the form. Hydration from
  // /me happens in useUserMeSync (mounts at AppShell) so the form already
  // shows the saved window when the modal opens.
  const auth = useActiveTeamAuth();
  const quiet = useUserSettingsStore((s) => s.quietHoursEnabled);
  const quietFrom = useUserSettingsStore((s) => s.quietHoursFrom);
  const quietTo = useUserSettingsStore((s) => s.quietHoursTo);
  const setQuietHours = useUserSettingsStore((s) => s.setQuietHours);
  const persistQuiet = useDebouncedSave((next: { enabled?: boolean; from?: string; to?: string }) => {
    if (!auth) return;
    const body: Record<string, unknown> = {};
    if (next.enabled !== undefined) body.quiet_hours_enabled = next.enabled;
    if (next.from !== undefined) body.quiet_hours_from = next.from;
    if (next.to !== undefined) body.quiet_hours_to = next.to;
    api
      .updateMe(auth.baseUrl, auth.token, body as Parameters<typeof api.updateMe>[2])
      .catch((err) => console.warn('[Settings] quiet hours update failed', err));
  });
  const setQuiet = (enabled: boolean) => {
    setQuietHours({ enabled });
    persistQuiet({ enabled });
  };
  const setQuietFrom = (from: string) => {
    setQuietHours({ from });
    persistQuiet({ from });
  };
  const setQuietTo = (to: string) => {
    setQuietHours({ to });
    persistQuiet({ to });
  };
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
      <Group title="Quiet hours" hint="Suppress all push notifications during this window. Mentions still show in-app.">
        <Row label="Enable quiet hours"><Toggle value={quiet} onChange={setQuiet} /></Row>
        <Row label="From → to">
          <div className="set-range">
            <TextField value={quietFrom} onChange={setQuietFrom} mono />
            <span>→</span>
            <TextField value={quietTo} onChange={setQuietTo} mono />
          </div>
        </Row>
      </Group>
    </>
  );
}
function UserVoice() {
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

  const [camera, setCamera] = useStateS('FaceTime HD');
  const [mirror, setMirror] = useStateS(true);

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
        setInputDevs(ins.length ? [{ id: 'default', label: 'Default' }, ...ins] : [{ id: 'default', label: 'Default' }]);
        setOutputDevs(outs.length ? [{ id: 'default', label: 'Default' }, ...outs] : [{ id: 'default', label: 'Default' }]);
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
        <Row label="Input level" hint={testError ? `Mic error: ${testError}` : permError ? `Permission: ${permError}` : 'Speak normally to verify levels.'}>
          <div className="set-meter-row">
            <div className="set-meter">
              {Array.from({ length: 22 }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    background: i < 11 ? 'var(--accent)' : i < 17 ? 'var(--warn)' : 'var(--danger)',
                    opacity: i < litCells ? 1 : 0.18,
                  }}
                />
              ))}
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
          <Select value={camera} onChange={setCamera} options={['FaceTime HD', 'External Webcam']} />
        </Row>
        <Row label="Mirror preview"><Toggle value={mirror} onChange={setMirror} /></Row>
      </Group>
    </>
  );
}
function UserAppear() {
  // Theme persisted to useUserSettingsStore (themeStore reads from it and
  // updates --theme tokens). 'mesh' is the default per the v2 migration in
  // userSettingsStore.ts. Density also lives there.
  const theme = useUserSettingsStore((s) => s.theme);
  const setTheme = useUserSettingsStore((s) => s.setTheme);
  const density = useUserSettingsStore((s) => s.density);
  const setDensity = useUserSettingsStore((s) => s.setDensity);

  const [motion, setMotion] = useStateS(false);
  const [size, setSize] = useStateS(14);

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
        <Row label="Base font size">
          <div className="set-stepper">
            <button onClick={() => setSize(s => Math.max(11, s - 1))}>−</button>
            <span>{size}px</span>
            <button onClick={() => setSize(s => Math.min(20, s + 1))}>+</button>
          </div>
        </Row>
        <Row label="Reduce motion" hint="Disable speaking pulses, typing-dot animations, and decorative transitions.">
          <Toggle value={motion} onChange={setMotion} />
        </Row>
      </Group>
    </>
  );
}
function UserPrivacy() {
  const data = useShellDataContext() as any;
  const meId = data?.currentUserId; const me = meId ? data?.byId?.[meId] : null;
  const meName = me?.name || 'me';
  // Pull a safety-number-like 24-hex grouping from the public key when
  // available; fall back to the handoff placeholder grouping otherwise.
  const pk = data?.publicKey || 'ed25519:8e1d3c447a529bf622d14e08af31000000000000';
  const pkHex = pk.replace(/^[^:]*:/, '').replace(/[^0-9a-f]/gi, '');
  function fp(start) {
    return [0, 1, 2].map(i => pkHex.slice(start + i * 8, start + i * 8 + 8).replace(/(.{4})(.{4})/, '$1 $2'));
  }
  const block1 = fp(0).map(s => s || '— — — —');
  const block2 = fp(24).map(s => s || '— — — —');
  // Verify contacts: iterate over real team members (excluding current user).
  const others = (data?.MEMBERS ?? []).filter((m: any) => m.id !== meId);
  return (
    <>
      <Group title="Your safety number" hint="Have a friend compare this number out-of-band before trusting your messages.">
        <div className="set-fingerprint">
          <div className="set-fp-block">
            {block1.map((row, i) => <div key={i}>{row}</div>)}
          </div>
          <div className="set-fp-block">
            {block2.map((row, i) => <div key={i}>{row}</div>)}
          </div>
          <div className="set-fp-actions">
            <Btn onClick={() => {
              const full = [...block1, ...block2].join(' ');
              navigator.clipboard?.writeText(full);
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Safety number copied.', duration: 2000 } }));
            }}>Copy</Btn>
            <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'QR display requires a renderer — copy and paste the number for now.', duration: 3000 } }))}>Show QR</Btn>
          </div>
        </div>
      </Group>
      <Group title="Encryption">
        <Row label="Double Ratchet sessions" hint="Currently active per-contact key chains.">
          <span className="set-stat">{others.length} session{others.length === 1 ? '' : 's'}</span>
        </Row>
        <Row label="Rotate session keys" hint="Forces new key exchange with everyone you've talked to. Old messages stay readable.">
          <Btn onClick={async () => {
            // No bulk-rotation API yet; the underlying cryptoService has
            // rotateChannelKey(channelId, removedUserId) for the per-channel
            // case. A "rotate everything" path would iterate channels and
            // call that, but it's a heavy operation behind a confirm —
            // leave as an explicit notify until the dedicated UI exists.
            window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'crypto', text: 'Bulk-rotate not wired yet. Per-channel rotation runs automatically when a member leaves.', duration: 4500 } }));
          }}>Rotate now</Btn>
        </Row>
        <Row label="Export identity backup" hint="Encrypted with your passphrase. Keep it offline.">
          <Btn onClick={async () => {
            try {
              const blob = await exportIdentityBlob();
              if (!blob) {
                window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'No identity to export.', duration: 3000 } }));
                return;
              }
              // Base64 string → trigger a file download.
              const a = document.createElement('a');
              a.href = 'data:application/octet-stream;base64,' + blob;
              a.download = `dilla-identity-${meName}.bin`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Identity backup downloaded.', duration: 3000 } }));
            } catch (err) {
              console.warn('[Settings] export identity failed', err);
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Export failed: ' + (err as Error).message, duration: 4000 } }));
            }
          }}>Export…</Btn>
        </Row>
      </Group>
      <Group title="Verify contacts" hint="Compare safety numbers with someone to confirm they are who they say they are — not the server impersonating them.">
        {others.length === 0 ? (
          <div className="set-empty">No contacts to verify yet.</div>
        ) : others.map((m: any) => (
          <Row key={m.id} label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span
                className={'set-avatar' + (m.avatarUrl ? ' has-image' : '')}
                style={m.avatarUrl
                  ? { backgroundImage: `url(${m.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', width: 22, height: 22, fontSize: 10, color: 'transparent' }
                  : { backgroundColor: m.color, width: 22, height: 22, fontSize: 10 }}
              >{!m.avatarUrl && m.initials}</span>
              {m.name}
            </span>
          }>
            <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: m.id }))}>Verify</Btn>
          </Row>
        ))}
      </Group>
      <Group title="Block list">
        <Row label="Search blocked users"><TextField value="" onChange={() => {}} placeholder="filter…" /></Row>
        <div className="set-empty">no blocked users</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Pick a user from members or a DM to block them.', duration: 3000 } }))}>+ Block someone</Btn>
        </div>
      </Group>
    </>
  );
}
function UserKeys() {
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
function TeamInfo() {
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
  const [name, setName] = useStateS(team?.name ?? '');
  const [description, setDescription] = useStateS(team?.description ?? '');
  const [defaultChannel, setDefaultChannel] = useStateS(channelNames[0] ?? '#general');
  const [slowMode, setSlowMode] = useStateS('0');
  // Re-sync local state when the bridged team value changes (e.g. another
  // admin renames the team).
  useEffectS(() => {
    if (team?.name !== undefined) setName(team.name);
    if (team?.description !== undefined) setDescription(team.description);
  }, [team?.name, team?.description]);

  // PATCH /api/v1/teams/{id} for name/description. Server enforces admin
  // permission; non-admins will get a 403 and the form just won't save.
  const persistTeam = useDebouncedSave((updates: Record<string, unknown>) => {
    if (!auth) return;
    api
      .updateTeam(auth.teamId, updates)
      .catch((err) => console.warn('[Settings] team update failed', err));
  });

  return (
    <>
      <Group title="Team">
        <Row label="Name">
          <TextField
            value={name}
            onChange={(v) => {
              setName(v);
              persistTeam({ name: v });
            }}
          />
        </Row>
        <Row label="Description">
          <TextField
            value={description}
            onChange={(v) => {
              setDescription(v);
              persistTeam({ description: v });
            }}
          />
        </Row>
        <Row label="Created"><span className="set-stat">{created}</span></Row>
        <Row label="Storage"><span className="set-stat">0 GB / 10 GB</span></Row>
      </Group>
      <Group title="Defaults">
        <Row label="Default channel">
          <Select
            value={defaultChannel}
            options={channelNames.length ? channelNames : ['#general']}
            onChange={(v) => {
              setDefaultChannel(v);
              // Server-side default channel is a team-level field; the API
              // accepts default_channel_id but we only have the display
              // name here. Map name → id via the bridged data.
              const ch = (data?.CHANNELS ?? []).find(
                (c: any) => `#${c.name}` === v,
              );
              if (ch) persistTeam({ default_channel_id: ch.id });
            }}
          />
        </Row>
        <Row label="Slow mode (seconds)">
          <TextField
            mono
            value={slowMode}
            onChange={(v) => {
              setSlowMode(v);
              const n = Number.parseInt(v, 10);
              if (!Number.isNaN(n) && n >= 0) persistTeam({ slow_mode_seconds: n });
            }}
          />
        </Row>
      </Group>
    </>
  );
}
function TeamInvites() {
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
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  function formatExpiry(expiresAt: Date | null): string {
    if (!expiresAt) return '—';
    const ms = expiresAt.getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const totalSecs = Math.floor(ms / 1000);
    const days = Math.floor(totalSecs / 86400);
    const hours = Math.floor((totalSecs % 86400) / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    // > 24 h: show the absolute date so admins can plan; under 24 h:
    // start ticking with progressively finer granularity.
    if (days >= 1) return expiresAt.toLocaleDateString();
    if (hours >= 1) return `in ${hours}h ${mins}m`;
    if (mins >= 1) return `in ${mins}m ${secs}s`;
    return `in ${secs}s`;
  }

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
              // Store the raw timestamp; the render layer formats it
              // relative so the cell can tick down without re-fetching.
              expiresAt: inv.expires_at ? new Date(inv.expires_at + 'Z') : null,
              who: userLabel(inv.created_by),
            };
          }),
        );
      })
      .catch((err) => console.warn('[Settings] listInvites failed', err));
    // userLabel depends on data.byId; rebuilding the table when membership
    // loads matters for resolving newly-mapped creators on first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    window.dispatchEvent(
      new CustomEvent('dilla:notify', {
        detail: { channel: 'system', author: 'team', text: 'Invite revoked.', duration: 3500 },
      }),
    );
  }

  async function create() {
    if (!auth) {
      // Mock fallback: keep the prior demo behavior so /mesh has something
      // to show.
      const code = 'dilla/invite/' + Math.random().toString(16).slice(2, 6).toUpperCase();
      setRows((prev) => [...prev, { code, uses: '0 / ∞', expires: '—', who: myLabel }]);
      navigator.clipboard?.writeText(code);
      window.dispatchEvent(
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
          expiresAt: inv.expires_at ? new Date(inv.expires_at + 'Z') : null,
          who: userLabel(inv.created_by ?? meId),
        },
      ]);
      navigator.clipboard?.writeText(url);
      window.dispatchEvent(
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
      window.dispatchEvent(
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
        {rows.map(r => (
          <div key={r.code} className={'set-tr' + (r.stale ? ' stale' : '')}>
            <span className="set-link-cell" title={r.code}>
              <code className="set-link-code">{r.code}</code>
              <Btn onClick={() => {
                navigator.clipboard?.writeText(r.code);
                window.dispatchEvent(new CustomEvent('dilla:notify', {
                  detail: { channel: 'system', author: 'team', text: 'Invite link copied.', duration: 2000 },
                }));
              }}>Copy</Btn>
            </span>
            <span>{r.uses}</span>
            <span>{formatExpiry(r.expiresAt)}</span>
            <span>{r.who}</span>
            <Btn danger onClick={() => revoke(r)}>Revoke</Btn>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Btn onClick={create}>+ New invite link</Btn>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
          uses
          <select className="set-input" value={maxUsesOpt} onChange={(e) => setMaxUsesOpt(e.target.value)} style={{ width: 80 }}>
            <option value="inf">∞</option>
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="25">25</option>
            <option value="100">100</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-3)' }}>
          expires
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
const PERM_FLAGS = [
  { bit: 1 << 0, key: 'admin',            label: 'Admin (all permissions)' },
  { bit: 1 << 1, key: 'manage_channels',  label: 'Manage channels' },
  { bit: 1 << 2, key: 'manage_members',   label: 'Manage members (kick / ban)' },
  { bit: 1 << 3, key: 'manage_roles',     label: 'Manage roles' },
  { bit: 1 << 4, key: 'send_messages',    label: 'Send messages' },
  { bit: 1 << 5, key: 'manage_messages',  label: 'Manage messages (delete / pin)' },
  { bit: 1 << 6, key: 'create_invites',   label: 'Create invites' },
  { bit: 1 << 7, key: 'manage_team',      label: 'Manage team settings' },
  { bit: 1 << 8, key: 'bypass_slow_mode', label: 'Bypass slow mode' },
] as const;

function permsSummary(permissions: number): string {
  if ((permissions & (1 << 0)) !== 0) return 'all permissions';
  const labels = PERM_FLAGS.filter((f) => f.bit !== (1 << 0) && (permissions & f.bit) !== 0)
    .map((f) => f.label.toLowerCase().split(' (')[0]);
  return labels.length ? labels.join(' · ') : 'no permissions';
}

function TeamRoles() {
  const auth = useActiveTeamAuth();
  const teamId = auth?.teamId;
  const storeRoles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? [] : []));
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? [] : []));
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
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Create failed — manage-roles permission required.', duration: 3500 } }));
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
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Reorder failed — manage-roles permission required.', duration: 3500 } }));
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
    if (!window.confirm('Delete this role? Members keep their other roles.')) return;
    try {
      await api.deleteRole(teamId, roleId);
      await refresh();
    } catch (err) {
      console.warn('[Settings] deleteRole failed', err);
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Delete failed — admin role required.', duration: 3500 } }));
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
              <div
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
              </div>
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

function RoleEditor({ teamId, role, onClose, onSaved }: { teamId: string; role: any; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useStateS(role?.name ?? '');
  const [color, setColor] = useStateS(role?.color ?? '#7a9aa7');
  const [perms, setPerms] = useStateS<number>(role?.permissions ?? 0);
  const [saving, setSaving] = useStateS(false);

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
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: 'Save failed — admin role required.', duration: 3500 } }));
      setSaving(false);
    }
  }

  return (
    <div className="set-modal-overlay" onClick={onClose}>
      <div className="set-modal" onClick={(e) => e.stopPropagation()}>
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
          {PERM_FLAGS.map((f) => (
            <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={(perms & f.bit) !== 0} onChange={() => togglePerm(f.bit)} />
              <span>{f.label}</span>
            </label>
          ))}
          <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 14 }}>Assign this role to members from the <strong>Members</strong> tab.</div>
        </div>
        <footer className="set-modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save role'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function TeamMembers() {
  const auth = useActiveTeamAuth();
  const teamId = auth?.teamId;
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? [] : []));
  const roles = useTeamStore((s) => (teamId ? s.roles.get(teamId) ?? [] : []));
  const setMembers = useTeamStore((s) => s.setMembers);
  const [busyId, setBusyId] = useStateS<string | null>(null);

  // Non-default roles are the ones admins explicitly assign. `everyone` is
  // applied implicitly to every member so we hide it from the toggles.
  const assignableRoles = roles
    .filter((r) => !r.isDefault)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));

  async function toggleRole(member: any, roleId: string) {
    if (!teamId || busyId) return;
    setBusyId(member.userId);
    try {
      const has = (member.roleIds ?? []).includes(roleId);
      const nextIds = has
        ? (member.roleIds ?? []).filter((id: string) => id !== roleId)
        : [...(member.roleIds ?? []), roleId];
      await api.updateMember(teamId, member.userId, { role_ids: nextIds });

      // Optimistically update the local store so the row reflects the new
      // assignment without waiting for a re-sync.
      const rolesById = new Map(roles.map((r) => [r.id, r]));
      const PERM_ADMIN = 1 << 0;
      const nextRoles = nextIds.map((id: string) => rolesById.get(id)).filter(Boolean);
      const isAdmin = nextRoles.some((r: any) => (r.permissions & PERM_ADMIN) !== 0);
      const updated = members.map((m) =>
        m.userId === member.userId ? { ...m, roleIds: nextIds, roles: nextRoles, isAdmin } : m,
      );
      setMembers(teamId, updated as any);
    } catch (err) {
      console.warn('[Settings] toggleRole failed', err);
      window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'members', text: 'Update failed — manage-members permission required.', duration: 3500 } }));
    } finally {
      setBusyId(null);
    }
  }

  if (!auth) {
    return (
      <Group title="Members" hint="Sign in to a real team to manage members.">
        <div className="set-empty">Members editor is disabled in mock sessions.</div>
      </Group>
    );
  }

  return (
    <Group title="Members" hint="Toggle a role to promote or demote a member. The default role applies to everyone automatically.">
      <div className="set-table">
        {members.length === 0 && <div className="set-empty">No members yet.</div>}
        {members.map((m) => (
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
                const has = (m.roleIds ?? []).includes(r.id);
                return (
                  <button
                    key={r.id}
                    onClick={() => toggleRole(m, r.id)}
                    disabled={busyId === m.userId}
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
                      cursor: busyId === m.userId ? 'wait' : 'pointer',
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
        ))}
      </div>
    </Group>
  );
}
// Team Settings → Integrations. Mirror of pages/TeamSettings/IntegrationsTab
// using this file's atoms (Row/Group/TextField/Btn) so it slots into the
// shell modal consistently with the other team tabs.
function TeamIntegrations() {
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
        hint={
          configured == null
            ? 'Loading…'
            : configured
            ? 'A key is on file. Paste a new one to replace it, or clear it below.'
            : 'No key yet — admins can paste one from developers.giphy.com.'
        }
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

function TeamFederation() {
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
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:add-peer'))}>+ Add peer</Btn>
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:add-peer'))}>Generate join command</Btn>
        </div>
      </Group>
    </>
  );
}
function TeamAudit() {
  const auth = useActiveTeamAuth();
  const teamId = auth?.teamId;
  const members = useTeamStore((s) => (teamId ? s.members.get(teamId) ?? [] : []));
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
    let detail: any = null;
    if (e.details) {
      try { detail = JSON.parse(e.details); } catch { /* leave null */ }
    }
    const targetUser = e.target_type === 'user' && e.target_id ? membersById.get(e.target_id)?.username : null;
    const name = (detail && (detail.name || detail.reason)) || '';
    switch (e.action) {
      case 'role.create':   return `created role ${name || '—'}`;
      case 'role.update':   return `updated role ${name || '—'}`;
      case 'role.delete':   return `deleted role ${name || '—'}`;
      case 'role.reorder':  return `reordered roles`;
      case 'channel.create': return `created channel #${name || '—'}${detail?.type ? ' · ' + detail.type : ''}`;
      case 'channel.delete': return `deleted channel #${name || '—'}`;
      case 'channel.lock':   return `locked channel #${name || '—'}`;
      case 'channel.unlock': return `unlocked channel #${name || '—'}`;
      case 'channel.update': return `updated channel #${name || '—'}`;
      case 'channel.access.update': return `changed access for channel`;
      case 'member.roles.update': return `changed roles for @${targetUser || e.target_id}`;
      case 'member.kick':    return `kicked @${targetUser || e.target_id}`;
      case 'member.ban':     return `banned @${targetUser || e.target_id}${detail?.reason ? ` — ${detail.reason}` : ''}`;
      case 'team.update':    return `updated team settings${name ? ' · ' + name : ''}`;
      case 'invite.create':  return `created an invite${detail?.max_uses ? ' · max ' + detail.max_uses : ''}${detail?.expires_at ? ' · expires ' + detail.expires_at : ''}`;
      case 'invite.revoke':  return `revoked an invite`;
      default: return e.action;
    }
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
