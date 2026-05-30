# Mesh Channel Sidebar Visual Refresh Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Restyle the channel sidebar surfaces (sidebar header, tabs, channel list, DM list, user panel, voice controls) to match the Mesh visual language — JetBrains Mono throughout, brutalist 0–2px radii, uppercase mono category headers, accent-underlined active tab, accent unread pills, amber mention pills. Behavior is fully preserved.

**Architecture:**
Five CSS files get a focused rewrite to consume the Mesh tokens added in plan #1 (with sensible fallbacks for legacy themes). The sidebar header markup in `AppLayout.tsx` gets a small JSX addition (mono "node" subtitle line beneath the team name) gated on the active theme being mesh — for non-mesh themes the subtitle stays hidden. No component is renamed; no test is moved. The only structural change is the new subtitle div inside `.channel-sidebar-header-top`.

**Tech Stack:** CSS variables (Mesh tokens), React 19. No new components, no new stores, no new dependencies.

**Scope guardrails:**
- ❌ No drag-reorder of channels (depends on a `setChannelOrder` action in teamStore — separate follow-on)
- ❌ No voice-dock interactive UX rewrite (VoiceControls keeps its current behavior; only CSS updates)
- ❌ No new-DM member-picker UX changes (NewDMModal CSS later)
- ❌ No new ContextMenu components — ChannelList already has its own; reuse and re-style only
- ❌ No mute-channel UI ("bell-slash" glyph) — depends on mutedChannels store work, defer
- ❌ No private-channel "lock icon" — defer to text-channel plan
- ✅ Pure CSS + minimal JSX additions
- ✅ Mesh tokens consumed where present; fallbacks ensure legacy themes still render
- ✅ All existing tests must still pass (no behavioral change)

---

## File Structure

**Modify:**
- `client/src/components/ChannelList/ChannelList.css` — full Mesh rewrite (~300 lines → ~280 lines)
- `client/src/components/DMList/DMList.css` — full Mesh rewrite
- `client/src/components/UserPanel/UserPanel.css` — Mesh treatment (avatar 2px radius, mono name, status pill)
- `client/src/components/VoiceControls/VoiceControls.css` — Mesh treatment (mono dock, accent connect state, color-coded mute/cam toggles)
- `client/src/pages/AppLayout.css` — update `.channel-sidebar-header`, `.channel-sidebar-tabs`, `.sidebar-tab` rules
- `client/src/pages/AppLayout.tsx` — inside `.channel-sidebar-header-top`, add a mono `.channel-sidebar-node` div below the team-name span showing the team's baseUrl host + ` · mesh ok`

**Tests touched only if they assert CSS — none currently do, so no test changes expected.**

---

### Task 1: Sidebar header — mono node subtitle line

**Files:**
- Modify: `client/src/pages/AppLayout.tsx` (the `channelSidebarContent` JSX, around line 415–445)

- [ ] **Step 1: Read the current header block**

```bash
sed -n '410,450p' client/src/pages/AppLayout.tsx
```

- [ ] **Step 2: Add a mono node line**

Inside `<div className="channel-sidebar-header-top">…</div>`, immediately after the closing `</div>` of `channel-sidebar-header-top` but BEFORE the closing `</div>` of `channel-sidebar-header`, add:

```tsx
{!isDMMode && activeTeamId && (
  <div className="channel-sidebar-node" title="Federation status">
    {(authTeams.get(activeTeamId)?.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')}
    {' · '}
    <span className="channel-sidebar-node-status">MESH OK</span>
  </div>
)}
```

You'll need to add `authTeams` to the destructuring of `useAuthStore()` near the top of `AppLayout`. Look for `const { teams, derivedKey } = useAuthStore();` and rename the local for `teams` to `authTeams` (since `teams` is already used for `teamStore.teams`). Update the few existing references — there are two: in the "redirect to /join" effect (`teams.size === 0` → `authTeams.size === 0`) and the team-entry lookup (`teams.get(activeTeamId)` → `authTeams.get(activeTeamId)`).

- [ ] **Step 3: Type-check**

`cd client && npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 4: Run AppLayout tests**

`cd client && npx vitest run src/pages/AppLayout.test.tsx`
Expected: pass — the new JSX is purely additive and existing tests don't assert on it.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AppLayout.tsx
git commit -m "feat(layout): add mono node subtitle to channel sidebar header"
```

---

### Task 2: Sidebar header + tabs CSS — Mesh treatment

**Files:**
- Modify: `client/src/pages/AppLayout.css` (the `.channel-sidebar-header*`, `.channel-sidebar-tabs`, `.sidebar-tab*` blocks)

- [ ] **Step 1: Locate the existing blocks**

In `AppLayout.css`, find `.channel-sidebar-header` (currently around line 274) through `.channel-sidebar-tabs` and `.sidebar-tab` rules.

- [ ] **Step 2: Replace those blocks**

Replace from `/* Sidebar header (team name + tabs) */` through the end of `.sidebar-tab.active { ... }` with:

```css
/* Sidebar header (team name + node line + tabs) */
.channel-sidebar-header {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--hairline, var(--divider));
  flex-shrink: 0;
  box-sizing: border-box;
  background: var(--bg-2, var(--bg-secondary));
}

.channel-sidebar-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 4px;
}

.channel-sidebar-header-name {
  font-family: var(--font-display);
  font-style: italic;
  font-size: 15px;
  font-weight: var(--fw-display, 700);
  letter-spacing: var(--display-tracking, 0.01em);
  color: var(--fg, var(--text-primary));
  flex: 1;
  min-width: 0;
}

.channel-sidebar-node {
  padding: 0 14px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-3, var(--text-muted));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-sidebar-node-status {
  color: var(--accent, var(--success));
}

.sidebar-settings-btn {
  padding: 4px;
  border: none;
  border-radius: var(--r-md, 2px);
  background: none;
  color: var(--fg-2, var(--interactive-normal));
  cursor: pointer;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.12s ease-out, background-color 0.12s ease-out;
}

.sidebar-settings-btn:hover {
  color: var(--fg, var(--interactive-hover));
  background: var(--surface-2, var(--bg-modifier-hover));
}

.channel-sidebar-tabs {
  display: flex;
  padding: 0;
  gap: 0;
  border-top: 1px solid var(--hairline, var(--divider));
}

.sidebar-tab {
  flex: 1;
  padding: 10px 0 9px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--fg-2, var(--interactive-normal));
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: color 0.12s ease-out;
  position: relative;
}

.sidebar-tab:hover {
  color: var(--fg, var(--interactive-hover));
  background: var(--surface-2, var(--bg-modifier-hover));
}

.sidebar-tab.active {
  color: var(--accent, var(--interactive-active));
  background: transparent;
}

.sidebar-tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 1px;
  background: var(--accent, var(--brand-500));
}
```

- [ ] **Step 3: Build check**

`cd client && npx vite build --mode development 2>&1 | tail -5`
Expected: `✓ built`.

- [ ] **Step 4: Run AppLayout tests**

`cd client && npx vitest run src/pages/AppLayout.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/AppLayout.css
git commit -m "style(sidebar): mesh treatment for header, node line, tabs"
```

---

### Task 3: ChannelList — Mesh CSS rewrite

**Files:**
- Modify: `client/src/components/ChannelList/ChannelList.css` (full rewrite)

- [ ] **Step 1: Read the existing CSS to understand class names in use**

```bash
grep -E "^\.[a-z]" client/src/components/ChannelList/ChannelList.css | sort -u
```

The implementation references: `.channel-list-section`, `.channel-list-section-header`, `.channel-list-section-toggle`, `.channel-list-section-add`, `.channel-item`, `.channel-item-text`, `.channel-item-voice`, `.channel-item-name`, `.channel-item-prefix` (`#` glyph), `.channel-item-icon` (volume), `.channel-item-unread-pill`, `.channel-item-mention-pill`, `.channel-context-menu`, `.channel-context-menu-item`, `.channel-context-menu-item-danger`, `.voice-occupant-list`, `.voice-occupant-item`, `.voice-occupant-avatar`, `.voice-occupant-name`, `.voice-occupant-badges`, `.voice-occupant-speaking`. Confirm by reading the actual file.

- [ ] **Step 2: Replace the whole file**

Use Write to overwrite with:

```css
/* Channel list — Mesh treatment */
.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  scrollbar-width: thin;
  scrollbar-color: var(--hairline, var(--scrollbar-thin-thumb)) transparent;
}

.channel-list::-webkit-scrollbar { width: 6px; }
.channel-list::-webkit-scrollbar-thumb { background: var(--hairline, var(--scrollbar-thin-thumb)); }
.channel-list::-webkit-scrollbar-track { background: transparent; }

/* Category sections */
.channel-list-section {
  margin-bottom: 6px;
}

.channel-list-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3, var(--text-muted));
  cursor: default;
  user-select: none;
}

.channel-list-section-toggle {
  background: none;
  border: none;
  color: inherit;
  padding: 0;
  margin: 0;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.channel-list-section-toggle:hover {
  color: var(--fg, var(--interactive-hover));
}

.channel-list-section-add {
  background: none;
  border: none;
  color: var(--fg-3, var(--text-muted));
  cursor: pointer;
  padding: 2px;
  border-radius: var(--r-sm, 0);
  display: inline-flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.12s ease-out, color 0.12s ease-out;
}

.channel-list-section:hover .channel-list-section-add { opacity: 1; }
.channel-list-section-add:hover { color: var(--accent, var(--interactive-hover)); }

/* Channel rows */
.channel-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--row-pad-y, 6px) 14px;
  margin: 0;
  cursor: pointer;
  color: var(--fg-2, var(--channel-icon));
  font-family: var(--font-ui);
  font-size: 13px;
  position: relative;
  transition: background 0.1s ease-out, color 0.1s ease-out;
  border-left: 2px solid transparent;
}

.channel-item:hover {
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg, var(--interactive-hover));
}

.channel-item.active {
  background: var(--surface-hi, var(--bg-modifier-selected));
  color: var(--accent, var(--interactive-active));
  border-left-color: var(--accent, var(--brand-500));
}

.channel-item-prefix {
  font-family: var(--font-mono);
  color: var(--fg-3, var(--text-muted));
  font-size: 13px;
  width: 12px;
  text-align: center;
}

.channel-item.active .channel-item-prefix {
  color: var(--accent, var(--brand-500));
}

.channel-item-icon {
  display: inline-flex;
  align-items: center;
  color: var(--fg-3, var(--text-muted));
  flex-shrink: 0;
}

.channel-item.active .channel-item-icon {
  color: var(--accent, var(--brand-500));
}

.channel-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-item.unread {
  color: var(--fg, var(--interactive-active));
  font-weight: 600;
}

.channel-item-unread-pill {
  min-width: 18px;
  height: 16px;
  border-radius: var(--r-sm, 0);
  background: var(--accent, var(--brand-500));
  color: var(--accent-ink, white);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  line-height: 1;
  letter-spacing: 0.02em;
}

.channel-item-mention-pill {
  min-width: 18px;
  height: 16px;
  border-radius: var(--r-sm, 0);
  background: var(--warn, var(--yellow-300));
  color: var(--accent-ink, black);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  line-height: 1;
}

/* Voice channel rows */
.channel-item-voice {
  /* same as channel-item; voice-specific decoration handled by icon */
}

.voice-occupant-list {
  padding: 2px 0 6px 28px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.voice-occupant-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-2, var(--text-secondary));
  border-radius: var(--r-sm, 0);
}

.voice-occupant-avatar {
  width: 18px;
  height: 18px;
  border-radius: var(--r-sm, 0);
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg, var(--text-primary));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.voice-occupant-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-occupant-badges {
  display: inline-flex;
  gap: 4px;
  color: var(--fg-3, var(--text-muted));
}

.voice-occupant-speaking::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, var(--success));
  margin-right: 4px;
  box-shadow: 0 0 0 2px var(--accent-soft, rgba(124, 255, 142, 0.2));
  animation: mesh-speaking-pulse 2s ease-in-out infinite;
}

@keyframes mesh-speaking-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

/* Right-click context menu */
.channel-context-menu {
  position: fixed;
  background: var(--surface, var(--bg-floating));
  border: 1px solid var(--accent, var(--brand-500));
  box-shadow: var(--shadow-2, 0 12px 30px rgba(0, 0, 0, 0.6));
  border-radius: var(--r-md, 2px);
  padding: 4px;
  min-width: 180px;
  z-index: var(--z-tooltip);
  display: flex;
  flex-direction: column;
  font-family: var(--font-ui);
  font-size: 12px;
}

.channel-context-menu-item {
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

.channel-context-menu-item:hover {
  background: var(--accent-soft, rgba(124, 255, 142, 0.14));
  color: var(--accent, var(--brand-500));
}

.channel-context-menu-item-danger {
  color: var(--danger, var(--text-danger));
}

.channel-context-menu-item-danger:hover {
  background: rgba(255, 110, 110, 0.12);
}

/* Mobile (preserved) */
@media (max-width: 767px) {
  .channel-item { padding: 10px 14px; }
}
```

- [ ] **Step 3: Build + test**

```bash
cd client && npx vite build --mode development 2>&1 | tail -3
cd client && npx vitest run src/components/ChannelList/
```
Expected: build OK, tests still pass (ChannelList has many tests but they're behavioral, not CSS-asserting).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ChannelList/ChannelList.css
git commit -m "style(channels): mesh CSS treatment for channel list"
```

---

### Task 4: DMList — Mesh CSS rewrite

**Files:**
- Modify: `client/src/components/DMList/DMList.css` (full rewrite)

- [ ] **Step 1: Find class names**

```bash
grep -E "^\.[a-z]" client/src/components/DMList/DMList.css | sort -u
```

- [ ] **Step 2: Replace the file**

Reuse the channel-item pattern with DM-specific tweaks. Use Write to overwrite with rules covering `.dm-list`, `.dm-list-empty`, `.dm-list-add`, `.dm-item`, `.dm-item-avatar`, `.dm-item-name`, `.dm-item-status`, `.dm-item-unread-pill`, `.dm-item.active`, plus context menu rules matching `.channel-context-menu` styling (or reuse those classes — confirm by reading the existing CSS first to see what's referenced).

Suggested rules (cover the common cases — read existing CSS first and only replace classes that exist):

```css
.dm-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  scrollbar-width: thin;
}

.dm-list-add {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% - 24px);
  margin: 6px 12px;
  padding: 8px 10px;
  border: 1px dashed var(--accent, var(--brand-500));
  background: transparent;
  color: var(--accent, var(--brand-500));
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: var(--r-md, 2px);
  transition: background 0.12s ease-out;
}

.dm-list-add:hover {
  background: var(--accent-soft, rgba(124, 255, 142, 0.14));
}

.dm-list-empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--fg-3, var(--text-muted));
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.dm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--row-pad-y, 6px) 14px;
  cursor: pointer;
  color: var(--fg-2, var(--text-secondary));
  font-family: var(--font-ui);
  font-size: 13px;
  transition: background 0.1s ease-out, color 0.1s ease-out;
  border-left: 2px solid transparent;
}

.dm-item:hover {
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg, var(--interactive-hover));
}

.dm-item.active {
  background: var(--surface-hi, var(--bg-modifier-selected));
  color: var(--fg, var(--interactive-active));
  border-left-color: var(--accent, var(--brand-500));
}

.dm-item-avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--r-md, 2px);
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg, var(--text-primary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

.dm-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dm-item-status {
  color: var(--fg-3, var(--text-muted));
  font-size: 11px;
}

.dm-item-unread-pill {
  min-width: 18px;
  height: 16px;
  border-radius: var(--r-sm, 0);
  background: var(--accent, var(--brand-500));
  color: var(--accent-ink, white);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  line-height: 1;
}

.dm-item-mention-pill {
  background: var(--warn, var(--yellow-300));
  color: var(--accent-ink, black);
}
```

**Important:** Before replacing, run the grep above and ensure every class name that the TSX uses gets a corresponding rule. If the existing CSS has classes not listed above, copy them into the new file with Mesh-token equivalents.

- [ ] **Step 3: Build + test**

```bash
cd client && npx vite build --mode development 2>&1 | tail -3
cd client && npx vitest run src/components/DMList/
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/DMList/DMList.css
git commit -m "style(dms): mesh CSS treatment for DM list"
```

---

### Task 5: UserPanel — Mesh CSS rewrite

**Files:**
- Modify: `client/src/components/UserPanel/UserPanel.css`

- [ ] **Step 1: Find class names**

```bash
grep -E "^\.[a-z]" client/src/components/UserPanel/UserPanel.css | sort -u
head -30 client/src/components/UserPanel/UserPanel.tsx
```

Likely classes: `.user-panel`, `.user-panel-avatar`, `.user-panel-info`, `.user-panel-name`, `.user-panel-status`, `.user-panel-actions`, `.user-panel-action-btn`, plus a status-picker subset.

- [ ] **Step 2: Replace the file**

Write the new CSS preserving the same class set but in Mesh visuals. Key rules:

```css
.user-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-3, var(--bg-tertiary));
  border-top: 1px solid var(--hairline, var(--divider));
  min-height: 52px;
  box-sizing: border-box;
}

.user-panel-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--r-md, 2px);
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg, var(--text-primary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
  position: relative;
}

.user-panel-presence-dot {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-online);
  border: 2px solid var(--bg-3, var(--bg-tertiary));
}

.user-panel-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.user-panel-name {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: var(--fw-display, 700);
  color: var(--fg, var(--text-primary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-panel-status {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-3, var(--text-muted));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-panel-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.user-panel-action-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--fg-2, var(--interactive-normal));
  cursor: pointer;
  border-radius: var(--r-md, 2px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}

.user-panel-action-btn:hover {
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg, var(--interactive-hover));
}
```

Append any extra classes the existing CSS defines (status-picker popover, etc.) — copy them over with Mesh token substitutions.

- [ ] **Step 3: Run UserPanel tests**

```bash
cd client && npx vitest run src/components/UserPanel/
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/UserPanel/UserPanel.css
git commit -m "style(user-panel): mesh CSS treatment"
```

---

### Task 6: VoiceControls — Mesh CSS rewrite

**Files:**
- Modify: `client/src/components/VoiceControls/VoiceControls.css`

- [ ] **Step 1: Find class names**

```bash
grep -E "^\.[a-z]" client/src/components/VoiceControls/VoiceControls.css | sort -u
```

- [ ] **Step 2: Replace the file**

Per handoff §Channel sidebar/Voice dock:
- pulsing dot + name
- mic/headphone/cam/screen/disconnect buttons
- Mute/Deafen turn red when active
- Cam/Screen turn green when transmitting

Suggested core rules (extend with the actual class set after grepping):

```css
.voice-controls {
  display: flex;
  flex-direction: column;
  background: var(--surface, var(--bg-floating));
  border-top: 1px solid var(--hairline, var(--divider));
  padding: 8px 10px;
  font-family: var(--font-mono);
}

.voice-controls-dock {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.voice-controls-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, var(--success));
  box-shadow: 0 0 0 2px var(--accent-soft, rgba(124, 255, 142, 0.2));
  animation: mesh-speaking-pulse 2s ease-in-out infinite;
}

.voice-controls-channel-name {
  flex: 1;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg, var(--text-primary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-controls-buttons {
  display: flex;
  gap: 4px;
}

.voice-controls-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--hairline, var(--divider));
  background: var(--surface-2, var(--bg-modifier-hover));
  color: var(--fg-2, var(--interactive-normal));
  cursor: pointer;
  border-radius: var(--r-md, 2px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s ease-out, color 0.12s ease-out, border-color 0.12s ease-out;
}

.voice-controls-btn:hover {
  background: var(--surface-hi, var(--bg-floating));
  color: var(--fg, var(--interactive-hover));
  border-color: var(--accent, var(--brand-500));
}

/* Mute / Deafen turn red when active */
.voice-controls-btn.active-red {
  background: rgba(255, 110, 110, 0.16);
  color: var(--danger);
  border-color: var(--danger);
}

/* Cam / Screen turn green when transmitting */
.voice-controls-btn.active-green {
  background: var(--accent-soft, rgba(124, 255, 142, 0.14));
  color: var(--accent, var(--success));
  border-color: var(--accent, var(--success));
}

.voice-controls-btn.disconnect {
  color: var(--danger);
  border-color: var(--danger);
}
```

**Important:** The existing VoiceControls.tsx uses specific class names for the mute/deafen/cam/screen/disconnect buttons. Map those to `.active-red`, `.active-green`, `.disconnect` *only if* the existing TSX already applies a state-conditional class. If not, this CSS still ships, but the visual state won't change at runtime — that's acceptable for this plan; state-conditional class names land in plan #6 (voice channel). Read VoiceControls.tsx first to confirm.

If the existing CSS has additional class names (slider for input volume, audio meter, etc.), copy them across with Mesh tokens.

- [ ] **Step 3: Build + tests**

```bash
cd client && npx vite build --mode development 2>&1 | tail -3
cd client && npx vitest run src/components/VoiceControls/
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/VoiceControls/VoiceControls.css
git commit -m "style(voice): mesh CSS treatment for voice controls"
```

---

### Task 7: Full verification

- [ ] **Step 1: Full client test suite**

`cd client && npm test -- --run 2>&1 | tail -8`
Expected: 1920 + 0 new tests (this plan is CSS-only) = 1920 passing. If any test fails, it's almost certainly a CSS assertion in a browser test — investigate and either update the test to match Mesh values or revert the specific rule.

- [ ] **Step 2: Type-check**

`cd client && npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 3: Lint**

`cd client && npm run lint 2>&1 | tail -5`
Expected: 15 pre-existing warnings, no new ones.

- [ ] **Step 4: Manual smoke**

`cd client && npm run dev` → <http://localhost:8888>.
1. Sidebar header shows team name (italic display) + node line below (mono uppercase) when mesh theme is selected.
2. Tabs (Kanals / PMs) have accent underline when active.
3. Channels list shows mono category headers, hover backgrounds, accent unread pills, amber mention pills.
4. UserPanel at bottom: mono name, status pill.
5. Switch theme to dark — colors flip but Mesh classes still render acceptably (fallback tokens).

- [ ] **Step 5: Commit plan doc + verify branch state**

```bash
git add docs/superpowers/plans/2026-05-17-mesh-channel-sidebar.md
git commit -m "docs: channel sidebar visual refresh plan"
git log --oneline main..HEAD | wc -l
```
Expected total commits: ~30 (23 prior + ~7 from this plan).

---

## Done When

- Channel sidebar header has italic team-name + mono node line + accent-underlined tabs.
- ChannelList uses mono category headers, channel rows with `#` prefix, accent/amber pills.
- DMList uses Mesh DM rows with avatar squares.
- UserPanel uses mono name + status pill.
- VoiceControls uses Mesh dock pattern.
- All existing tests still pass; no behavioral changes.

## Deferred (follow-on plans)

- Drag-reorder channels (needs `setChannelOrder` in teamStore)
- "Active voice" inline participants (rendered, just unstyled)
- Mute-channel UI (bell-slash glyph; needs mutedChannels store)
- Private-channel lock icon (needs schema work)
- Full voice-dock state-aware classes (deferred to plan #6 voice channel)
- New-DM modal restyling (deferred to plan #11 extras)
