# Dilla UI Overhaul v3 — "Future Luxury" Design Spec

## Overview

Complete visual and UX redesign of the Dilla chat application. Transforms the current functional-but-generic dark UI into a premium, distinctive experience that surpasses Discord in polish and feel.

**Aesthetic:** Future + Luxury — clean, minimal, lots of space, but with rich depth and premium feel.

**Codename:** Midnight Teal

---

## 1. Visual Foundation

### 1.1 Color Palette — "Midnight Teal (Evolved)"

Deeper, richer version of the current Dilla palette. Near-black backgrounds with vibrant teal brand and amber accents.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-tertiary` | `#070b10` | Outermost shell, team sidebar |
| `--bg-secondary` | `#0a1018` | Channel sidebar, member list |
| `--bg-primary` | `#111c25` | Elevated content area |
| `--bg-floating` | `#0c1418` | Modals, dropdowns, popovers |
| `--brand-500` | `#0ea5c0` | Primary brand, links, active states |
| `--brand-560` | `#22d3ee` | Brand hover, gradients |
| `--accent` | `#f59e0b` | Amber accent, unread badges |
| `--success` | `#10b981` | Online, encrypted, positive |
| `--danger` | `#ef4444` | Disconnect, delete, errors |
| `--warning` | `#f59e0b` | Idle, caution |
| `--text-primary` | `#e8edf2` | Headings, usernames |
| `--text-normal` | `rgba(255,255,255,0.6)` | Body text, messages |
| `--text-muted` | `rgba(255,255,255,0.25)` | Timestamps, labels |

### 1.2 Typography — Plus Jakarta Sans

Self-hosted variable font. Warm, approachable, subtly premium. Used by Linear, Vercel.

| Weight | Usage |
|--------|-------|
| 300 | Light captions, subtle text |
| 400 | Body text, messages |
| 500 | Usernames, channel names, labels |
| 600 | Headings, server names, buttons |
| 700 | Hero text on login page |

Font sizes follow the existing token scale (`--font-size-micro` through `--font-size-3xl`).

Monospace: JetBrains Mono (keep existing).

### 1.3 Icons — Tabler Icons

Replace Iconoir with `@tabler/icons-react`. 5400+ icons, 1.75px stroke, MIT licensed, tree-shakeable.

All icon imports change from `iconoir-react` to `@tabler/icons-react`. Icon names differ — mapping required.

### 1.4 Border Radius

Squircle-inspired corners:

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Small buttons, badges |
| `--radius-md` | `10px` | Channel items, inputs, cards |
| `--radius-lg` | `14px` | Modals, panels, composer |
| `--radius-xl` | `18px` | Login card, large surfaces |
| `--radius-full` | `9999px` | Pills, badges |

### 1.5 Avatars — Squircles

Replace circular avatars with rounded squares (squircles). `border-radius: 10px` for 32-40px avatars, `border-radius: 14px` for 48-64px.

Presence shown as colored ring around avatar:
- Online: `box-shadow: 0 0 0 2px var(--bg-*), 0 0 0 4px var(--success)`
- Idle: amber ring
- DND: red ring
- Offline: no ring, 50% opacity

---

## 2. Layout — Elevated Center

### 2.1 Structure

```
┌─────────────────────────────────────────────┐
│ Team │ Channel  │     Content Area      │ Members │
│ Side │ Sidebar  │   (elevated, lighter) │  List   │
│ bar  │          │                       │         │
│      │          │                       │         │
│ dark │  dark    │    shadow lifts       │  dark   │
│ est  │          │    this forward       │         │
└─────────────────────────────────────────────┘
```

- Team sidebar: `--bg-tertiary` (darkest)
- Channel sidebar: `--bg-secondary` (dark)
- Content area: `--bg-primary` (lightest) + `box-shadow: -4px 0 40px rgba(0,0,0,0.5), 4px 0 40px rgba(0,0,0,0.5)`
- Member list: `--bg-secondary` (dark)
- No backdrop-filter blur on fixed panels (CPU savings)
- Hairline borders (`rgba(255,255,255,0.03)`) between panels

### 2.2 Airy Luxe Spacing

Generous padding throughout:
- Channel items: `9px 14px` with `12px` radius
- Message groups: `var(--spacing-xl)` margin between groups
- Messages: `14px` font size, `1.65` line height
- Composer: `24px` side margins
- Content header: `54px` height, `22px` horizontal padding
- Member list: `18px` padding

---

## 3. Channel List — Compact + Unread Priority

### 3.1 Layout

```
┌──────────────────────┐
│ Server Name       ⚙  │
├──────────────────────┤
│ ⌕ Jump to...    ⌘K  │  ← Quick switcher search
├──────────────────────┤
│ UNREAD               │  ← Amber section header
│ ● ~ general      3   │  ← Active: glow border + brand bg
│   ~ dev-ops      1   │
├──────────────────────┤
│ ACTIVE VOICE         │
│ 🔊 lounge        2   │
│   ○ jonas  🎙        │
│   ○ alice            │
├──────────────────────┤
│ CHANNELS             │
│   ~ random           │
│   ~ design           │
│ 🔊 meeting           │
├──────────────────────┤
│ 👤 thim    Online    │  ← User panel at bottom
└──────────────────────┘
```

### 3.2 Active Channel

- Background: `rgba(14,165,192,0.06)`
- Border: `box-shadow: inset 0 0 0 1px rgba(14,165,192,0.12)`
- Tilde color: `rgba(14,165,192,0.5)`
- Text: `--text-primary`, weight 500

### 3.3 Unread Badge

- Background: `--accent` (#f59e0b)
- Color: `--bg-tertiary`
- Font: 9px, weight 700
- Radius: full pill

---

## 4. Message Experience

### 4.1 Compact Message Grouping

Consecutive messages from the same user within 5 minutes collapse — only the first shows avatar + name. Subsequent messages indent under it (padding-left matches avatar width + gap).

### 4.2 Message Hover

- Background: `rgba(255,255,255,0.02)` (very subtle)
- Action bar floats above: reply, emoji, thread, edit, delete
- Action bar: glass background with heavy blur, rounded `--radius-lg`

### 4.3 Reactions — Pill-shaped

Colored pills under message with emoji + count. Brand-tinted background. Click to add/remove.

### 4.4 Thread Previews

Inline preview under parent: stacked mini-avatars + "3 replies" + "Last reply 2m ago". Brand-tinted left border. Click to open thread panel.

### 4.5 Typing Indicator

Tiny avatar(s) of who's typing + animated 3-dot pulse. No text label.

### 4.6 Unread Divider

Red horizontal line with centered "NEW" label. Appears above the first unread message when entering a channel.

### 4.7 Date Dividers

Centered pill with date text. Hairline borders extending to edges. Background: `rgba(255,255,255,0.02)`, border: `rgba(255,255,255,0.04)`.

### 4.8 Scroll-to-Bottom Pill

Floating brand-colored pill at bottom center: "↓ 3 new messages". Click to jump to latest. Shadow for depth.

### 4.9 Link Previews

Rich embed card with left brand-colored border. Shows: domain, title, description. Rounded corners.

### 4.10 Syntax-Highlighted Code Blocks

Language tag + copy button in header bar. Dark background, syntax colors. Rounded `--radius-lg`.

### 4.11 Image Lightbox

Click image → full-screen dark overlay. Arrow keys to browse. Close button top-right.

### 4.12 Inline Message Editing

Press ↑ or click Edit → message becomes editable textarea in-place. Brand border. ESC to cancel, Enter to save.

### 4.13 Reply Preview

When replying, show preview bar above composer with original message. Brand left border. X to cancel.

### 4.14 @Mention Autocomplete

Type @ → dropdown with avatars + fuzzy search. Tab/Enter to insert. Mentions highlighted in brand color.

---

## 5. Composer — Slack-style Bottom Bar

### 5.1 Layout

```
┌─────────────────────────────────────────┐
│ Text input area                         │
│ (auto-resize, max 300px)                │
├─────────────────────────────────────────┤
│ + │ B I S │ <> 🔗 │ ≡ ❝ │ 😊    → │
└─────────────────────────────────────────┘
```

- Text area on top, formatting + actions in one bottom row
- Background: `--bg-secondary` with glass border
- Side margins: `var(--spacing-xl)`
- Gradient fade above composer (pseudo-element)
- Send button: brand-colored when content present, with glow

### 5.2 Formatting Toolbar

Bottom row: file attach (+), separator, bold/italic/strikethrough, separator, code/link, separator, list/quote, separator, emoji, send button at far right.

### 5.3 File Upload

Progress bar in composer area. File card with icon, name, size, cancel button.

### 5.4 Emoji Picker

Dark glass picker matching app theme. Search bar, recent emojis, categories.

---

## 6. Voice & Video

### 6.1 Dynamic Grid

Auto-adapting layout:
- 1 person: centered hero tile
- 2 people: side by side
- 3-4: 2×2 grid
- 5+: auto-fill grid

### 6.2 Active Speaker

Current speaker gets:
- Green ring: `box-shadow: 0 0 0 2px bg, 0 0 0 4px #22c55e, 0 0 16px rgba(34,197,94,0.2)`
- Subtle scale-up (1.02)
- Others dim to 60% opacity

### 6.3 Screen Share

80% view for shared screen, horizontal filmstrip at bottom for participants. Click filmstrip tile to swap focus. "LIVE" badge on sharer.

### 6.4 Voice Control Bar

Centered layout: connection status + duration on left, action buttons center (mute, deafen, camera, screen, disconnect), connection quality bars on right.

### 6.5 Picture-in-Picture

When browsing text during voice call: floating mini preview in corner. Draggable. Shows participant tiles + channel name. Click to return to voice view.

### 6.6 Noise Suppression

Toggle button with badge. Green when active. Uses RNNoise WASM.

### 6.7 Sound Effects

Emoji soundboard button in voice controls. Grid of quick reactions: 👏 😂 🎉 👀 📯.

---

## 7. Login Page — Atmospheric Minimal Split Panel

### 7.1 Layout

- Left 40%: Giant logo (60px squircle) with ambient glow orbs (teal + amber blurred circles). Tagline: "The chat platform that respects you."
- Right 60%: Sign-in form with server input, identity card (avatar + name + fingerprint + online ring), passkey button, recovery/new identity links.
- No feature list — visual confidence.

### 7.2 Identity Card

Shows the saved identity with squircle avatar, username, truncated public key in monospace, and online presence ring.

---

## 8. Navigation & Settings

### 8.1 ⌘K Quick Switcher

Modal with search input. Fuzzy matching across channels, DMs, users. Highlighted matches. Keyboard navigation (↑↓ to select, Enter to go).

### 8.2 Team Sidebar

- Squircle team icons with pill indicator on active
- Separator between servers and add button
- Add button: dashed border, brand tint
- Notification badges: red count for mentions, amber dot for unreads
- Tooltips on hover with server name

### 8.3 Server Picker Modal

Join by invite, create new, or browse federated. Step-by-step flow.

### 8.4 E2E Encryption Indicators

Green shield next to encrypted channels. Amber warning for unverified sessions.

### 8.5 Pinned Messages Panel

Header pin icon → panel with all pinned messages. Compact card layout.

### 8.6 Context Menus

Glass background with blur. Grouped sections. Keyboard shortcuts displayed. Danger items in red.

### 8.7 User Popover

Click username → mini profile card: large avatar, banner gradient, roles, quick actions (DM, mention).

### 8.8 Keyboard Shortcuts

Shown in tooltips, context menus. ⌘? opens full overlay.

---

## 9. Transitions & Animation

### 9.1 Page Transitions

- Channel switch: crossfade 200ms ease-out
- Thread panel: slide from right, spring 300ms
- Modals: scale from 0.95 + fade, spring 250ms
- Nothing just "appears"

### 9.2 Micro-interactions

- Button press: `transform: scale(0.98)` on active
- Hover: smooth color transitions 150ms
- Focus: brand glow ring
- Avatar hover: subtle glow in user's color

---

## 10. Loading & Error States

### 10.1 Skeleton Loading

Pulsing shimmer placeholders matching message layout. Used when loading channels, messages, member list.

### 10.2 Beautiful Empty States

Branded messages with emoji + helpful text for empty channels, no DMs, etc.

### 10.3 Connection Status Bar

Slim bar at top:
- Red: disconnected, "Retrying..."
- Amber: reconnecting
- Green flash: restored

### 10.4 Toast Notifications

Slide in from top-right. Avatar + sender + message preview. Click to jump.

---

## 11. Mobile

### 11.1 Swipe Gestures

- Right swipe: open channel list
- Left swipe: open member list
- Swipe message left: reply

### 11.2 Theme Picker

Visual theme cards in settings. Live preview on hover. Midnight Teal default.

---

## 12. Technical Constraints

- **No Tailwind CSS** — use CSS custom properties and component CSS files
- **Plus Jakarta Sans** — self-hosted woff2 (download and add to `client/public/fonts/`)
- **Tabler Icons** — `@tabler/icons-react` npm package, tree-shakeable
- **Existing component structure** — change CSS and TSX, not the architecture
- **All values use design tokens** — no hardcoded px values
- **WCAG AA contrast** — maintain ≥4.5:1 for normal text, ≥3:1 for large text

---

## 13. Implementation Priority

### Phase 1: Foundation (must-have for v3)
1. Color palette + typography + icon library swap
2. Layout: Elevated Center + Airy Luxe spacing
3. Squircle avatars + presence rings
4. Channel list: Compact + Unread Priority
5. Composer: Slack-style bottom bar
6. Login page: Atmospheric Minimal Split Panel
7. Skeleton loading states

### Phase 2: Chat Polish
8. Compact message grouping
9. Hover action bar
10. Pill-shaped reactions
11. Inline thread previews
12. Unread divider + date dividers
13. Scroll-to-bottom pill
14. Reply preview above input
15. Inline message editing
16. Typing indicator with avatars

### Phase 3: Power Features
17. ⌘K quick switcher
18. @Mention autocomplete
19. Link previews / embeds
20. Syntax-highlighted code blocks
21. Image lightbox
22. Themed emoji picker
23. Smart formatting toolbar
24. Glass context menus
25. Rich user popover
26. Pinned messages panel

### Phase 4: Voice & Video
27. Dynamic voice grid
28. Active speaker highlight
29. Screen share: focus + filmstrip
30. Bottom voice control bar
31. Picture-in-Picture
32. Noise suppression toggle
33. Sound effects / reactions

### Phase 5: Polish & Mobile
34. Silky page transitions
35. Beautiful empty states
36. Rich toast notifications
37. Connection status bar
38. Keyboard shortcuts everywhere
39. Server notification badges
40. Team sidebar tooltips
41. E2E encryption indicators
42. Server picker modal
43. File upload progress
44. Mobile swipe gestures
45. Theme picker in settings
46. Inline image/file previews
