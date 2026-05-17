# Mesh Layout Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `AppLayout` (desktop branch) from the current nested-flex layout to the Mesh 4-column CSS Grid (rail | sidebar | main | members), make the members panel resizable, and add toggleable top/bottom status-bar slots as empty stub components that later plans (#3 server rail, #8 mesh chrome) will fill in. Mobile branch is left unchanged.

**Architecture:**
The existing `client/src/pages/AppLayout.tsx` mixes layout, auth/WS lifecycle, crypto, presence wiring, modal management, and ~30 effects into one 557-line component. This plan only touches its rendering JSX + CSS — every hook and side-effect stays where it is. The new layout uses `display: grid` with `grid-template-columns: var(--rail-w) var(--sidebar-w) 1fr var(--members-w)` and optional `grid-template-rows: auto 1fr auto` when top/bottom bars are enabled. The voice-controls + user-panel pair (previously a sibling of both rail and sidebar via `.left-panels-bottom`) moves into the channel-sidebar column so the rail occupies a full-height column on its own — this matches the handoff's "rail = 60px full-height stripe" model. Widths and bar visibility live in a new `useLayoutStore` (Zustand, persisted) keyed off the existing `dilla-user-settings` pattern. Each resize handle is the existing `ResizeHandle` component reused, just wired to the new store. Top/bottom bars are skeleton components (`MeshTopBar` / `MeshBottomBar`) that render a height-correct `<header>` / `<footer>` with placeholder content — later plans replace their innards.

**Tech Stack:** React 19 + TypeScript, CSS Grid, Zustand (`persist` middleware), Vitest jsdom + browser test runner. No new deps.

**Scope guardrails:**
- ❌ No changes to mobile branch (`isMobile === true`) — `MobileTabBar` + `.app-layout-main.mobile` stay intact
- ❌ No content inside `MeshTopBar` / `MeshBottomBar` beyond placeholder text + correct height
- ❌ No changes to behavior of channel switching, DM mode, thread panel, modals, keyboard shortcuts, WS handlers, or auth
- ❌ No further decomposition of `AppLayout.tsx` — file stays one component (split is a separate follow-up plan if needed)
- ❌ No content inside the server rail (`TeamSidebar` keeps current internals — full rail redesign is plan #3)
- ✅ Rail width becomes 60px (was 72px) via the `--rail-w` token — `TeamSidebar`'s CSS currently uses `--team-sidebar-width: 72px`; that variable gets repointed
- ✅ MemberList becomes resizable via a second `ResizeHandle`
- ✅ Top + bottom bars are off by default; toggling exposed only via store setter (UI for the toggle lands in plan #7 settings modal)
- ✅ Desktop layout in legacy themes (dark/light/minimal) keeps working — grid + new tokens degrade gracefully

---

## File Structure

**Create:**
- `client/src/stores/layoutStore.ts` — Zustand store for `sidebarWidth`, `membersWidth`, `topBarEnabled`, `bottomBarEnabled` + clamped setters
- `client/src/stores/layoutStore.test.ts` — defaults, clamping, setters
- `client/src/components/MeshChrome/MeshTopBar.tsx` — 32px header skeleton
- `client/src/components/MeshChrome/MeshTopBar.css` — styles
- `client/src/components/MeshChrome/MeshTopBar.test.tsx` — render-when-enabled, height-from-token
- `client/src/components/MeshChrome/MeshBottomBar.tsx` — 26px footer skeleton
- `client/src/components/MeshChrome/MeshBottomBar.css` — styles
- `client/src/components/MeshChrome/MeshBottomBar.test.tsx` — render-when-enabled, height-from-token

**Modify:**
- `client/src/styles/base-tokens.css` — add `--rail-w`, `--sidebar-w-default`, `--members-w-default`, `--topbar-h`, `--bottombar-h`; repoint `--team-sidebar-width` to `--rail-w`
- `client/src/components/ResizeHandle/ResizeHandle.tsx` — add optional `side?: 'left' | 'right'` prop (Task 4.5; small standalone change that lands before the AppLayout refactor)
- `client/src/pages/AppLayout.tsx` — desktop branch JSX only (lines 449–548 region); rail column becomes standalone, voice+user move inside channel-sidebar column, members ResizeHandle added, MeshTopBar / MeshBottomBar slots wrap the grid. Also remove the `width: channelWidth` inline style on `.channel-sidebar` (line 408) — the width now comes from the grid track.
- `client/src/pages/AppLayout.css` — replace `.app-layout-main` flex rules (note: currently implicit `flex-direction: row`; new rules use `flex-direction: column` so top-bar / grid / bottom-bar stack vertically); remove `.left-panels`/`.left-panels-top`/`.left-panels-bottom` blocks (no longer used in desktop); add `.app-grid-shell` + new column rules; preserve mobile media query as-is
- `client/src/pages/AppLayout.test.tsx` — update three structure-asserting tests (`renders all desktop layout components`, `renders left-panels and resize-handle on desktop` in responsive, the resize-handle mobile-hides) and add 3 new tests for the grid shell
- `client/src/pages/AppLayout.responsive.test.tsx` — same surface as above
- `client/src/pages/AppLayout.responsive.browser.test.tsx` — this file contains inline JSX fixtures referencing `.left-panels`/`.left-panels-top`/`.left-panels-bottom` and asserts `display: flex` on `.left-panels`. Rewrite those fixtures to use `.app-grid-shell` + `.app-grid-rail` + `.app-grid-sidebar` and assert `display: grid` on `.app-grid-shell`. Done in Task 7.5 (new).

---

## Reference Token Set

These extend `base-tokens.css` (independent of theme — `theme-default.css` already inherits the structural layer):

```
--rail-w:            60px
--sidebar-w-default: 240px   /* min 200, max 360 — enforced in layoutStore */
--members-w-default: 232px   /* min 180, max 340 — enforced in layoutStore */
--topbar-h:          32px
--bottombar-h:       26px
```

The currently-defined `--team-sidebar-width: 72px` in `base-tokens.css:60` becomes `var(--rail-w)`. `--channel-sidebar-width: 240px` and `--member-sidebar-width: 240px` (line 61–62) remain but the live runtime width comes from the layout store (inline `style` on grid container) — the tokens are CSS fallbacks for first paint.

---

### Task 1: Add layout-width tokens to base-tokens.css

**Files:**
- Modify: `client/src/styles/base-tokens.css` (around lines 58–73, the "Layout dimensions" block)

- [ ] **Step 1: Write the failing test**

Append to `client/src/themes/themes.test.ts` (existing file from plan #1) — these assertions live there since it's the "token system" test file:

```typescript
describe('layout-width tokens', () => {
  it('base-tokens.css defines mesh rail + bar tokens', async () => {
    // Read the CSS file directly to assert tokens are declared
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const css = await fs.readFile(
      path.resolve(__dirname, '../styles/base-tokens.css'),
      'utf8',
    );
    expect(css).toMatch(/--rail-w:\s*60px/);
    expect(css).toMatch(/--sidebar-w-default:\s*240px/);
    expect(css).toMatch(/--members-w-default:\s*232px/);
    expect(css).toMatch(/--topbar-h:\s*32px/);
    expect(css).toMatch(/--bottombar-h:\s*26px/);
    // --team-sidebar-width must alias to --rail-w (not a hard 72px)
    expect(css).toMatch(/--team-sidebar-width:\s*var\(--rail-w\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/themes/themes.test.ts`
Expected: FAIL — last group throws on the regex mismatch (`--rail-w` not defined; `--team-sidebar-width: 72px` still literal).

- [ ] **Step 3: Edit `client/src/styles/base-tokens.css`**

In the `:root { ... }` block at the top of the file, find the "Layout dimensions" comment block. Replace `--team-sidebar-width: 72px;` with `--team-sidebar-width: var(--rail-w);`. Add a new block immediately before the existing "Layout dimensions" header:

```css
  /* Mesh shell dimensions */
  --rail-w: 60px;
  --sidebar-w-default: 240px;
  --members-w-default: 232px;
  --topbar-h: 32px;
  --bottombar-h: 26px;
```

The `--team-sidebar-width: var(--rail-w);` line replaces the old `72px` literal. Existing components reading `--team-sidebar-width` (e.g. `TeamSidebar.css`) now compute to 60px without code changes.

- [ ] **Step 4: Run test**

Run: `cd client && npx vitest run src/themes/themes.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add client/src/styles/base-tokens.css client/src/themes/themes.test.ts
git commit -m "feat(theme): add Mesh shell dimension tokens (rail/bars)"
```

---

### Task 2: Create `layoutStore` with clamped setters + persistence

**Files:**
- Create: `client/src/stores/layoutStore.ts`
- Create: `client/src/stores/layoutStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/stores/layoutStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useLayoutStore } from './layoutStore';

beforeEach(() => {
  useLayoutStore.setState({
    sidebarWidth: 240,
    membersWidth: 232,
    topBarEnabled: false,
    bottomBarEnabled: false,
  });
});

describe('layoutStore', () => {
  it('exposes mesh shell defaults', () => {
    const s = useLayoutStore.getState();
    expect(s.sidebarWidth).toBe(240);
    expect(s.membersWidth).toBe(232);
    expect(s.topBarEnabled).toBe(false);
    expect(s.bottomBarEnabled).toBe(false);
  });

  it('setSidebarWidth clamps to [200, 360]', () => {
    const { setSidebarWidth } = useLayoutStore.getState();
    setSidebarWidth(100);
    expect(useLayoutStore.getState().sidebarWidth).toBe(200);
    setSidebarWidth(500);
    expect(useLayoutStore.getState().sidebarWidth).toBe(360);
    setSidebarWidth(280);
    expect(useLayoutStore.getState().sidebarWidth).toBe(280);
  });

  it('setMembersWidth clamps to [180, 340]', () => {
    const { setMembersWidth } = useLayoutStore.getState();
    setMembersWidth(50);
    expect(useLayoutStore.getState().membersWidth).toBe(180);
    setMembersWidth(900);
    expect(useLayoutStore.getState().membersWidth).toBe(340);
    setMembersWidth(220);
    expect(useLayoutStore.getState().membersWidth).toBe(220);
  });

  it('nudgeSidebarWidth applies clamped delta', () => {
    const { nudgeSidebarWidth } = useLayoutStore.getState();
    nudgeSidebarWidth(80);
    expect(useLayoutStore.getState().sidebarWidth).toBe(320);
    nudgeSidebarWidth(-1000);
    expect(useLayoutStore.getState().sidebarWidth).toBe(200);
  });

  it('nudgeMembersWidth applies clamped delta', () => {
    const { nudgeMembersWidth } = useLayoutStore.getState();
    nudgeMembersWidth(50);
    expect(useLayoutStore.getState().membersWidth).toBe(282);
    nudgeMembersWidth(-1000);
    expect(useLayoutStore.getState().membersWidth).toBe(180);
  });

  it('toggleTopBar / toggleBottomBar flip boolean state', () => {
    const { toggleTopBar, toggleBottomBar } = useLayoutStore.getState();
    toggleTopBar();
    expect(useLayoutStore.getState().topBarEnabled).toBe(true);
    toggleTopBar();
    expect(useLayoutStore.getState().topBarEnabled).toBe(false);
    toggleBottomBar();
    expect(useLayoutStore.getState().bottomBarEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/stores/layoutStore.test.ts`
Expected: FAIL — import resolution error (`Cannot find module './layoutStore'`).

- [ ] **Step 3: Create `client/src/stores/layoutStore.ts`**

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 360;
const MEMBERS_MIN = 180;
const MEMBERS_MAX = 340;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

interface LayoutStore {
  sidebarWidth: number;
  membersWidth: number;
  topBarEnabled: boolean;
  bottomBarEnabled: boolean;

  setSidebarWidth: (v: number) => void;
  setMembersWidth: (v: number) => void;
  nudgeSidebarWidth: (delta: number) => void;
  nudgeMembersWidth: (delta: number) => void;
  toggleTopBar: () => void;
  toggleBottomBar: () => void;
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set, get) => ({
      sidebarWidth: 240,
      membersWidth: 232,
      topBarEnabled: false,
      bottomBarEnabled: false,

      setSidebarWidth: (v) =>
        set({ sidebarWidth: clamp(v, SIDEBAR_MIN, SIDEBAR_MAX) }),
      setMembersWidth: (v) =>
        set({ membersWidth: clamp(v, MEMBERS_MIN, MEMBERS_MAX) }),
      nudgeSidebarWidth: (delta) =>
        set({
          sidebarWidth: clamp(
            get().sidebarWidth + delta,
            SIDEBAR_MIN,
            SIDEBAR_MAX,
          ),
        }),
      nudgeMembersWidth: (delta) =>
        set({
          membersWidth: clamp(
            get().membersWidth + delta,
            MEMBERS_MIN,
            MEMBERS_MAX,
          ),
        }),
      toggleTopBar: () => set({ topBarEnabled: !get().topBarEnabled }),
      toggleBottomBar: () => set({ bottomBarEnabled: !get().bottomBarEnabled }),
    }),
    { name: 'dilla-layout' },
  ),
);
```

- [ ] **Step 4: Run test**

Run: `cd client && npx vitest run src/stores/layoutStore.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/layoutStore.ts client/src/stores/layoutStore.test.ts
git commit -m "feat(layout): add layoutStore for resizable widths + bar toggles"
```

---

### Task 3: Create `MeshTopBar` stub component

**Files:**
- Create: `client/src/components/MeshChrome/MeshTopBar.tsx`
- Create: `client/src/components/MeshChrome/MeshTopBar.css`
- Create: `client/src/components/MeshChrome/MeshTopBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// client/src/components/MeshChrome/MeshTopBar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MeshTopBar from './MeshTopBar';

describe('MeshTopBar', () => {
  it('renders a top-bar landmark with placeholder content', () => {
    render(<MeshTopBar />);
    const bar = screen.getByRole('banner', { name: /mesh top bar/i });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('mesh-top-bar');
  });

  it('applies --topbar-h height via inline style or CSS class', () => {
    const { container } = render(<MeshTopBar />);
    const bar = container.querySelector('.mesh-top-bar') as HTMLElement;
    expect(bar).toBeTruthy();
    // We assert the class is present; computed height comes from CSS var
    expect(bar.className).toContain('mesh-top-bar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/MeshChrome/MeshTopBar.test.tsx`
Expected: FAIL — `Cannot find module './MeshTopBar'`.

- [ ] **Step 3: Create the component**

`client/src/components/MeshChrome/MeshTopBar.tsx`:

```typescript
import './MeshTopBar.css';

export default function MeshTopBar() {
  return (
    <header
      className="mesh-top-bar"
      role="banner"
      aria-label="Mesh top bar"
    >
      <span className="mesh-top-bar-placeholder">DILLA · MESH OK</span>
    </header>
  );
}
```

`client/src/components/MeshChrome/MeshTopBar.css`:

```css
.mesh-top-bar {
  height: var(--topbar-h);
  min-height: var(--topbar-h);
  display: flex;
  align-items: center;
  padding: 0 var(--spacing-md);
  background: var(--bg-2, var(--bg-secondary));
  border-bottom: 1px solid var(--hairline, var(--divider));
  font-family: var(--font-mono);
  font-size: var(--font-size-micro);
  color: var(--fg-2, var(--text-secondary));
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.mesh-top-bar-placeholder {
  opacity: 0.7;
}
```

- [ ] **Step 4: Run test**

Run: `cd client && npx vitest run src/components/MeshChrome/MeshTopBar.test.tsx`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/MeshChrome/MeshTopBar.tsx \
        client/src/components/MeshChrome/MeshTopBar.css \
        client/src/components/MeshChrome/MeshTopBar.test.tsx
git commit -m "feat(chrome): add MeshTopBar skeleton component"
```

---

### Task 4: Create `MeshBottomBar` stub component

**Files:**
- Create: `client/src/components/MeshChrome/MeshBottomBar.tsx`
- Create: `client/src/components/MeshChrome/MeshBottomBar.css`
- Create: `client/src/components/MeshChrome/MeshBottomBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// client/src/components/MeshChrome/MeshBottomBar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MeshBottomBar from './MeshBottomBar';

describe('MeshBottomBar', () => {
  it('renders a content-info landmark with placeholder content', () => {
    render(<MeshBottomBar />);
    const bar = screen.getByRole('contentinfo', { name: /mesh bottom bar/i });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass('mesh-bottom-bar');
  });

  it('applies --bottombar-h height class', () => {
    const { container } = render(<MeshBottomBar />);
    const bar = container.querySelector('.mesh-bottom-bar') as HTMLElement;
    expect(bar).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/components/MeshChrome/MeshBottomBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the component**

`client/src/components/MeshChrome/MeshBottomBar.tsx`:

```typescript
import './MeshBottomBar.css';

export default function MeshBottomBar() {
  return (
    <footer
      className="mesh-bottom-bar"
      role="contentinfo"
      aria-label="Mesh bottom bar"
    >
      <span className="mesh-bottom-bar-placeholder">node · peers · lamport · e2e</span>
    </footer>
  );
}
```

`client/src/components/MeshChrome/MeshBottomBar.css`:

```css
.mesh-bottom-bar {
  height: var(--bottombar-h);
  min-height: var(--bottombar-h);
  display: flex;
  align-items: center;
  padding: 0 var(--spacing-md);
  background: var(--bg-2, var(--bg-secondary));
  border-top: 1px solid var(--hairline, var(--divider));
  font-family: var(--font-mono);
  font-size: var(--font-size-micro);
  color: var(--fg-2, var(--text-secondary));
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex-shrink: 0;
}

.mesh-bottom-bar-placeholder {
  opacity: 0.7;
}
```

- [ ] **Step 4: Run test**

Run: `cd client && npx vitest run src/components/MeshChrome/MeshBottomBar.test.tsx`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/MeshChrome/MeshBottomBar.tsx \
        client/src/components/MeshChrome/MeshBottomBar.css \
        client/src/components/MeshChrome/MeshBottomBar.test.tsx
git commit -m "feat(chrome): add MeshBottomBar skeleton component"
```

---

### Task 4.5: Add `side` prop to `ResizeHandle`

**Why this is a standalone task:** the existing `ResizeHandle.tsx` is typed strictly (no implicit `any`); passing an unknown prop produces a TypeScript compile error at `tsc -b --noEmit`. We need the prop to exist before Task 5 references it.

**Files:**
- Modify: `client/src/components/ResizeHandle/ResizeHandle.tsx`

- [ ] **Step 1: Read the current component**

Run: `cat client/src/components/ResizeHandle/ResizeHandle.tsx`

Confirm its current props interface. Expected shape (approximate): an `onResize: (delta: number) => void` callback driving a `<button>` or `<div>` with drag listeners.

- [ ] **Step 2: Extend the props interface**

Add an optional `side?: 'left' | 'right'` prop, default `'left'`. Use it only to set a `data-side` attribute on the rendered element — no behavior change. The future plan #8 will use this for cursor-direction styling.

```typescript
interface Props {
  onResize: (delta: number) => void;
  side?: 'left' | 'right';
  // ...whatever other props already exist
}

export default function ResizeHandle({ onResize, side = 'left', /* ...rest */ }: Props) {
  // ... existing implementation, just add data-side to the root element:
  return (
    <button
      data-side={side}
      // ...existing props/handlers
    />
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd client && npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 4: Run existing ResizeHandle tests (if any) + smoke**

```bash
cd client && npx vitest run src/components/ResizeHandle/
```
Expected: pass (or empty — no tests for ResizeHandle is acceptable).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ResizeHandle/ResizeHandle.tsx
git commit -m "feat(resize): add optional side prop to ResizeHandle"
```

---

### Task 5: Refactor desktop layout in `AppLayout.tsx` to CSS Grid

This is the biggest single edit. Read the current `AppLayout.tsx:455-548` block before editing — that's the desktop branch.

**Files:**
- Modify: `client/src/pages/AppLayout.tsx` (imports + desktop branch JSX)

- [ ] **Step 1: Add new imports**

In the import section near the top, add:

```typescript
import { useLayoutStore } from '../stores/layoutStore';
import MeshTopBar from '../components/MeshChrome/MeshTopBar';
import MeshBottomBar from '../components/MeshChrome/MeshBottomBar';
```

Remove `channelWidth` local state + `handleChannelResize` (lines 109–113):
```typescript
// DELETE these lines:
const [channelWidth, setChannelWidth] = useState(240);
const handleChannelResize = useCallback((delta: number) => {
  setChannelWidth(prev => Math.min(Math.max(prev + delta, 240), 400));
}, []);
```

Replace with subscription to the layout store. Right after `useCustomTheme();` near line 51, add:

```typescript
const {
  sidebarWidth,
  membersWidth,
  topBarEnabled,
  bottomBarEnabled,
  nudgeSidebarWidth,
  nudgeMembersWidth,
} = useLayoutStore();
```

Also remove the inline `width` style on `.channel-sidebar` (currently at line 408 of AppLayout.tsx). Change:
```tsx
<div className={`channel-sidebar ${isMobile ? 'mobile-fullwidth' : ''}`} style={isMobile ? undefined : { width: channelWidth }}>
```
to:
```tsx
<div className={`channel-sidebar ${isMobile ? 'mobile-fullwidth' : ''}`}>
```
The width is now supplied by the parent grid track via inline style on `.app-grid-shell` (Step 2). Mobile keeps its full-width behavior via the `.mobile-fullwidth` class.

- [ ] **Step 2: Replace the desktop JSX block**

Find the block currently at lines 449–555 — the outer fragment (`<>`), starting at line 449 with the skip-to-content link, through the closing `</>` at line 555. The replacement must preserve the **outer fragment shape**:

```
<>
  <a className="skip-to-content">...</a>
  <TitleBar />
  <div className="app-layout-main ...">
    ... desktop OR mobile branches + modals ...
  </div>
  <QuickSwitcher ... />   ← MUST remain a sibling of .app-layout-main, NOT inside it
</>
```

The current `<QuickSwitcher>` at lines 550–554 lives **outside** `.app-layout-main` for z-index/stacking reasons. Do not move it inside the new wrapper.

**Important — `MemberList` rendering rules** (replicating current behavior, not changing it):
- Non-DM channels: `MemberList` renders when `showMembers === true`, in the right-hand grid column.
- DM mode: `MemberList` does NOT render in the grid. The DM members panel is handled internally by `<DMView>` via its `showMembers` prop — that path is left untouched.

So the grid's members column is gated on `!isDMMode && showMembers` only.

Replace lines 449–555 with this exact structure:

```tsx
return (
  <>
    <a href="#main-content" className="skip-to-content">
      {t('a11y.skipToContent', 'Skip to content')}
    </a>
    <TitleBar />

    <div
      className={`app-layout-main ${isMobile ? 'mobile' : ''}`}
      data-topbar={topBarEnabled || undefined}
      data-bottombar={bottomBarEnabled || undefined}
    >
      {!isMobile && topBarEnabled && <MeshTopBar />}

      {!isMobile && (
        <div
          className="app-grid-shell"
          style={{
            gridTemplateColumns: `var(--rail-w) ${sidebarWidth}px 1fr ${
              !isDMMode && showMembers ? `${membersWidth}px` : '0px'
            }`,
          }}
        >
          <div className="app-grid-rail">
            <TeamSidebar />
          </div>

          <div className="app-grid-sidebar">
            <div className="app-grid-sidebar-top">{channelSidebarContent}</div>
            <div className="app-grid-sidebar-bottom">
              <VoiceControls />
              <UserPanel
                username={username}
                displayName={displayName}
                onSettingsClick={() => navigate('/app/user-settings')}
              />
            </div>
          </div>

          <ResizeHandle onResize={nudgeSidebarWidth} />

          <div id="main-content" className="content-wrapper">
            <div className="content-header">{renderContentHeader()}</div>
            <div className="content-body">
              <div className="content-area">{renderContentArea()}</div>
              {threadPanelOpen && activeThread && (
                <ContentErrorBoundary fallbackLabel="Thread panel failed to load.">
                  <ThreadPanel thread={activeThread} onClose={handleCloseThread} />
                </ContentErrorBoundary>
              )}
            </div>
          </div>

          {!isDMMode && showMembers && (
            <>
              <ResizeHandle onResize={nudgeMembersWidth} side="right" />
              <div className="app-grid-members">
                <MemberList />
              </div>
            </>
          )}
        </div>
      )}

      {/* Mobile branch — preserve current implementation verbatim */}
      {isMobile && mobileTab === 'teams' && (
        <div className="mobile-tab-content"><TeamSidebar /></div>
      )}
      {isMobile && mobileTab === 'channels' && (
        <div className="mobile-tab-content">{channelSidebarContent}</div>
      )}
      {isMobile && mobileTab === 'members' && (
        <div className="mobile-tab-content"><MemberList /></div>
      )}
      {isMobile && mobileTab === 'chat' && (
        <div id="main-content" className="content-wrapper">
          <div className="content-header">{renderContentHeader()}</div>
          <div className="content-body">
            <div className="content-area">{renderContentArea()}</div>
            {threadPanelOpen && activeThread && (
              <ContentErrorBoundary fallbackLabel="Thread panel failed to load.">
                <ThreadPanel thread={activeThread} onClose={handleCloseThread} />
              </ContentErrorBoundary>
            )}
          </div>
        </div>
      )}

      {isMobile && (
        <div className="mobile-bottom-controls">
          <VoiceControls />
          <UserPanel
            username={username}
            displayName={displayName}
            onSettingsClick={() => navigate('/app/user-settings')}
          />
          <MobileTabBar activeTab={mobileTab} onTabChange={setMobileTab} />
        </div>
      )}

      {!isMobile && bottomBarEnabled && <MeshBottomBar />}

      {showCreateChannel && (
        <CreateChannel
          defaultCategory={createChannelCategory}
          onClose={() => setShowCreateChannel(false)}
        />
      )}
      {showNewDM && (
        <NewDMModal
          currentUserId={currentUserId}
          onClose={() => setShowNewDM(false)}
          onDMCreated={handleDMCreated}
        />
      )}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </div>

    <QuickSwitcher
      open={quickSwitcherOpen}
      onClose={() => setQuickSwitcherOpen(false)}
      onSelect={handleQuickSwitch}
    />
  </>
);
```

Notes:
- The members grid column collapses to `0px` (not removed from the grid track) when hidden, so the grid template doesn't reflow visibly during toggle. The conditional render around `<MemberList />` still removes the DOM children, so the existing test `expect(screen.queryByTestId('member-list')).not.toBeInTheDocument()` still works.
- DM-mode behavior: when `isDMMode === true`, the members column track is `0px` and no `<MemberList />` is rendered in the grid. `<DMView>` continues to handle the DM members panel internally (no change to that path).
- The mobile branch shows `<MemberList />` only in the `mobileTab === 'members'` tab — that path is preserved verbatim from the current code.

- [ ] **Step 3: Run the AppLayout unit tests (expect failures)**

Run: `cd client && npx vitest run src/pages/AppLayout.test.tsx`
Expected: Some tests fail because DOM structure changed (specifically the ones asserting `.left-panels`, single `resize-handle`, etc.). Note which fail — they'll be fixed in Task 7.

- [ ] **Step 4: Commit (with red tests — explicit checkpoint)**

```bash
git add client/src/pages/AppLayout.tsx
git commit -m "refactor(layout): convert AppLayout desktop branch to CSS Grid"
```

This is an intentional red-state commit. Task 6 follows immediately to green it back.

---

### Task 6: Update `AppLayout.css` for the grid shell

**Files:**
- Modify: `client/src/pages/AppLayout.css`

- [ ] **Step 1: Replace the layout block**

Open `client/src/pages/AppLayout.css`. Find lines 19–53 (the `.app-layout-main`, `.left-panels`, `.left-panels-top`, `.left-panels-bottom` rules) and replace with:

```css
.app-layout-main {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg, var(--bg-tertiary));
}

/* TitleBar offset preserved */
.titlebar ~ .app-layout-main {
  margin-top: var(--titlebar-height);
  height: calc(100% - var(--titlebar-height));
}

/* 4-column grid shell — desktop only */
.app-grid-shell {
  display: grid;
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  /* gridTemplateColumns supplied inline by AppLayout for live resize */
  background: var(--bg, var(--bg-tertiary));
}

.app-grid-rail {
  grid-column: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-2, var(--bg-secondary));
  border-right: 1px solid var(--hairline, var(--divider));
  overflow: hidden;
  min-height: 0;
}

.app-grid-sidebar {
  grid-column: 2;
  display: flex;
  flex-direction: column;
  background: var(--bg-2, var(--bg-secondary));
  overflow: hidden;
  min-height: 0;
}

.app-grid-sidebar-top {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.app-grid-sidebar-bottom {
  flex-shrink: 0;
  background: linear-gradient(
    180deg,
    var(--bg-2, var(--bg-secondary)) 0%,
    var(--bg-3, var(--bg-tertiary)) 100%
  );
  border-top: 1px solid var(--hairline, var(--divider));
}

.app-grid-members {
  display: flex;
  flex-direction: column;
  background: var(--bg-2, var(--bg-secondary));
  border-left: 1px solid var(--hairline, var(--divider));
  overflow: hidden;
  min-height: 0;
}
```

The existing `.channel-sidebar` rule at line 56 must lose its hard `width: var(--channel-sidebar-width)` — the width now comes from the parent grid track. Edit `.channel-sidebar` to remove the `width` declaration but keep everything else.

- [ ] **Step 2: Type-check + dev build**

```
cd client && npx tsc -b --noEmit
cd client && npx vite build --mode development
```

Both expected clean (no new errors).

- [ ] **Step 3: Run AppLayout tests**

Run: `cd client && npx vitest run src/pages/AppLayout.test.tsx src/pages/AppLayout.responsive.test.tsx`
Expected: Most pass, but at least 2 still fail — the structure-asserting tests in Task 7 below.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AppLayout.css
git commit -m "refactor(layout): replace flex shell rules with grid shell CSS"
```

---

### Task 7: Update layout tests for the new grid structure

**Files:**
- Modify: `client/src/pages/AppLayout.test.tsx`
- Modify: `client/src/pages/AppLayout.responsive.test.tsx`

- [ ] **Step 1: Inspect failing tests**

Run: `cd client && npx vitest run src/pages/AppLayout.test.tsx src/pages/AppLayout.responsive.test.tsx 2>&1 | grep -E "(FAIL|✗)"`

The likely failures (verify before editing — list may shift):
1. `renders all desktop layout components` — asserts a single `resize-handle`; now there are two when members visible.
2. `does not show desktop left panels in mobile mode` — asserts `resize-handle` absent in mobile; the assertion still holds but the surrounding markup it inspects differs.
3. `renders left-panels and resize-handle on desktop` (responsive test) — asserts a `left-panels` class that no longer exists.

- [ ] **Step 2: Fix `AppLayout.test.tsx`**

In `client/src/pages/AppLayout.test.tsx`:

Change the `renders all desktop layout components` test (around line 297) so it accepts >=1 resize handle:
```typescript
  it('renders all desktop layout components', async () => {
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByTestId('team-sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('channel-list')).toBeInTheDocument();
      expect(screen.getByTestId('user-panel')).toBeInTheDocument();
      expect(screen.getByTestId('voice-controls')).toBeInTheDocument();
      expect(screen.getAllByTestId('resize-handle').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId('member-list')).toBeInTheDocument();
      expect(screen.getByTestId('title-bar')).toBeInTheDocument();
    });
  });
```

Add new tests below it for the grid shell. These three reset the layout store + localStorage to keep them isolated from persisted state:

```typescript
  it('renders the 4-column grid shell on desktop', async () => {
    const { container } = render(<AppLayout />);
    await waitFor(() => {
      const shell = container.querySelector('.app-grid-shell');
      expect(shell).toBeInTheDocument();
      expect(container.querySelector('.app-grid-rail')).toBeInTheDocument();
      expect(container.querySelector('.app-grid-sidebar')).toBeInTheDocument();
      expect(container.querySelector('.app-grid-members')).toBeInTheDocument();
    });
  });

  it('renders MeshTopBar when topBarEnabled', async () => {
    const { useLayoutStore } = await import('../stores/layoutStore');
    localStorage.removeItem('dilla-layout');
    useLayoutStore.setState({ topBarEnabled: true });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByRole('banner', { name: /mesh top bar/i })).toBeInTheDocument();
    });
    useLayoutStore.setState({ topBarEnabled: false });
  });

  it('renders MeshBottomBar when bottomBarEnabled', async () => {
    const { useLayoutStore } = await import('../stores/layoutStore');
    localStorage.removeItem('dilla-layout');
    useLayoutStore.setState({ bottomBarEnabled: true });
    render(<AppLayout />);
    await waitFor(() => {
      expect(screen.getByRole('contentinfo', { name: /mesh bottom bar/i })).toBeInTheDocument();
    });
    useLayoutStore.setState({ bottomBarEnabled: false });
  });
```

- [ ] **Step 3: Fix `AppLayout.responsive.test.tsx`**

In `client/src/pages/AppLayout.responsive.test.tsx`:

Change the test at line 190 to assert the new shell:
```typescript
  it('renders grid shell and resize-handle on desktop', async () => {
    const { container } = render(<AppLayout />);
    expect(await screen.findByTestId('resize-handle')).toBeInTheDocument();
    expect(container.querySelector('.app-grid-shell')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
  });
```

Keep all other tests untouched.

- [ ] **Step 4: Run both test files**

Run: `cd client && npx vitest run src/pages/AppLayout.test.tsx src/pages/AppLayout.responsive.test.tsx`
Expected: PASS (all tests green; 3 new tests added to AppLayout.test.tsx).

If a test still fails, read its specific assertion and adjust either the test or the layout. Do not skip or `.todo` a test to make this step pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AppLayout.test.tsx client/src/pages/AppLayout.responsive.test.tsx
git commit -m "test(layout): assert grid shell + bar toggles on AppLayout"
```

---

### Task 7.5: Update `AppLayout.responsive.browser.test.tsx` fixtures

**Why:** the browser test maintains its own inline JSX with `.left-panels`/`.left-panels-top`/`.left-panels-bottom` class names and `expect(...).toHaveStyle({ display: 'flex' })` assertions on `.left-panels`. These will fail in Task 8 Step 2 once `AppLayout.css` no longer defines those classes.

**Files:**
- Modify: `client/src/pages/AppLayout.responsive.browser.test.tsx`

- [ ] **Step 1: Inspect**

```bash
cat client/src/pages/AppLayout.responsive.browser.test.tsx | head -80
```

Note the inline JSX fixtures (around lines 30–60) and the `display: flex` assertions on `.left-panels`.

- [ ] **Step 2: Rewrite the fixtures**

Replace every occurrence of:
- `.left-panels` → `.app-grid-shell`
- `.left-panels-top` → `.app-grid-rail` (or `.app-grid-sidebar` if the test was asserting the sidebar column — read the assertion context)
- `.left-panels-bottom` → `.app-grid-sidebar-bottom`

Replace `expect(left).toHaveStyle({ display: 'flex' })` with `expect(shell).toHaveStyle({ display: 'grid' })` where `shell` queries `.app-grid-shell`.

If the existing test asserts a specific width on the left-panels element, change the assertion to query `.app-grid-rail` (60px) or rely on the inline `style` set by `AppLayout` (which uses `var(--rail-w)` so the computed value is `60px`).

- [ ] **Step 3: Run browser tests**

Run: `cd client && npm run test:browser 2>&1 | tail -30`
Expected: all pass. If a specific assertion still fails, read it and adjust either the fixture or the CSS — do not skip the test.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/AppLayout.responsive.browser.test.tsx
git commit -m "test(layout): rewrite browser-test fixtures for grid shell"
```

---

### Task 8: Run full suite, lint, type-check, manual smoke

**Files:** None directly — verification step.

- [ ] **Step 1: Full client unit test suite**

Run: `cd client && npm test -- --run`
Expected: 1898 + new tests pass (target ~1907–1910). Zero failures.

- [ ] **Step 2: Browser tests (vitest-browser)**

Run: `cd client && npm run test:browser 2>&1 | tail -20`
Expected: pass. If `AppLayout.responsive.browser.test.tsx` has selectors that depended on `.left-panels`, fix them analogously to Task 7 Step 3.

- [ ] **Step 3: Lint**

Run: `cd client && npm run lint`
Expected: zero new warnings (15 pre-existing warnings stay; do not fix unrelated ones).

- [ ] **Step 4: Type-check**

Run: `cd client && npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 5: Manual smoke via `npm run dev`**

```bash
cd client && npm run dev
```

Open <http://localhost:8888>. Confirm:
1. Layout renders identically to baseline (rail + sidebar + main + members visible).
2. Drag the handle between sidebar and main — width updates smoothly within [200, 360].
3. Drag the handle between main and members — width updates within [180, 340].
4. In DevTools console:
   ```js
   useLayoutStore.getState().toggleTopBar()
   ```
   The MeshTopBar (32px, mono "DILLA · MESH OK") slides in above the grid. Toggle off again.
5. `useLayoutStore.getState().toggleBottomBar()` — MeshBottomBar (26px) appears below the grid.
6. Switch to mesh theme: `useUserSettingsStore.getState().setTheme('mesh')`. Layout chrome still works; colors flip to mesh palette.
7. Reload — layout state persists (sidebarWidth, top/bottom toggles).

- [ ] **Step 6: Verification-before-completion checklist**

Use @superpowers:verification-before-completion:
- [ ] Full unit test suite passes
- [ ] Browser test suite passes
- [ ] `npx tsc -b --noEmit` clean
- [ ] `npm run lint` no new warnings
- [ ] Manual smoke confirmed grid + resize + toggles + theme switch
- [ ] No regressions in mobile branch (tested by `AppLayout` mobile describe blocks)

- [ ] **Step 7: Discard unintended file changes**

```bash
git status
```

Anything not part of the layout work (e.g. `package-lock.json` drift from npm install in plan #1) — revert with `git restore <file>`.

- [ ] **Step 8: Verify branch state**

Run: `git log --oneline main..HEAD`
Expected: ~10 new commits from this plan (tokens / store / MeshTopBar / MeshBottomBar / ResizeHandle side / AppLayout JSX / AppLayout CSS / unit tests / browser tests / cleanup), plus the 7 from plan #1 = ~17 total. All conventional-commit prefixed.

---

## Done When

- `AppLayout` desktop branch renders as a CSS Grid with rail (60px) | sidebar (200–360px) | main | members (180–340px when open).
- `useLayoutStore` persists widths and bar toggles across reloads.
- `MeshTopBar` and `MeshBottomBar` are toggleable empty stubs sitting above/below the grid.
- The members panel is resizable.
- The rail is its own full-height column; voice-controls + user-panel live inside the channel-sidebar column at its bottom.
- All existing tests pass; 4+ new tests cover the grid shell + bar toggles.
- Mobile branch is functionally unchanged.
- Lint clean; type-check clean.

## Follow-on plans

1. ✅ Tokens (plan #1)
2. ✅ Layout shell (this plan)
3. Server rail (replace `TeamSidebar` internals — 40×40 icons, drag-reorder, right-click menus, federated dots, `+ Add team`)
4. Channel sidebar (Mesh tabs/categories, voice dock, user panel chrome)
5. Text channel (header + message rendering + composer)
6. Voice channel
7. Member sidebar + thread panel
8. Mesh top bar + bottom bar internals (fills in the stubs)
9. Command palette + search palette
10. Onboarding wizard
11. Extras/overlays + backend rewiring
