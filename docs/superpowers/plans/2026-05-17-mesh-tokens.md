# Mesh Design Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Mesh design-token layer (colors, mono typography, brutalist radii, density modes) as a fourth selectable theme alongside dark/light/minimal — without touching any existing component styling. No visible UI change occurs until later plans (#2 layout shell onward) consume the new tokens.

**Architecture:**
The existing theme system applies tokens by calling `document.documentElement.style.setProperty(key, value)` for every key in a `ThemeColors` object (`client/src/themes/themes.ts`), driven by `themeStore` and persisted via `userSettingsStore`. Mesh slots into that system as a new `meshTheme` entry that (a) provides the new Mesh-native token names (`--bg`, `--fg`, `--hairline`, `--accent-2`, `--accent-ink`, `--accent-soft`, etc.) used by upcoming Mesh components, AND (b) re-points the legacy tokens (`--bg-primary`, `--text-primary`, `--accent`, ...) at Mesh equivalents so existing components don't visually shatter if Mesh is selected mid-redesign. Mesh also overrides the structural typography + radii tokens that `base-tokens.css` defines (mono stack, 0–3px radii). Density is added as a separate user-settings field (`density: 'compact' | 'regular' | 'cozy'`) wired to a `data-density` attribute on `<html>`, with CSS rules in `base-tokens.css` mapping each value to a set of density tokens.

**Tech Stack:** TypeScript, Zustand (`client/src/stores/`), CSS custom properties, Vitest (jsdom unit + happy-dom DOM assertions). No new deps.

**Scope guardrails:**
- ❌ No changes to any existing component (`AppLayout`, sidebars, message rows, etc.)
- ❌ No "Tweaks" prototyping panel — handoff explicitly says don't ship it
- ❌ No accent-hue variants (amber/cyan/magenta) — deferred to settings-modal plan
- ❌ No first-paint/FOUC optimization — accepted as known limitation, addressed later
- ✅ Mesh theme appears in the theme union and can be selected programmatically; the settings-UI exposure happens in plan #7 (settings modal)

---

## File Structure

**Modify:**
- `client/src/themes/themes.ts` — add `meshTheme: ThemeColors` constant, exported alongside the others
- `client/src/stores/userSettingsStore.ts` — extend `theme` union to include `'mesh'`; add `density` field + setter; bump persist version & write migration
- `client/src/stores/themeStore.ts` — handle `'mesh'` branch; apply density via `data-density` attribute; subscribe to density changes
- `client/src/styles/base-tokens.css` — add density token defaults and `[data-density="compact|regular|cozy"]` overrides
- `client/src/stores/themeStore.test.ts` — add Mesh + density coverage
- `client/src/stores/userSettingsStore.test.ts` — confirm density round-trips through persist

**Create:**
- `client/src/themes/themes.test.ts` — unit tests on the `meshTheme` object shape

Each file has one responsibility: `themes.ts` is data, `themeStore` is application/DOM side-effects, `userSettingsStore` is persistence, `base-tokens.css` is the density rule sheet.

---

## Reference Token Set

These values come directly from `design_handoff_dilla_mesh/README.md` §Design Tokens. The plan tasks below reference this section by name — keep it as the source of truth.

**Mesh-native color tokens (NEW names):**
```
--bg:           #070809
--bg-2:         #0C0D0F
--bg-3:         #101214
--surface:      #0C0D0F
--surface-2:    #14171A
--surface-hi:   #1A1E22
--hairline:     #1F2226
--hairline-2:   #363B41
--fg:           #E8ECE8
--fg-2:         #A0A6A0
--fg-3:         #5E635E
--fg-link:      #7CFF8E
--accent:       #7CFF8E
--accent-2:     #A8FFB6
--accent-ink:   #06150A
--accent-soft:  rgba(124,255,142,0.14)
--danger:       #FF6E6E
--warn:         #FFD16A
--ok:           #7CFF8E
--mention:      #FFD16A
```

**Brutalist radii (override base-tokens):**
```
--r-sm:    0px
--r-md:    2px
--r-lg:    3px
--r-pill:  0px
--avatar-shape: 2px
--radius-sm:   0px     /* legacy alias, repointed */
--radius-md:   2px
--radius-lg:   3px
--radius-xl:   3px
--radius-full: 9999px  /* preserved — reactions/status pills opt in explicitly */
```

**Typography (override base-tokens, all JetBrains Mono):**
```
--font-display: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace
--font-body:    'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace
--font-mono:    'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace
--font-ui:      'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace
--fw-display: 700
--fw-body: 420
--display-tracking: 0.01em
```

**Shadows:**
```
--shadow-1: 0 0 0 1px rgba(124,255,142,0.08)
--shadow-2: 0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)
```

**Legacy-token remap (so existing components don't break when Mesh is on):**
```
--bg-primary       → var(--bg)
--bg-secondary     → var(--bg-2)
--bg-tertiary      → var(--bg-3)
--bg-floating      → var(--surface)
--modal-bg         → var(--surface)
--text-primary     → var(--fg)
--text-normal      → var(--fg-2)
--text-secondary   → var(--fg-2)
--text-muted       → var(--fg-3)
--text-link        → var(--fg-link)
--text-positive    → var(--ok)
--text-danger      → var(--danger)
--text-warning     → var(--warn)
--header-primary   → var(--fg)
--header-secondary → var(--fg-2)
--border-color     → var(--hairline)
--border-subtle    → var(--hairline)
--divider          → var(--hairline)
--accent           → var(--accent)
--accent-hover     → var(--accent-2)
--brand-500        → var(--accent)
--brand-560        → var(--accent-2)
--danger           → var(--danger)
--success          → var(--ok)
--warning          → var(--warn)
--interactive-normal → var(--fg-2)
--interactive-hover  → var(--fg)
--interactive-active → var(--fg)
--interactive-muted  → var(--fg-3)
--status-online    → var(--ok)
--status-idle      → var(--warn)
--status-dnd       → var(--danger)
--color-encrypted  → var(--ok)
```
The legacy tokens get *concrete computed values* (not `var()` references) in the JS object — when `themeStore` applies via `style.setProperty`, only literal strings work. Compute them inline.

**Density token sets (applied via `[data-density]` selectors in `base-tokens.css`, not via JS):**
```
--row-pad-y / --row-pad-x / --row-gap / --group-gap / --avatar-size

compact:  4px  / 16px / 0   / 8px  / 28px
regular:  6px  / 18px / 2px / 14px / 32px
cozy:     10px / 20px / 4px / 22px / 36px
```

---

### Task 1: Lock the token-set reference with a unit test

**Files:**
- Create: `client/src/themes/themes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// client/src/themes/themes.test.ts
import { describe, it, expect } from 'vitest';
import { darkTheme, lightTheme, minimalTheme, meshTheme } from './themes';

describe('themes registry', () => {
  it('exports the three legacy themes unchanged', () => {
    expect(darkTheme['--bg-primary']).toBe('#111c25');
    expect(lightTheme['--bg-primary']).toBe('#ffffff');
    expect(minimalTheme['--bg-primary']).toBe('#1a1a1a');
  });
});

describe('meshTheme', () => {
  it('exposes Mesh-native color tokens', () => {
    expect(meshTheme['--bg']).toBe('#070809');
    expect(meshTheme['--bg-2']).toBe('#0C0D0F');
    expect(meshTheme['--surface']).toBe('#0C0D0F');
    expect(meshTheme['--surface-2']).toBe('#14171A');
    expect(meshTheme['--hairline']).toBe('#1F2226');
    expect(meshTheme['--fg']).toBe('#E8ECE8');
    expect(meshTheme['--fg-2']).toBe('#A0A6A0');
    expect(meshTheme['--fg-3']).toBe('#5E635E');
    expect(meshTheme['--accent']).toBe('#7CFF8E');
    expect(meshTheme['--accent-2']).toBe('#A8FFB6');
    expect(meshTheme['--accent-ink']).toBe('#06150A');
    expect(meshTheme['--accent-soft']).toBe('rgba(124,255,142,0.14)');
    expect(meshTheme['--danger']).toBe('#FF6E6E');
    expect(meshTheme['--warn']).toBe('#FFD16A');
    expect(meshTheme['--ok']).toBe('#7CFF8E');
    expect(meshTheme['--mention']).toBe('#FFD16A');
  });

  it('remaps legacy tokens to Mesh equivalents', () => {
    expect(meshTheme['--bg-primary']).toBe('#070809');
    expect(meshTheme['--bg-secondary']).toBe('#0C0D0F');
    expect(meshTheme['--text-primary']).toBe('#E8ECE8');
    expect(meshTheme['--text-link']).toBe('#7CFF8E');
    expect(meshTheme['--accent']).toBe('#7CFF8E');
    expect(meshTheme['--accent-hover']).toBe('#A8FFB6');
    expect(meshTheme['--status-online']).toBe('#7CFF8E');
    expect(meshTheme['--color-encrypted']).toBe('#7CFF8E');
  });

  it('overrides typography tokens to JetBrains Mono', () => {
    expect(meshTheme['--font-display']).toMatch(/JetBrains Mono/);
    expect(meshTheme['--font-body']).toMatch(/JetBrains Mono/);
    expect(meshTheme['--font-ui']).toMatch(/JetBrains Mono/);
    expect(meshTheme['--fw-display']).toBe('700');
    expect(meshTheme['--fw-body']).toBe('420');
    expect(meshTheme['--display-tracking']).toBe('0.01em');
  });

  it('overrides radii to brutalist values', () => {
    expect(meshTheme['--radius-sm']).toBe('0px');
    expect(meshTheme['--radius-md']).toBe('2px');
    expect(meshTheme['--radius-lg']).toBe('3px');
    expect(meshTheme['--radius-xl']).toBe('3px');
    expect(meshTheme['--r-sm']).toBe('0px');
    expect(meshTheme['--r-md']).toBe('2px');
    expect(meshTheme['--r-lg']).toBe('3px');
    expect(meshTheme['--r-pill']).toBe('0px');
    expect(meshTheme['--avatar-shape']).toBe('2px');
  });

  it('exposes Mesh shadow tokens', () => {
    expect(meshTheme['--shadow-1']).toBe('0 0 0 1px rgba(124,255,142,0.08)');
    expect(meshTheme['--shadow-2']).toBe(
      '0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/themes/themes.test.ts`
Expected: FAIL — `meshTheme` is not exported from `./themes`.

- [ ] **Step 3: Commit the failing test**

```bash
git add client/src/themes/themes.test.ts
git commit -m "test: add meshTheme token-shape contract"
```

---

### Task 2: Implement the `meshTheme` constant

**Files:**
- Modify: `client/src/themes/themes.ts` (append after `minimalTheme`, do not edit existing exports)

- [ ] **Step 1: Append `meshTheme` export**

Add this block at the end of `client/src/themes/themes.ts` (after the closing `};` of `minimalTheme`):

```typescript
export const meshTheme: ThemeColors = {
  /* Mesh-native palette (see design_handoff_dilla_mesh/README.md §Design Tokens) */
  '--bg': '#070809',
  '--bg-2': '#0C0D0F',
  '--bg-3': '#101214',
  '--surface': '#0C0D0F',
  '--surface-2': '#14171A',
  '--surface-hi': '#1A1E22',
  '--hairline': '#1F2226',
  '--hairline-2': '#363B41',
  '--fg': '#E8ECE8',
  '--fg-2': '#A0A6A0',
  '--fg-3': '#5E635E',
  '--fg-link': '#7CFF8E',
  '--accent': '#7CFF8E',
  '--accent-2': '#A8FFB6',
  '--accent-ink': '#06150A',
  '--accent-soft': 'rgba(124,255,142,0.14)',
  '--danger': '#FF6E6E',
  '--warn': '#FFD16A',
  '--ok': '#7CFF8E',
  '--mention': '#FFD16A',

  /* Typography — mono everywhere */
  '--font-display':
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  '--font-body':
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  '--font-ui':
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  '--font-mono':
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  '--fw-display': '700',
  '--fw-body': '420',
  '--display-tracking': '0.01em',

  /* Brutalist radii — keep --radius-full alone (reactions/pills opt in) */
  '--r-sm': '0px',
  '--r-md': '2px',
  '--r-lg': '3px',
  '--r-pill': '0px',
  '--avatar-shape': '2px',
  '--radius-sm': '0px',
  '--radius-md': '2px',
  '--radius-lg': '3px',
  '--radius-xl': '3px',

  /* Shadows */
  '--shadow-1': '0 0 0 1px rgba(124,255,142,0.08)',
  '--shadow-2':
    '0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)',

  /* Legacy-token remap — existing components keep working when Mesh is on */
  '--bg-primary': '#070809',
  '--bg-secondary': '#0C0D0F',
  '--bg-tertiary': '#101214',
  '--bg-floating': '#0C0D0F',
  '--bg-modifier-hover': 'rgba(232, 236, 232, 0.04)',
  '--bg-modifier-active': 'rgba(232, 236, 232, 0.08)',
  '--bg-modifier-selected': 'rgba(232, 236, 232, 0.12)',
  '--bg-accent': '#7CFF8E',
  '--bg-accent-hover': '#A8FFB6',
  '--text-primary': '#E8ECE8',
  '--text-normal': '#A0A6A0',
  '--text-secondary': '#A0A6A0',
  '--text-muted': '#5E635E',
  '--text-link': '#7CFF8E',
  '--text-positive': '#7CFF8E',
  '--text-danger': '#FF6E6E',
  '--text-warning': '#FFD16A',
  '--header-primary': '#E8ECE8',
  '--header-secondary': '#A0A6A0',
  '--border-color': '#1F2226',
  '--border-subtle': '#1F2226',
  '--divider': '#1F2226',
  '--accent-hover': '#A8FFB6',
  '--brand-500': '#7CFF8E',
  '--brand-560': '#A8FFB6',
  '--success': '#7CFF8E',
  '--warning': '#FFD16A',
  '--hover': 'rgba(232, 236, 232, 0.04)',
  '--active': 'rgba(232, 236, 232, 0.08)',
  '--interactive-normal': '#A0A6A0',
  '--interactive-hover': '#E8ECE8',
  '--interactive-active': '#E8ECE8',
  '--interactive-muted': '#5E635E',
  '--channel-icon': '#5E635E',
  '--status-online': '#7CFF8E',
  '--status-idle': '#FFD16A',
  '--status-dnd': '#FF6E6E',
  '--status-offline': '#5E635E',
  '--scrollbar-thin-thumb': 'rgba(232, 236, 232, 0.08)',
  '--scrollbar-thin-track': 'transparent',
  '--modal-bg': '#0C0D0F',
  '--input-bg': '#14171A',
  '--color-encrypted': '#7CFF8E',
  '--shadow-glow-brand': '0 0 20px rgba(124, 255, 142, 0.25)',
  '--shadow-glow-accent': '0 0 20px rgba(124, 255, 142, 0.25)',

  /* Glass — Mesh is matte; collapse blur to 0 so backdrops look flat */
  '--glass-blur': '0px',
  '--glass-blur-heavy': '0px',
  '--glass-blur-light': '0px',
  '--glass-bg-primary': '#070809',
  '--glass-bg-secondary': '#0C0D0F',
  '--glass-bg-tertiary': '#101214',
  '--glass-bg-floating': '#0C0D0F',
  '--glass-bg-modal': '#0C0D0F',
  '--glass-border': '#1F2226',
  '--glass-border-light': '#1F2226',
  '--glass-highlight': 'rgba(232, 236, 232, 0.04)',
  '--glass-shadow': '0 0 0 1px rgba(124,255,142,0.08)',
  '--glass-shadow-elevated':
    '0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)',

  /* Gradients — Mesh prefers flat fills; keep tokens defined but neutral */
  '--gradient-brand': 'linear-gradient(135deg, #7CFF8E 0%, #5BD66E 100%)',
  '--gradient-accent': 'linear-gradient(135deg, #7CFF8E 0%, #5BD66E 100%)',
  '--gradient-surface':
    'linear-gradient(180deg, rgba(232, 236, 232, 0.02) 0%, transparent 100%)',

  /* Overlays */
  '--overlay-dark': 'rgba(0, 0, 0, 0.6)',
  '--overlay-light': 'rgba(0, 0, 0, 0.2)',
  '--overlay-heavy': 'rgba(0, 0, 0, 0.85)',
  '--white-overlay-subtle': 'rgba(232, 236, 232, 0.04)',
  '--white-overlay-light': 'rgba(232, 236, 232, 0.08)',
  '--white-overlay-medium': 'rgba(232, 236, 232, 0.7)',

  /* Accent alpha variants (Mesh accent is green) */
  '--brand-alpha-10': 'rgba(124, 255, 142, 0.10)',
  '--brand-alpha-12': 'rgba(124, 255, 142, 0.12)',
  '--brand-alpha-15': 'rgba(124, 255, 142, 0.15)',
  '--brand-alpha-20': 'rgba(124, 255, 142, 0.20)',
  '--brand-alpha-25': 'rgba(124, 255, 142, 0.25)',
  '--accent-alpha-08': 'rgba(124, 255, 142, 0.08)',
  '--accent-alpha-10': 'rgba(124, 255, 142, 0.10)',
  '--accent-alpha-15': 'rgba(124, 255, 142, 0.15)',
  '--accent-alpha-20': 'rgba(124, 255, 142, 0.20)',
  '--accent-alpha-25': 'rgba(124, 255, 142, 0.25)',
  '--accent-alpha-30': 'rgba(124, 255, 142, 0.30)',
  '--danger-alpha-15': 'rgba(255, 110, 110, 0.15)',
  '--danger-alpha-25': 'rgba(255, 110, 110, 0.25)',
  '--success-alpha-15': 'rgba(124, 255, 142, 0.15)',
  '--success-alpha-35': 'rgba(124, 255, 142, 0.35)',
  '--success-alpha-40': 'rgba(124, 255, 142, 0.40)',

  /* Status extras */
  '--green-360': '#7CFF8E',
  '--yellow-300': '#FFD16A',
  '--red-400': '#FF6E6E',
};
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd client && npx vitest run src/themes/themes.test.ts`
Expected: PASS, all 5 cases green.

- [ ] **Step 3: Commit**

```bash
git add client/src/themes/themes.ts
git commit -m "feat(theme): add Mesh palette, typography, and radii tokens"
```

---

### Task 3: Extend the theme union and wire `themeStore` to apply Mesh

**Files:**
- Modify: `client/src/stores/userSettingsStore.ts:12,21` (the `theme` field + setter signature)
- Modify: `client/src/stores/themeStore.ts:5-20,22` (apply function + state union)
- Modify: `client/src/stores/themeStore.test.ts` (add Mesh case)

- [ ] **Step 1: Write the failing test**

Append to `client/src/stores/themeStore.test.ts`:

```typescript
  it('syncs when userSettingsStore theme changes to mesh', () => {
    useUserSettingsStore.getState().setTheme('mesh');
    expect(useThemeStore.getState().theme).toBe('mesh');
    expect(document.documentElement.dataset.theme).toBe('mesh');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('applies mesh-native tokens when mesh theme selected', () => {
    useUserSettingsStore.getState().setTheme('mesh');
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--bg')).toBe('#070809');
    expect(root.style.getPropertyValue('--accent')).toBe('#7CFF8E');
    expect(root.style.getPropertyValue('--fg')).toBe('#E8ECE8');
    // Legacy tokens get repointed to Mesh equivalents
    expect(root.style.getPropertyValue('--bg-primary')).toBe('#070809');
    expect(root.style.getPropertyValue('--text-primary')).toBe('#E8ECE8');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/stores/themeStore.test.ts`
Expected: FAIL — `setTheme('mesh')` is a TypeScript error and runtime no-op.

- [ ] **Step 3: Widen the type union in `userSettingsStore.ts`**

Change line 12: `theme: 'dark' | 'light' | 'minimal';` → `theme: 'dark' | 'light' | 'minimal' | 'mesh';`
Change line 21: `setTheme: (v: 'dark' | 'light' | 'minimal') => void;` → `setTheme: (v: 'dark' | 'light' | 'minimal' | 'mesh') => void;`

- [ ] **Step 4: Update `themeStore.ts` to apply Mesh**

Replace the body of `applyTheme` and the state type:

```typescript
import { create } from 'zustand';
import { darkTheme, lightTheme, meshTheme, minimalTheme } from '../themes/themes';
import { useUserSettingsStore } from './userSettingsStore';

type ThemeName = 'dark' | 'light' | 'minimal' | 'mesh';

function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  let colors;
  if (theme === 'light') {
    colors = lightTheme;
  } else if (theme === 'minimal') {
    colors = minimalTheme;
  } else if (theme === 'mesh') {
    colors = meshTheme;
  } else {
    colors = darkTheme;
  }
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

interface ThemeState {
  theme: ThemeName;
}

export const useThemeStore = create<ThemeState>(() => {
  const theme = useUserSettingsStore.getState().theme;
  applyTheme(theme);
  return { theme };
});

useUserSettingsStore.subscribe((state) => {
  const current = useThemeStore.getState().theme;
  if (state.theme !== current) {
    applyTheme(state.theme);
    useThemeStore.setState({ theme: state.theme });
  }
});
```

- [ ] **Step 5: Run all theme-related tests**

Run: `cd client && npx vitest run src/stores/themeStore.test.ts src/themes/themes.test.ts`
Expected: PASS, all cases green (prior 4 + new 2).

- [ ] **Step 6: Type-check the whole client**

Run: `cd client && npx tsc -b --noEmit`
Expected: zero errors. If there are errors elsewhere it means a consumer narrowed on the old `'dark' | 'light' | 'minimal'` literal; widen it.

- [ ] **Step 7: Commit**

```bash
git add client/src/stores/userSettingsStore.ts \
        client/src/stores/themeStore.ts \
        client/src/stores/themeStore.test.ts
git commit -m "feat(theme): wire mesh into themeStore and userSettingsStore"
```

---

### Task 4: Add density to `userSettingsStore` + persist migration

**Files:**
- Modify: `client/src/stores/userSettingsStore.ts` (new field, setter, migration, default `'regular'`)
- Modify: `client/src/stores/userSettingsStore.test.ts` (round-trip test)

- [ ] **Step 1: Write the failing test**

Add to `client/src/stores/userSettingsStore.test.ts`:

```typescript
  it('exposes density default of regular and updates via setter', () => {
    expect(useUserSettingsStore.getState().density).toBe('regular');
    useUserSettingsStore.getState().setDensity('compact');
    expect(useUserSettingsStore.getState().density).toBe('compact');
    useUserSettingsStore.getState().setDensity('cozy');
    expect(useUserSettingsStore.getState().density).toBe('cozy');
  });
```

(If `userSettingsStore.test.ts` already has setup that resets localStorage between tests, reuse it. If not, add `beforeEach(() => useUserSettingsStore.setState({ density: 'regular' }))` near the top.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/stores/userSettingsStore.test.ts`
Expected: FAIL — `density` is undefined and `setDensity` doesn't exist.

- [ ] **Step 3: Add `density` field**

In `client/src/stores/userSettingsStore.ts`:

- Add to the interface:
```typescript
  density: 'compact' | 'regular' | 'cozy';
  setDensity: (v: 'compact' | 'regular' | 'cozy') => void;
```
- Add to the initial state (alongside `theme: 'dark'`):
```typescript
      density: 'regular',
```
- Add the setter (alongside `setTheme`):
```typescript
      setDensity: (v) => set({ density: v }),
```
- Bump the persist version + add a migration so users who had an older persisted state get `density: 'regular'`:
```typescript
    {
      name: 'dilla-user-settings',
      version: 1,
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted as Partial<UserSettingsStore>) ?? {};
        if (version < 1) {
          return { ...state, density: 'regular' as const };
        }
        return state;
      },
    },
```

(If `name: 'dilla-user-settings'` is currently passed as a bare option object, expand it into the full `PersistOptions` shape with `version` + `migrate`.)

- [ ] **Step 4: Run test**

Run: `cd client && npx vitest run src/stores/userSettingsStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/userSettingsStore.ts \
        client/src/stores/userSettingsStore.test.ts
git commit -m "feat(settings): add density preference with persist migration"
```

---

### Task 5: Add density CSS rules to `base-tokens.css`

**Files:**
- Modify: `client/src/styles/base-tokens.css` (append after the existing `:root { ... }` block)

- [ ] **Step 1: Append density tokens + selectors**

Append to `client/src/styles/base-tokens.css`:

```css
/* Density modes — applied via [data-density] on <html> by themeStore */
:root {
  --row-pad-y: 6px;
  --row-pad-x: 18px;
  --row-gap: 2px;
  --group-gap: 14px;
  --avatar-size: 32px;
  --line-height-density: 1.5;
}

:root[data-density='compact'] {
  --row-pad-y: 4px;
  --row-pad-x: 16px;
  --row-gap: 0px;
  --group-gap: 8px;
  --avatar-size: 28px;
  --line-height-density: 1.4;
}

:root[data-density='regular'] {
  --row-pad-y: 6px;
  --row-pad-x: 18px;
  --row-gap: 2px;
  --group-gap: 14px;
  --avatar-size: 32px;
  --line-height-density: 1.5;
}

:root[data-density='cozy'] {
  --row-pad-y: 10px;
  --row-pad-x: 20px;
  --row-gap: 4px;
  --group-gap: 22px;
  --avatar-size: 36px;
  --line-height-density: 1.55;
}
```

- [ ] **Step 2: Verify the dev server still builds**

Run: `cd client && npx vite build --mode development 2>&1 | tail -20`
Expected: build finishes; no CSS parse errors mentioning `base-tokens.css`.
(If `vite build` is too slow as a verification, run `npx postcss src/styles/base-tokens.css -o /dev/null` instead.)

- [ ] **Step 3: Commit**

```bash
git add client/src/styles/base-tokens.css
git commit -m "feat(theme): add density token sets for compact/regular/cozy"
```

---

### Task 6: Wire density to `data-density` attribute in `themeStore`

**Files:**
- Modify: `client/src/stores/themeStore.ts`
- Modify: `client/src/stores/themeStore.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `client/src/stores/themeStore.test.ts`:

```typescript
  it('applies density as data-density on <html>', () => {
    useUserSettingsStore.getState().setDensity('compact');
    expect(document.documentElement.dataset.density).toBe('compact');
    useUserSettingsStore.getState().setDensity('cozy');
    expect(document.documentElement.dataset.density).toBe('cozy');
    useUserSettingsStore.getState().setDensity('regular');
    expect(document.documentElement.dataset.density).toBe('regular');
  });
```

Also extend the existing `beforeEach` to reset density:
```typescript
beforeEach(() => {
  useUserSettingsStore.setState({ theme: 'dark', density: 'regular' });
  useThemeStore.setState({ theme: 'dark' });
  document.documentElement.dataset.density = 'regular';
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/stores/themeStore.test.ts`
Expected: FAIL — density change is ignored, `dataset.density` is the initial value.

- [ ] **Step 3: Apply density in `themeStore.ts`**

Add an `applyDensity` function and call it from both initial creation and the subscription:

```typescript
function applyDensity(density: 'compact' | 'regular' | 'cozy') {
  document.documentElement.dataset.density = density;
}
```

In the `create` call, after `applyTheme(theme)`:
```typescript
  const density = useUserSettingsStore.getState().density;
  applyDensity(density);
```

Update the subscription to also react to density:
```typescript
useUserSettingsStore.subscribe((state) => {
  const current = useThemeStore.getState().theme;
  if (state.theme !== current) {
    applyTheme(state.theme);
    useThemeStore.setState({ theme: state.theme });
  }
  if (document.documentElement.dataset.density !== state.density) {
    applyDensity(state.density);
  }
});
```

- [ ] **Step 4: Run tests**

Run: `cd client && npx vitest run src/stores/themeStore.test.ts`
Expected: PASS, all density + theme cases green.

- [ ] **Step 5: Type-check**

Run: `cd client && npx tsc -b --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/themeStore.ts client/src/stores/themeStore.test.ts
git commit -m "feat(theme): apply density preference via data-density attribute"
```

---

### Task 7: Lint, full test pass, and final commit

- [ ] **Step 1: Lint**

Run: `cd client && npm run lint -- --max-warnings 0`
Expected: zero new warnings introduced. If existing warnings exist, note them but don't fix unrelated ones — out of scope.

- [ ] **Step 2: Run the full client test suite**

Run: `cd client && npm test -- --run`
Expected: full green. If any unrelated test fails, capture the baseline (`git stash` your changes, re-run) — if it was already failing on `main`, document and proceed.

- [ ] **Step 3: Manual smoke check via `npm run dev`**

```bash
cd client && npm run dev
```

Open <http://localhost:8888>. The app should look **identical** to main (this plan adds no visual change). In DevTools console, run:
```js
useUserSettingsStore.getState().setTheme('mesh')
```
Expected: `<html data-theme="mesh">`, computed style of `:root --bg` reports `#070809`, and the existing UI shifts to dark-green-on-near-black because the legacy tokens are remapped. Many components will look "wrong" — that's expected; the proper Mesh styling lands in plans #2+. Switch back: `setTheme('dark')` — restores baseline.

Also run `setDensity('compact')` and confirm `<html data-density="compact">` appears (no visual effect yet, since no component consumes the density tokens — also expected).

- [ ] **Step 4: Verification-before-completion**

Use the @superpowers:verification-before-completion checklist:
- [ ] `npx vitest run` passes
- [ ] `npx tsc -b --noEmit` clean
- [ ] `npm run lint` no new warnings
- [ ] Manual smoke confirmed theme + density toggle write to the DOM

- [ ] **Step 5: Final commit (only if any straggler files)**

If steps 1–4 already produced commits, this step is a no-op. If formatting touched anything:
```bash
git status
git add -A
git commit -m "chore: prettier/eslint cleanup for mesh tokens"
```

- [ ] **Step 6: Verify branch state**

Run: `git log --oneline main..HEAD`
Expected: a clean sequence of small commits (one per task), all conventional-commit prefixed.

---

## Done When

- `meshTheme` is exported from `client/src/themes/themes.ts` and round-trips through `themeStore`.
- `userSettingsStore.theme` includes `'mesh'`; `userSettingsStore.density` exists with `'compact' | 'regular' | 'cozy'` and persists.
- `<html>` carries `data-theme` and `data-density` attributes that update reactively.
- No visual change to the running app unless mesh is programmatically selected.
- All new + existing client tests pass; type-check clean; lint clean.
- Branch `feat/mesh-redesign` has 6–7 commits, ready for plan #2 (layout shell) to build on.

## Follow-on plans

1. ✅ Tokens (this plan)
2. Layout shell (4-column grid, resizable handles, optional top/bottom status bars)
3. Server rail + channel sidebar
4. Text channel (header + message rendering + composer)
5. Voice channel
6. Member sidebar + thread panel
7. Settings modal (this is where the Mesh theme + density selectors get exposed in UI)
8. Command palette + search palette
9. Onboarding wizard
10. Extras/overlays + backend rewiring
