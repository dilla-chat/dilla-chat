# Mesh Server Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Refactor the existing `TeamSidebar` into the Mesh server rail: vertical 40×40 icon stack with brutalist 2px radii, active-state white left bar at -10px, hover translate-y, drag-to-reorder, right-click context menu, federation-status amber dot, and a dashed-accent `+ Add team` button.

**Architecture:**
`TeamSidebar.tsx` (107 LOC) keeps the same role and data sources (`authStore.teams`, `authStore.servers`, `teamStore.activeTeamId`) but gets a new visual treatment, drag-reorder behavior persisted to `authStore`, and a context menu component. A new `TeamRailContextMenu` component sits adjacent. A new `useTeamRailOrder` hook keeps the displayed team order locally and syncs back to the store via a new `setTeamOrder` action. The `+ Add team` button now opens a `NewServerModal` stub (full UX lives in plan #10 extras); for now clicking it still navigates to `/join` if the modal isn't yet wired — keep the existing route.

**Tech Stack:** React 19, native HTML5 drag-and-drop (no library), CSS Grid/Flexbox for layout, Zustand for state, Vitest jsdom.

**Scope guardrails:**
- ❌ No new federation data wiring — the amber dot reads a `federated?: boolean` field from `teamInfo` if present; defaults to `false` (always-off until plan #10).
- ❌ No team Settings/Invites/Mark-all-read/Leave action implementations — context menu items invoke callbacks that either navigate or `console.warn('TODO')`. Real wiring lands in later plans.
- ❌ No `NewServerModal` UI — `+ Add team` keeps navigating to `/join`. Modal is a plan #10 deliverable.
- ✅ Drag-reorder updates a per-server team order persisted to `authStore`.
- ✅ Right-click opens a dropdown anchored to the icon with 4 stub items.
- ✅ Active state: white left bar at -10px, accent fill.
- ✅ Federation indicator: amber dot top-right when `teamInfo.federated === true`.

---

## File Structure

**Create:**
- `client/src/components/TeamSidebar/TeamRailContextMenu.tsx` — small positioned dropdown
- `client/src/components/TeamSidebar/TeamRailContextMenu.css`
- `client/src/components/TeamSidebar/TeamRailContextMenu.test.tsx`

**Modify:**
- `client/src/components/TeamSidebar/TeamSidebar.tsx` — replace render output: new icon markup, drag handlers, context-menu wiring; reuse data wiring
- `client/src/components/TeamSidebar/TeamSidebar.css` — full rewrite for Mesh visuals (40×40, 2px radii, left bar, hover translate, dashed `+` button)
- `client/src/components/TeamSidebar/TeamSidebar.test.tsx` — update assertions for new DOM (icon size, active class, context menu open/close, drag handlers)
- `client/src/stores/authStore.ts` — add `setTeamOrder(teamIds: string[]): void` action that reorders the `teams` Map
- `client/src/stores/authStore.test.ts` — coverage for the new action

---

### Task 1: Add `setTeamOrder` to authStore (TDD)

**Files:**
- Modify: `client/src/stores/authStore.ts`
- Modify: `client/src/stores/authStore.test.ts`

- [ ] **Step 1: Read current authStore**

```bash
sed -n '1,80p' client/src/stores/authStore.ts
```

Locate the `teams` Map field and the existing action set. The Map should preserve insertion order (it does in JS).

- [ ] **Step 2: Write a failing test**

Append to `client/src/stores/authStore.test.ts`:

```typescript
describe('setTeamOrder', () => {
  it('reorders the teams Map to match the given id sequence', () => {
    useAuthStore.setState({
      teams: new Map([
        ['t1', { token: '1', user: {} as any, teamInfo: {}, baseUrl: 'a' }],
        ['t2', { token: '2', user: {} as any, teamInfo: {}, baseUrl: 'b' }],
        ['t3', { token: '3', user: {} as any, teamInfo: {}, baseUrl: 'c' }],
      ]),
    });
    useAuthStore.getState().setTeamOrder(['t3', 't1', 't2']);
    expect(Array.from(useAuthStore.getState().teams.keys())).toEqual([
      't3',
      't1',
      't2',
    ]);
  });

  it('ignores ids not present and preserves missing teams at the end', () => {
    useAuthStore.setState({
      teams: new Map([
        ['t1', { token: '1', user: {} as any, teamInfo: {}, baseUrl: 'a' }],
        ['t2', { token: '2', user: {} as any, teamInfo: {}, baseUrl: 'b' }],
      ]),
    });
    useAuthStore.getState().setTeamOrder(['t2', 'unknown']);
    expect(Array.from(useAuthStore.getState().teams.keys())).toEqual([
      't2',
      't1',
    ]);
  });
});
```

Adjust `{} as any` casts to match the real `TeamEntry` shape if stricter typing rejects it.

- [ ] **Step 3: Run failing test**

`cd client && npx vitest run src/stores/authStore.test.ts`
Expected: FAIL — `setTeamOrder is not a function`.

- [ ] **Step 4: Implement**

In `client/src/stores/authStore.ts`:
1. Add `setTeamOrder: (ids: string[]) => void` to the store interface.
2. Implement:
   ```typescript
   setTeamOrder: (ids) =>
     set((state) => {
       const next = new Map<string, typeof state.teams extends Map<string, infer V> ? V : never>();
       for (const id of ids) {
         const entry = state.teams.get(id);
         if (entry) next.set(id, entry);
       }
       for (const [id, entry] of state.teams) {
         if (!next.has(id)) next.set(id, entry);
       }
       return { teams: next };
     }),
   ```
   (Use the actual `TeamEntry` type already defined in the file rather than the conditional.)

- [ ] **Step 5: Run test**

`cd client && npx vitest run src/stores/authStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/authStore.ts client/src/stores/authStore.test.ts
git commit -m "feat(auth): add setTeamOrder action for rail drag-reorder"
```

---

### Task 2: Create `TeamRailContextMenu` component (TDD)

**Files:**
- Create: `client/src/components/TeamSidebar/TeamRailContextMenu.tsx`
- Create: `client/src/components/TeamSidebar/TeamRailContextMenu.css`
- Create: `client/src/components/TeamSidebar/TeamRailContextMenu.test.tsx`

- [ ] **Step 1: Write the test**

```typescript
// TeamRailContextMenu.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TeamRailContextMenu from './TeamRailContextMenu';

describe('TeamRailContextMenu', () => {
  it('renders 5 menu items when open', () => {
    render(
      <TeamRailContextMenu
        x={100}
        y={100}
        onClose={() => {}}
        onSettings={() => {}}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
    expect(screen.getByText(/invites/i)).toBeInTheDocument();
    expect(screen.getByText(/federation/i)).toBeInTheDocument();
    expect(screen.getByText(/mark all read/i)).toBeInTheDocument();
    expect(screen.getByText(/leave/i)).toBeInTheDocument();
  });

  it('calls handlers and closes on item click', () => {
    const onSettings = vi.fn();
    const onClose = vi.fn();
    render(
      <TeamRailContextMenu
        x={0}
        y={0}
        onClose={onClose}
        onSettings={onSettings}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/settings/i));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <TeamRailContextMenu
        x={0}
        y={0}
        onClose={onClose}
        onSettings={() => {}}
        onInvites={() => {}}
        onFederation={() => {}}
        onMarkAllRead={() => {}}
        onLeave={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run failing**

`cd client && npx vitest run src/components/TeamSidebar/TeamRailContextMenu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// TeamRailContextMenu.tsx
import { useEffect } from 'react';
import './TeamRailContextMenu.css';

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  onSettings: () => void;
  onInvites: () => void;
  onFederation: () => void;
  onMarkAllRead: () => void;
  onLeave: () => void;
}

export default function TeamRailContextMenu({
  x,
  y,
  onClose,
  onSettings,
  onInvites,
  onFederation,
  onMarkAllRead,
  onLeave,
}: Readonly<Props>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const wrap = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="team-rail-menu"
      role="menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button role="menuitem" onClick={wrap(onSettings)}>Settings</button>
      <button role="menuitem" onClick={wrap(onInvites)}>Invites</button>
      <button role="menuitem" onClick={wrap(onFederation)}>Federation</button>
      <button role="menuitem" onClick={wrap(onMarkAllRead)}>Mark all read</button>
      <button role="menuitem" className="danger" onClick={wrap(onLeave)}>Leave</button>
    </div>
  );
}
```

```css
/* TeamRailContextMenu.css */
.team-rail-menu {
  position: fixed;
  background: var(--surface, var(--bg-floating));
  border: 1px solid var(--accent, var(--brand-500));
  box-shadow: var(--shadow-2, 0 12px 30px rgba(0, 0, 0, 0.6));
  border-radius: var(--r-md, 2px);
  padding: 4px;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  z-index: var(--z-tooltip);
  font-family: var(--font-ui);
  font-size: var(--font-size-xs);
}

.team-rail-menu button {
  background: none;
  border: none;
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  color: var(--fg, var(--text-primary));
  font-family: inherit;
  font-size: inherit;
  border-radius: var(--r-sm, 0);
}

.team-rail-menu button:hover {
  background: var(--accent-soft, rgba(124, 255, 142, 0.14));
  color: var(--accent, var(--brand-500));
}

.team-rail-menu button.danger {
  color: var(--danger, var(--text-danger));
}

.team-rail-menu button.danger:hover {
  background: rgba(255, 110, 110, 0.12);
}
```

- [ ] **Step 4: Run tests**

`cd client && npx vitest run src/components/TeamSidebar/TeamRailContextMenu.test.tsx`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TeamSidebar/TeamRailContextMenu.*
git commit -m "feat(rail): add TeamRailContextMenu component"
```

---

### Task 3: Rewrite `TeamSidebar.css` for Mesh visuals

**Files:**
- Modify: `client/src/components/TeamSidebar/TeamSidebar.css` (full replace)

Replace the entire file with:

```css
.team-sidebar {
  width: 100%;
  background: var(--bg-2, var(--bg-tertiary));
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  gap: 6px;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  scrollbar-width: none;
}

.team-sidebar::-webkit-scrollbar { display: none; }

.team-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 1;
  width: 100%;
  padding: 0;
}

.team-icon-wrapper {
  position: relative;
  width: 40px;
  height: 40px;
  transition: transform 0.12s var(--ease-out, ease-out);
}

.team-icon-wrapper:hover {
  transform: translateY(-1px);
}

.team-icon-wrapper[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  padding: 2px 6px;
  background: var(--surface, var(--bg-floating));
  border: 1px solid var(--accent, var(--brand-500));
  color: var(--fg, var(--text-primary));
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease-out;
  z-index: var(--z-tooltip);
}

.team-icon-wrapper[data-tooltip]:hover::after { opacity: 1; }

/* Active left bar at -10px (full 40px icon height — preserves the
   animations-motion.browser.test.tsx assertion of height: 40px) */
.team-icon-wrapper.active::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 0;
  height: 40px;
  width: 2px;
  background: var(--fg, white);
}

/* Default (non-active) wrapper has no left bar — preserves the
   animations-motion.browser.test.tsx assertion of height: 0 */
.team-icon-wrapper::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 50%;
  height: 0;
  width: 2px;
  background: var(--fg, white);
}

.team-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--r-md, 2px);
  border: 1px solid var(--hairline, transparent);
  padding: 0;
  font-family: var(--font-display);
  background: var(--surface-2, var(--bg-primary));
  color: var(--fg-2, var(--brand-500));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: var(--fw-display, 700);
  cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out, border-color 0.12s ease-out;
  position: relative;
}

.team-icon:hover {
  background: var(--surface-hi, var(--bg-floating));
  color: var(--fg, white);
  border-color: var(--accent, var(--brand-500));
}

.team-icon.active {
  background: var(--accent, var(--brand-500));
  color: var(--accent-ink, white);
  border-color: var(--accent, var(--brand-500));
}

/* Federation amber dot */
.team-federated-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn, var(--yellow-300));
  box-shadow: 0 0 0 2px var(--bg-2, var(--bg-tertiary));
}

/* Unread badge */
.team-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--danger);
  color: var(--accent-ink, white);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  border: 2px solid var(--bg-2, var(--bg-tertiary));
  line-height: 1;
}

/* Server group + separator + label */
.server-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.server-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--fg-3, var(--text-muted));
  letter-spacing: 0.06em;
  max-width: 40px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  opacity: 0.7;
  cursor: default;
}

.team-separator {
  width: 24px;
  height: 1px;
  background: var(--hairline, var(--bg-modifier-active));
  margin: 4px 0;
}

/* + Add team — dashed accent */
.team-add {
  width: 40px;
  height: 40px;
  border-radius: var(--r-md, 2px);
  background: transparent;
  color: var(--accent, var(--green-360));
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border: 1px dashed var(--accent, var(--green-360));
  padding: 0;
  margin-bottom: 8px;
  transition: background 0.12s ease-out, color 0.12s ease-out;
  box-sizing: border-box;
}

.team-add:hover {
  background: var(--accent-soft, rgba(124, 255, 142, 0.14));
  color: var(--accent-2, var(--green-360));
}

/* Drag-reorder visual states */
.team-icon-wrapper[data-dragging='true'] {
  opacity: 0.4;
}

.team-icon-wrapper[data-drop-target='true'] .team-icon {
  outline: 2px solid var(--accent, var(--green-360));
  outline-offset: 2px;
}

/* Mobile fallback — keep current behavior */
@media (max-width: 767px) {
  .team-sidebar {
    width: 100%;
    height: auto;
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px;
    gap: 12px;
  }
  .team-list {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 12px;
  }
  .team-icon-wrapper.active::before { display: none; }
  .server-group {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 8px;
  }
  .server-label { width: 100%; max-width: none; text-align: left; }
  .team-separator { width: 100%; height: 1px; margin: 4px 0; }
}
```

- [ ] **Step 1: Replace the file**

Use `Write` to overwrite `client/src/components/TeamSidebar/TeamSidebar.css` with the block above.

- [ ] **Step 2: Build sanity check**

`cd client && npx vite build --mode development 2>&1 | tail -5`
Expected: `✓ built`.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/TeamSidebar/TeamSidebar.css
git commit -m "style(rail): mesh visual treatment for team sidebar"
```

---

### Task 4: Refactor `TeamSidebar.tsx` with drag-reorder + context menu

**Files:**
- Modify: `client/src/components/TeamSidebar/TeamSidebar.tsx`

Replace its contents:

```typescript
import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { IconPlus } from '@tabler/icons-react';
import { useAuthStore } from '../../stores/authStore';
import { useTeamStore } from '../../stores/teamStore';
import { useUnreadStore } from '../../stores/unreadStore';
import TeamRailContextMenu from './TeamRailContextMenu';
import './TeamSidebar.css';

interface MenuState {
  teamId: string;
  x: number;
  y: number;
}

export default function TeamSidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { teams, servers, setTeamOrder } = useAuthStore();
  const { activeTeamId, setActiveTeam, teams: teamMap, channels: teamChannels } = useTeamStore();
  const unreadCounts = useUnreadStore((s) => s.counts);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragOriginRef = useRef<string | null>(null);

  const serverGroups: { serverId: string; serverUrl: string; teamIds: string[] }[] = [];
  const ungrouped: string[] = [];
  const teamEntries = Array.from(teams.entries());
  const assignedTeams = new Set<string>();

  servers.forEach((server, serverId) => {
    const validTeamIds = server.teamIds.filter((id) => teams.has(id));
    if (validTeamIds.length > 0) {
      serverGroups.push({ serverId, serverUrl: server.baseUrl, teamIds: validTeamIds });
      validTeamIds.forEach((id) => assignedTeams.add(id));
    }
  });
  teamEntries.forEach(([teamId]) => {
    if (!assignedTeams.has(teamId)) ungrouped.push(teamId);
  });

  const handleDragStart = useCallback((teamId: string) => {
    setDraggingId(teamId);
    dragOriginRef.current = teamId;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, teamId: string) => {
    e.preventDefault();
    if (draggingId && draggingId !== teamId) setDropTargetId(teamId);
  }, [draggingId]);

  const handleDrop = useCallback((targetId: string) => {
    const source = dragOriginRef.current;
    if (!source || source === targetId) {
      setDraggingId(null);
      setDropTargetId(null);
      return;
    }
    const order = Array.from(teams.keys());
    const fromIdx = order.indexOf(source);
    const toIdx = order.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) {
      setDraggingId(null);
      setDropTargetId(null);
      return;
    }
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, source);
    setTeamOrder(order);
    setDraggingId(null);
    setDropTargetId(null);
    dragOriginRef.current = null;
  }, [teams, setTeamOrder]);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDropTargetId(null);
    dragOriginRef.current = null;
  }, []);

  const renderTeamIcon = (teamId: string) => {
    const entry = teams.get(teamId);
    if (!entry) return null;
    const freshTeam = teamMap?.get(teamId);
    const authInfo = entry.teamInfo;
    const name = freshTeam?.name ?? (authInfo?.name as string | undefined) ?? teamId;
    const initial = name.charAt(0).toUpperCase();
    const isActive = teamId === activeTeamId;
    const federated = (authInfo as { federated?: boolean } | undefined)?.federated === true;

    const teamChannelList = teamChannels.get(teamId) ?? [];
    const teamUnreadCount = teamChannelList.reduce(
      (sum, ch) => sum + (unreadCounts[ch.id] ?? 0),
      0,
    );

    return (
      <div
        key={teamId}
        className={`team-icon-wrapper ${isActive ? 'active' : ''}`}
        data-tooltip={name}
        data-dragging={draggingId === teamId || undefined}
        data-drop-target={dropTargetId === teamId || undefined}
        draggable
        onDragStart={() => handleDragStart(teamId)}
        onDragOver={(e) => handleDragOver(e, teamId)}
        onDrop={() => handleDrop(teamId)}
        onDragEnd={handleDragEnd}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ teamId, x: e.clientX, y: e.clientY });
        }}
      >
        <button
          className={`team-icon ${isActive ? 'active' : ''}`}
          title={name}
          onClick={() => setActiveTeam(teamId)}
        >
          {initial}
        </button>
        {federated && <span className="team-federated-dot" aria-label="Federated peer" />}
        {teamUnreadCount > 0 && (
          <span className="team-badge">{teamUnreadCount > 99 ? '99+' : teamUnreadCount}</span>
        )}
      </div>
    );
  };

  const hasMultipleServers =
    serverGroups.length > 1 || (serverGroups.length >= 1 && ungrouped.length > 0);

  return (
    <div className="team-sidebar">
      <div className="team-list">
        {serverGroups.map((group, i) => (
          <div key={group.serverId} className="server-group">
            {hasMultipleServers && (
              <div className="server-label" title={group.serverUrl}>
                {group.serverId.split('.')[0]}
              </div>
            )}
            {group.teamIds.map(renderTeamIcon)}
            {hasMultipleServers && i < serverGroups.length - 1 && (
              <div className="team-separator" />
            )}
          </div>
        ))}
        {ungrouped.length > 0 && serverGroups.length > 0 && hasMultipleServers && (
          <div className="team-separator" />
        )}
        {ungrouped.map(renderTeamIcon)}
        {teamEntries.length > 0 && <div className="team-separator" />}
      </div>
      <button
        className="team-add"
        onClick={() => navigate('/join')}
        title={t('sidebar.addTeam')}
      >
        <IconPlus size={20} stroke={1.75} />
      </button>

      {menu && (
        <TeamRailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onSettings={() => navigate('/app/settings')}
          onInvites={() => navigate('/app/settings')}
          onFederation={() => navigate('/app/settings')}
          onMarkAllRead={() => console.warn('TODO: mark-all-read for team', menu.teamId)}
          onLeave={() => console.warn('TODO: leave team', menu.teamId)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 1: Replace the file**

Use `Write` to overwrite `TeamSidebar.tsx`.

- [ ] **Step 2: Type-check**

`cd client && npx tsc -b --noEmit 2>&1 | tail -10`
Expected: clean. If `(authInfo as { federated?: boolean })` errors, adjust the cast to match the actual `teamInfo` type used in `authStore`.

- [ ] **Step 3: Run existing TeamSidebar tests (expect 1–2 failures)**

`cd client && npx vitest run src/components/TeamSidebar/`
Expected: most pass; tests asserting `team-icon` width or border radius may need updating in Task 5.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/TeamSidebar/TeamSidebar.tsx
git commit -m "feat(rail): drag-reorder + context menu + federation dot"
```

---

### Task 5: Update `TeamSidebar.test.tsx` for new DOM + behavior

**Files:**
- Modify: `client/src/components/TeamSidebar/TeamSidebar.test.tsx`

- [ ] **Step 1: Run tests, capture failures**

`cd client && npx vitest run src/components/TeamSidebar/TeamSidebar.test.tsx 2>&1 | tail -25`

Note which existing tests broke and which still pass.

- [ ] **Step 2: Add new tests**

Append to the existing file:

```typescript
  it('opens context menu on right-click with all 5 items', () => {
    render(<TeamSidebar />);
    const icon = screen.getByText('A').closest('.team-icon-wrapper')!;
    fireEvent.contextMenu(icon);
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
    expect(screen.getByText(/invites/i)).toBeInTheDocument();
    expect(screen.getByText(/federation/i)).toBeInTheDocument();
    expect(screen.getByText(/mark all read/i)).toBeInTheDocument();
    expect(screen.getByText(/leave/i)).toBeInTheDocument();
  });

  it('shows federation amber dot when team is federated', () => {
    const teams = new Map([
      ['team-fed', { token: 't', user: {} as any, teamInfo: { name: 'Fed', federated: true } as any, baseUrl: 'https://x.example.com' }],
    ]);
    useAuthStore.setState({ teams, servers: new Map() });
    useTeamStore.setState({ activeTeamId: 'team-fed', teams: new Map() });
    const { container } = render(<TeamSidebar />);
    expect(container.querySelector('.team-federated-dot')).toBeInTheDocument();
  });

  it('drag from team-1 to team-2 reorders via setTeamOrder', () => {
    render(<TeamSidebar />);
    const a = screen.getByText('A').closest('.team-icon-wrapper')!;
    const b = screen.getByText('B').closest('.team-icon-wrapper')!;
    fireEvent.dragStart(a);
    fireEvent.dragOver(b);
    fireEvent.drop(b);
    // After: team-2 should come first
    expect(Array.from(useAuthStore.getState().teams.keys())).toEqual([
      'team-2',
      'team-1',
    ]);
  });
```

- [ ] **Step 3: Run all TeamSidebar tests**

`cd client && npx vitest run src/components/TeamSidebar/`
Expected: PASS for all (existing + new). If an old test fails due to the size change (e.g. asserting `.team-icon` style width), adjust the assertion to match the new 40px.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/TeamSidebar/TeamSidebar.test.tsx
git commit -m "test(rail): cover drag-reorder, context menu, federated dot"
```

---

### Task 6: Verify, lint, smoke

- [ ] **Step 1: Full suite**

`cd client && npm test -- --run 2>&1 | tail -8`
Expected: 1912 + new tests pass, 0 failures.

- [ ] **Step 2: Type-check + lint**

```
cd client && npx tsc -b --noEmit
cd client && npm run lint 2>&1 | tail -5
```
Expected: clean; warnings count unchanged from baseline (15).

- [ ] **Step 3: Manual smoke**

`cd client && npm run dev` → <http://localhost:8888>. With multiple teams, drag one to reorder. Right-click an icon to open the context menu. Verify federation dot appears if `teamInfo.federated === true` is mocked in DevTools.

- [ ] **Step 4: Final commit if any straggler files**

```bash
git status
git log --oneline main..HEAD | wc -l
```
Expected: total commits ≈ 23 (17 prior + 6 from this plan).

---

## Done When

- Server rail icons are 40×40 with 2px radius, mono-styled tooltip.
- Active team shows a white left bar at -10px and accent fill.
- Drag-reorder updates the persisted team order.
- Right-click opens a 5-item context menu (Settings / Invites / Federation / Mark all read / Leave).
- Federation amber dot renders when `teamInfo.federated === true`.
- `+ Add team` is a dashed-accent button (still routes to `/join`).
- All tests pass; type-check + lint clean.
