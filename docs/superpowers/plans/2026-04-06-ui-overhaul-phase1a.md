# UI Overhaul Phase 1A: Visual Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visual foundation — colors, fonts, icons, layout, and avatar style — so every component looks premium without changing component logic.

**Architecture:** Update CSS custom property tokens + self-hosted font files + swap icon library. All component CSS files updated to use new tokens and Airy Luxe spacing. Layout restructured to Elevated Center. Avatars changed from circles to squircles. No TSX logic changes except icon imports.

**Tech Stack:** CSS custom properties, Plus Jakarta Sans (self-hosted woff2), @tabler/icons-react, existing React component structure.

**Spec:** `docs/superpowers/specs/2026-04-06-ui-overhaul-v3-design.md`

---

## File Structure

### New files
| File | Responsibility |
|------|----------------|
| `client/public/fonts/plus-jakarta-sans-variable-latin.woff2` | Plus Jakarta Sans font file |
| `client/public/fonts/plus-jakarta-sans-variable-latin-ext.woff2` | Plus Jakarta Sans extended range |

### Modified files — Foundation
| File | Change |
|------|--------|
| `client/public/fonts/fonts.css` | Add Plus Jakarta Sans @font-face, remove DM Serif Display |
| `client/src/styles/base-tokens.css` | Update font-family, radius, add `--radius-xl` |
| `client/src/styles/theme-default.css` | All new Midnight Teal color values |
| `client/src/index.css` | Global button/input/focus styles updated |
| `client/package.json` | Replace `iconoir-react` with `@tabler/icons-react` |

### Modified files — Layout & Components (CSS only)
| File | Change |
|------|--------|
| `client/src/pages/AppLayout.css` | Elevated Center layout, Airy Luxe spacing |
| `client/src/components/TeamSidebar/TeamSidebar.css` | Darkest bg, squircle icons, pill indicator |
| `client/src/components/ChannelList/ChannelList.css` | Airy Luxe spacing, squircle avatars |
| `client/src/components/MessageList/MessageList.css` | Airy spacing, squircle avatars, hover refinement |
| `client/src/components/MessageInput/MessageInput.css` | Airy spacing, gradient fade |
| `client/src/components/MemberList/MemberList.css` | Solid dark bg, squircle avatars |
| `client/src/components/UserPanel/UserPanel.css` | Airy spacing |
| `client/src/pages/PublicShell.css` | Atmospheric Minimal Split Panel styling |

### Modified files — Icon swap (TSX)
| File | Change |
|------|--------|
| All 21 files importing `iconoir-react` | Change imports to `@tabler/icons-react` |

---

### Task 1: Download Plus Jakarta Sans & update font-face

**Files:**
- Create: `client/public/fonts/plus-jakarta-sans-variable-latin.woff2`
- Create: `client/public/fonts/plus-jakarta-sans-variable-latin-ext.woff2`
- Modify: `client/public/fonts/fonts.css`

- [ ] **Step 1: Download Plus Jakarta Sans woff2 files**

```bash
cd client/public/fonts
curl -L "https://fonts.gstatic.com/s/plusjakartasans/v9/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko.woff2" -o plus-jakarta-sans-variable-latin.woff2
curl -L "https://fonts.gstatic.com/s/plusjakartasans/v9/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA70Q.woff2" -o plus-jakarta-sans-variable-latin-ext.woff2
```

- [ ] **Step 2: Update fonts.css**

Replace the DM Serif Display entries with Plus Jakarta Sans. Keep DM Sans as fallback and JetBrains Mono.

```css
/* Self-hosted fonts — no third-party requests */

/* Plus Jakarta Sans — primary UI font */
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('./plus-jakarta-sans-variable-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('./plus-jakarta-sans-variable-latin-ext.woff2') format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}

/* JetBrains Mono — code/monospace */
/* ... keep existing JetBrains Mono entries unchanged ... */
```

- [ ] **Step 3: Commit**

```bash
git add client/public/fonts/
git commit -m "feat: add Plus Jakarta Sans font, remove DM Serif Display"
```

---

### Task 2: Update design tokens — colors & typography

**Files:**
- Modify: `client/src/styles/base-tokens.css`
- Modify: `client/src/styles/theme-default.css`

- [ ] **Step 1: Update base-tokens.css**

Change font families to Plus Jakarta Sans:
```css
--font-display: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
--font-ui: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
```

Update radius tokens:
```css
--radius-sm: 6px;
--radius-md: 10px;
--radius-lg: 14px;
--radius-xl: 18px;
--radius-full: 9999px;
```

- [ ] **Step 2: Update theme-default.css — Midnight Teal palette**

Update ALL color values per the spec Section 1.1. Key changes:
- Backgrounds: `--bg-primary: #111c25`, `--bg-secondary: #0a1018`, `--bg-tertiary: #070b10`
- Brand: `--brand-500: #0ea5c0`, `--brand-560: #22d3ee`
- Text-normal opacity-based: `--text-normal: rgba(255,255,255,0.6)`
- Status: `--success: #10b981`, `--danger: #ef4444`, `--warning: #f59e0b`
- All alpha variants updated with new RGB values
- Glass effects darkened to match new background values

- [ ] **Step 3: Run tests**

Run: `cd client && npx vitest run 2>&1 | tail -8`
Expected: All tests pass (CSS-only changes)

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/
git commit -m "feat: Midnight Teal palette + Plus Jakarta Sans tokens"
```

---

### Task 3: Update global styles

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Update button, input, focus styles**

- Root font-family now uses `--font-ui` (which is Plus Jakarta Sans)
- Button border-radius: `var(--radius-md)`
- Button active: `transform: scale(0.98)`
- Focus: `outline: 2px solid var(--brand-500); outline-offset: calc(-1 * var(--spacing-xs));`
- Input/textarea focus: brand glow ring
- Ensure reduced-motion media query exists

- [ ] **Step 2: Run tests and commit**

```bash
cd client && npx vitest run 2>&1 | tail -8
git add client/src/index.css
git commit -m "feat: global styles — rounded buttons, brand focus rings, scale press"
```

---

### Task 4: Install Tabler Icons and swap all imports

**Files:**
- Modify: `client/package.json` (add `@tabler/icons-react`, remove `iconoir-react`)
- Modify: All 21 files importing from `iconoir-react`

- [ ] **Step 1: Install Tabler Icons**

```bash
cd client
npm install @tabler/icons-react
npm uninstall iconoir-react
```

- [ ] **Step 2: Create icon mapping and swap all imports**

Key mapping (iconoir → tabler):
- `Hashtag` → `IconHash`
- `ChatBubble` → `IconMessage`
- `Group` → `IconUsers`
- `SoundHigh` → `IconVolume`
- `Lock` → `IconLock`
- `Settings` → `IconSettings`
- `Plus` → `IconPlus`
- `MicrophoneMute` → `IconMicrophoneOff`
- `HeadsetWarning` → `IconHeadphonesOff`
- `AppWindow` → `IconScreenShare`
- `VideoCamera` → `IconVideo`
- `Search` → `IconSearch`
- `Xmark` → `IconX`
- `Reply` → `IconArrowBackUp`
- `Threads` → `IconMessages`
- `EditPencil` → `IconEdit`
- `Trash` → `IconTrash`
- `Emoji` → `IconMoodSmile`
- `NavArrowDown` → `IconChevronDown`
- `Send` → `IconSend`
- `Attachment` → `IconPaperclip`
- `Bold` → `IconBold`
- `Italic` → `IconItalic`
- `Code` → `IconCode`
- `Link` → `IconLink`
- `List` → `IconList`
- `ListOrdered` → `IconListNumbers`
- `Quote` → `IconBlockquote`

Tabler icons use `size` prop instead of `width`/`height`, and `stroke` instead of `strokeWidth`. Default stroke is 2 but spec says 1.75:

Change ALL icon usages from:
```tsx
<SoundHigh width={16} height={16} strokeWidth={2} />
```
to:
```tsx
<IconVolume size={16} stroke={1.75} />
```

Update all 21 files. This is a mechanical find-and-replace operation per file.

- [ ] **Step 3: Run TypeScript check**

Run: `cd client && npx tsc --noEmit 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 4: Run tests**

Run: `cd client && npx vitest run 2>&1 | tail -8`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add client/
git commit -m "feat: swap iconoir-react for @tabler/icons-react (1.75px stroke)"
```

---

### Task 5: Elevated Center layout

**Files:**
- Modify: `client/src/pages/AppLayout.css`

- [ ] **Step 1: Update layout CSS for Elevated Center + Airy Luxe**

Key changes:
- `.app-layout-main`: `background: var(--bg-tertiary)` (darkest shell)
- `.left-panels-bottom`: gradient background, no border-top
- `.channel-sidebar`: solid `var(--bg-secondary)`, no backdrop-filter, no border-right
- `.content-area`: `var(--bg-primary)` + deep side shadows (`-4px 0 40px rgba(0,0,0,0.5), 4px 0 40px rgba(0,0,0,0.5)`)
- `.content-header`: solid `var(--bg-primary)`, hairline bottom border, 54px height, 22px padding
- `.header-action-btn`: `border-radius: var(--radius-md)`
- `.sidebar-tab`: `border-radius: var(--radius-md)`, larger padding
- All hardcoded px values → token vars

- [ ] **Step 2: Run tests and commit**

```bash
cd client && npx vitest run 2>&1 | tail -8
git add client/src/pages/AppLayout.css
git commit -m "feat: Elevated Center layout with Airy Luxe spacing"
```

---

### Task 6: Component CSS — Airy Luxe + Squircle Avatars

**Files:**
- Modify: `client/src/components/TeamSidebar/TeamSidebar.css`
- Modify: `client/src/components/ChannelList/ChannelList.css`
- Modify: `client/src/components/MessageList/MessageList.css`
- Modify: `client/src/components/MessageInput/MessageInput.css`
- Modify: `client/src/components/MemberList/MemberList.css`
- Modify: `client/src/components/UserPanel/UserPanel.css`

- [ ] **Step 1: Update TeamSidebar.css**

- Background: `var(--bg-tertiary)` (darkest)
- Remove backdrop-filter
- Team icons: squircle `border-radius: var(--radius-lg)`, hover glow
- Active indicator: pill-shaped left bar (white, 4px × 28px)

- [ ] **Step 2: Update ChannelList.css**

- Channel items: `padding: 9px 14px`, `margin: 2px 8px`, `border-radius: var(--radius-md)`
- Active: `background: rgba(14,165,192,0.06)`, `box-shadow: inset 0 0 0 1px rgba(14,165,192,0.12)`
- Category labels: lighter opacity, more spacing
- Voice user avatars: squircle `border-radius: var(--radius-md)`

- [ ] **Step 3: Update MessageList.css**

- Avatars: squircle `border-radius: var(--radius-md)` instead of `var(--radius-full)`
- Message groups: `var(--spacing-xl)` margin
- Content: `font-size: var(--font-size-base)`, `line-height: 1.65`
- Hover: `rgba(255,255,255,0.02)` (barely visible)
- Code blocks: `border-radius: var(--radius-lg)`

- [ ] **Step 4: Update MessageInput.css**

- Composer: Airy margins `0 var(--spacing-xl) var(--spacing-lg)`
- Gradient fade `::before` pseudo-element above
- Background: glass-secondary with blur
- Focus glow ring

- [ ] **Step 5: Update MemberList.css**

- Background: solid `var(--bg-secondary)`, no blur
- Member avatars: squircle
- Shadow separation instead of border
- Offline: `opacity: 0.5` (less harsh than 0.4)

- [ ] **Step 6: Update UserPanel.css**

- Airy padding
- Subtle top border
- Avatar: squircle

- [ ] **Step 7: Run tests and commit**

```bash
cd client && npx vitest run 2>&1 | tail -8
git add client/src/components/
git commit -m "feat: Airy Luxe spacing + squircle avatars across all components"
```

---

### Task 7: Login page — Atmospheric Minimal Split Panel

**Files:**
- Modify: `client/src/pages/PublicShell.css`

- [ ] **Step 1: Redesign PublicShell.css**

- Left panel (40%): `var(--bg-tertiary)` with two ambient glow orbs (teal + amber, blurred circles via `::before` and `::after`)
- Large logo (60px squircle) centered with `box-shadow: 0 0 50px rgba(14,165,192,0.15)`
- Tagline: "The chat platform that respects you." in light weight
- Right panel (60%): `var(--bg-secondary)` with centered form
- Identity card: squircle avatar with presence ring
- Sign-in button: brand gradient with shadow
- Mobile: stack layout, show compact brand header

- [ ] **Step 2: Run tests and commit**

```bash
cd client && npx vitest run 2>&1 | tail -8
git add client/src/pages/PublicShell.css
git commit -m "feat: Atmospheric Minimal Split Panel login page"
```

---

### Task 8: Update themes.ts dark/light/minimal objects

**Files:**
- Modify: `client/src/themes/themes.ts`

- [ ] **Step 1: Update all theme objects with new Midnight Teal values**

The `darkTheme`, `lightTheme`, and `minimalTheme` objects in themes.ts override CSS vars at runtime. They need to use the new Midnight Teal RGB values for all color tokens. Update all `--bg-*`, `--text-*`, `--brand-*`, `--status-*`, glass, gradient, overlay, and alpha tokens.

- [ ] **Step 2: Run tests and commit**

```bash
cd client && npx vitest run 2>&1 | tail -8
git add client/src/themes/themes.ts
git commit -m "feat: update theme objects with Midnight Teal values"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd client && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 2: TypeScript check**

Run: `cd client && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: ESLint**

Run: `cd client && npm run lint 2>&1 | tail -10`
Expected: No new errors (existing parsing errors on binaries OK)

- [ ] **Step 4: Build check**

Run: `cd client && npm run build 2>&1 | tail -10`
Expected: Build succeeds
