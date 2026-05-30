# Mesh Text Channel Visual Refresh Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Apply Mesh visual treatment to the text-channel surface — message list (rows, day dividers, system messages, reactions, hover toolbar, reply chips), message composer (pill-shaped input, focus ring, formatting toolbar, typing indicator), and the channel view shell (header, empty state).

**Architecture:** CSS-only edits to existing files. No JSX/TSX/store changes. All existing behavior preserved.

**Scope guardrails:**
- ❌ No new components, no new tokens, no behavior changes
- ❌ No replacement of message-row JSX structure
- ❌ No slash-command / mention-popup / emoji-picker styling rewrite (separate follow-ons)
- ✅ MessageList.css, MessageInput.css, ChannelView CSS rules consumed via existing class names
- ✅ Mesh tokens applied with fallbacks for legacy themes

---

## Files

**Modify:**
- `client/src/components/MessageList/MessageList.css`
- `client/src/components/MessageInput/MessageInput.css`
- `client/src/pages/ChannelView.tsx` — possibly `ChannelView.css` if exists (check)

---

### Task 1: Inspect existing class names

- [ ] List class names for the three files. Use `grep -E "^\.[a-z]"` per file.

### Task 2: MessageList.css rewrite

- [ ] Replace MessageList.css applying Mesh tokens:
  - Rows: `font-family: var(--font-ui)`, hover background `var(--surface-2)`
  - Day divider: mono uppercase
  - System messages: italic, fg-3
  - Avatar: 2px radius, mono initial fallback
  - Author: display font, accent on hover
  - Time: mono micro
  - Reactions: pill with accent border when you reacted
  - Hover toolbar: floating right, surface bg, accent border
  - Reply chip: accent left bar
  - Code blocks: surface-2 bg, mono, hairline border
  - Mentions: amber pill for @user, accent for @everyone (broadcast outline)

### Task 3: MessageInput.css rewrite

- [ ] Replace MessageInput.css applying Mesh tokens:
  - Wrapper: bottom padding, optional top border-top hairline
  - Composer: pill-shaped (rounded full or 2px brutalist — go brutalist with 2px), focus ring `1px solid var(--accent)`
  - Textarea: transparent bg, body font
  - Action buttons: 32×32, ghost style
  - Send button: accent fill when text present
  - Drag overlay: accent dashed border
  - Upload tray: stacked rows, mono progress
  - Typing indicator: mono "USER1 IS TYPING…"

### Task 4: ChannelView verify (no CSS file expected; styles in AppLayout.css already)

- [ ] Confirm ChannelView has no own CSS or update if it does

### Task 5: Verify

- [ ] `npm test -- --run` passes
- [ ] type-check + lint clean
- [ ] commit per file, plus plan doc at end

---

## Done When

- Message list renders with mono typography for meta, brutalist edges, accent reactions
- Composer is pill-edged with focus ring
- All existing tests pass
