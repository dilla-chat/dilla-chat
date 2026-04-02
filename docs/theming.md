# Theming Dilla

Self-hosted Dilla instances can be fully rebranded by supplying a custom CSS file that overrides the built-in visual design tokens. No build step or code change is required — drop a CSS file on the server and set one environment variable.

---

## Overview: Token Architecture

Dilla's styles are split into two layers:

| File | Purpose | Can I override? |
|------|---------|----------------|
| `base-tokens.css` | Structural tokens: font scale, spacing, border-radius, z-index, layout dimensions, transition timing | **No** — these drive layout math throughout the UI |
| `theme-default.css` | Visual tokens: colors, glass effects, gradients, overlays, shadows | **Yes** — every token in this file is a customisation point |

When a `DILLA_THEME_FILE` is configured the server injects that CSS file into the page **after** the built-in theme, so any `:root` variable you define will win.

---

## Quick Start

1. **Copy the template.**

   ```
   client/public/themes/custom-theme-template.css
   ```

   The template contains every visual token, commented out, with the built-in default values. You can also find it served at `https://<your-instance>/themes/custom-theme-template.css`.

2. **Uncomment and edit the tokens you want to change.**

   You only need to include the tokens you are actually overriding. Unset tokens fall back to the Gothenburg defaults automatically.

3. **Place the file where the Dilla server process can read it.**

   For example: `/etc/dilla/my-theme.css`

4. **Set the environment variable and restart.**

   ```bash
   DILLA_THEME_FILE=/etc/dilla/my-theme.css
   ```

   With Docker:

   ```yaml
   environment:
     - DILLA_THEME_FILE=/config/my-theme.css
   volumes:
     - ./my-theme.css:/config/my-theme.css:ro
   ```

5. **Verify.** Open your instance in a browser. The custom styles are applied at page load.

---

## Token Reference

### Backgrounds

| Token | Default | Description |
|-------|---------|-------------|
| `--bg-primary` | `#121c26` | Main chat area background |
| `--bg-secondary` | `#0c1218` | Sidebar background |
| `--bg-tertiary` | `#0a0e14` | Deepest background — outer shell, team sidebar |
| `--bg-floating` | `#1a2a38` | Dropdowns, tooltips, floating panels |
| `--bg-modifier-hover` | `rgba(143,163,184,0.12)` | List item hover overlay |
| `--bg-modifier-active` | `rgba(143,163,184,0.20)` | List item pressed overlay |
| `--bg-modifier-selected` | `rgba(143,163,184,0.28)` | List item selected overlay |
| `--bg-accent` | `#e8b84b` | Accent-colored button/badge background |
| `--bg-accent-hover` | `#f0ca6a` | Hover state for accent backgrounds |
| `--modal-bg` | `#0c1218` | Modal dialog background |
| `--input-bg` | `#0a1016` | Text input background |

### Text

| Token | Default | Description |
|-------|---------|-------------|
| `--text-normal` | `#e8edf2` | Default body text |
| `--text-primary` | `#f0f4f8` | Bright text — names, labels |
| `--text-secondary` | `#8fa3b8` | De-emphasised text — timestamps, captions |
| `--text-muted` | `#7a8e9e` | Placeholder text, disabled labels |
| `--text-link` | `#3ba8ba` | Hyperlinks |
| `--text-positive` | `#4caf82` | Success / positive indicators |
| `--text-danger` | `#d05a4a` | Error messages, destructive labels |
| `--text-warning` | `#e8b84b` | Warning messages |
| `--header-primary` | `#f0f4f8` | Panel and section headings |
| `--header-secondary` | `#8fa3b8` | Sub-headings |

### Brand

| Token | Default | Description |
|-------|---------|-------------|
| `--brand-500` | `#2e8b9a` | Primary brand hue |
| `--brand-560` | `#3ba8ba` | Lighter/hover brand variant |
| `--color-encrypted` | `#4caf82` | Lock icon color on E2E-encrypted kanals |
| `--shadow-glow-brand` | `0 0 16px rgba(46,139,154,0.3)` | Glow shadow on brand-colored elements |
| `--shadow-glow-accent` | `0 0 16px rgba(232,184,75,0.25)` | Glow shadow on accent-colored elements |

### Status

| Token | Default | Description |
|-------|---------|-------------|
| `--status-online` | `#4caf82` | Online presence dot |
| `--status-idle` | `#e8b84b` | Idle presence dot |
| `--status-dnd` | `#d05a4a` | Do Not Disturb presence dot |
| `--status-offline` | `#4d6478` | Offline presence dot |
| `--green-360` | `#4caf82` | Green semantic primitive |
| `--yellow-300` | `#e8b84b` | Yellow semantic primitive |
| `--red-400` | `#d05a4a` | Red semantic primitive |

### Interactive

| Token | Default | Description |
|-------|---------|-------------|
| `--channel-icon` | `#4d6478` | Default icon color in channel lists |
| `--interactive-normal` | `#8fa3b8` | Icon/control at rest |
| `--interactive-hover` | `#e8edf2` | Icon/control on hover |
| `--interactive-active` | `#ffffff` | Icon/control when pressed |
| `--interactive-muted` | `#2d4050` | Disabled icon/control |

### Borders

| Token | Default | Description |
|-------|---------|-------------|
| `--divider` | `rgba(143,163,184,0.08)` | Thin rule between list sections |
| `--border-color` | `rgba(143,163,184,0.10)` | Default component border |
| `--border-subtle` | `rgba(143,163,184,0.08)` | Lightest border variant |

### Glass Effects

| Token | Default | Description |
|-------|---------|-------------|
| `--glass-blur` | `12px` | Standard backdrop-filter blur |
| `--glass-blur-heavy` | `20px` | Heavy blur for modal overlays |
| `--glass-blur-light` | `8px` | Light blur for subtle panels |
| `--glass-bg-primary` | `rgba(18,28,38,0.85)` | Glass surface — primary bg tint |
| `--glass-bg-secondary` | `rgba(12,18,24,0.80)` | Glass surface — secondary bg tint |
| `--glass-bg-tertiary` | `rgba(10,14,20,0.90)` | Glass surface — tertiary bg tint |
| `--glass-bg-floating` | `rgba(26,42,56,0.90)` | Glass surface — floating panel tint |
| `--glass-bg-modal` | `rgba(12,18,24,0.92)` | Glass surface — modal tint |
| `--glass-border` | `rgba(143,163,184,0.12)` | Glass panel border |
| `--glass-border-light` | `rgba(143,163,184,0.06)` | Subtle glass border |
| `--glass-highlight` | `rgba(255,255,255,0.04)` | Top-edge highlight on glass surfaces |
| `--glass-shadow` | `0 8px 32px rgba(0,0,0,0.3)` | Glass panel drop shadow |
| `--glass-shadow-elevated` | `0 12px 48px rgba(0,0,0,0.4)` | Elevated glass panel drop shadow |

### Gradients

| Token | Default | Description |
|-------|---------|-------------|
| `--gradient-brand` | `linear-gradient(135deg, #2e8b9a 0%, #1e6b78 100%)` | Brand gradient — buttons, banners |
| `--gradient-accent` | `linear-gradient(135deg, #e8b84b 0%, #d4a03a 100%)` | Accent gradient |
| `--gradient-surface` | `linear-gradient(180deg, rgba(143,163,184,0.04) 0%, transparent 100%)` | Subtle surface sheen |

### Overlays

| Token | Default | Description |
|-------|---------|-------------|
| `--overlay-dark` | `rgba(0,0,0,0.5)` | Modal backdrop veil |
| `--overlay-light` | `rgba(0,0,0,0.15)` | Subtle content veil |
| `--overlay-heavy` | `rgba(0,0,0,0.85)` | Lightbox/fullscreen veil |
| `--white-overlay-subtle` | `rgba(255,255,255,0.06)` | Faint white sheen |
| `--white-overlay-light` | `rgba(255,255,255,0.1)` | Light white sheen |
| `--white-overlay-medium` | `rgba(255,255,255,0.7)` | Medium white sheen |

### Aliases

| Token | Default | Description |
|-------|---------|-------------|
| `--accent` | `#e8b84b` | Accent alias (mirrors `--bg-accent`) |
| `--accent-hover` | `#f0ca6a` | Accent hover alias |
| `--danger` | `#d05a4a` | Danger alias |
| `--success` | `#4caf82` | Success alias |
| `--warning` | `#e8b84b` | Warning alias |
| `--hover` | `rgba(143,163,184,0.12)` | Generic hover overlay alias |
| `--active` | `rgba(143,163,184,0.20)` | Generic active overlay alias |

### Alpha Variants

These are transparent versions of brand, accent, danger, and success. They power tinted backgrounds, focus rings, and highlight states. When you override a solid color, update the corresponding alpha variants to match the new RGB values.

| Token | Default |
|-------|---------|
| `--brand-alpha-10` | `rgba(46,139,154,0.1)` |
| `--brand-alpha-12` | `rgba(46,139,154,0.12)` |
| `--brand-alpha-15` | `rgba(46,139,154,0.15)` |
| `--brand-alpha-20` | `rgba(46,139,154,0.2)` |
| `--brand-alpha-25` | `rgba(46,139,154,0.25)` |
| `--accent-alpha-08` | `rgba(232,184,75,0.08)` |
| `--accent-alpha-10` | `rgba(232,184,75,0.10)` |
| `--accent-alpha-15` | `rgba(232,184,75,0.15)` |
| `--accent-alpha-20` | `rgba(232,184,75,0.2)` |
| `--accent-alpha-25` | `rgba(232,184,75,0.25)` |
| `--accent-alpha-30` | `rgba(232,184,75,0.3)` |
| `--danger-alpha-15` | `rgba(208,90,74,0.15)` |
| `--danger-alpha-25` | `rgba(208,90,74,0.25)` |
| `--success-alpha-15` | `rgba(76,175,130,0.15)` |
| `--success-alpha-35` | `rgba(52,211,122,0.35)` |
| `--success-alpha-40` | `rgba(76,175,130,0.4)` |

---

## WCAG AA Requirements

Dilla ships WCAG AA compliant out of the box. When building a custom theme, verify contrast ratios before deploying.

| Pair | Minimum ratio | Applies to |
|------|--------------|-----------|
| `--text-normal` on `--bg-primary` | **4.5:1** | Body text |
| `--text-secondary` on `--bg-secondary` | **4.5:1** | Sidebar labels |
| `--header-primary` on `--bg-primary` | **3:1** | Large headings (≥18px or ≥14px bold) |
| `--interactive-normal` on `--bg-secondary` | **3:1** | Icons and UI controls |
| `--border-color` on `--bg-primary` | **3:1** | Input and panel borders |
| `--status-online` on `--bg-secondary` | **3:1** | Presence dot against sidebar background |

Contrast checker: <https://webaim.org/resources/contrastchecker/>

---

## Important Note about the Dark / Light Toggle

Dilla ships a built-in dark mode and light mode. The toggle in user settings applies a set of token overrides **via inline styles** directly on `<html>`, giving them higher CSS specificity than any stylesheet rule.

This means:

- Your custom theme sets the **base** visual tokens.
- When a user switches to Dark or Light mode, those tokens are **overridden at runtime** by the values defined in `client/src/themes/themes.ts`.
- Your custom background and text colors will therefore be visible only when no toggle preference is stored (i.e., first load with no preference set, or system default).

**If you want a fully custom dark AND light experience** you need to extend the `darkTheme` and `lightTheme` objects in `client/src/themes/themes.ts` with your color values and rebuild the client. That is outside the scope of the `DILLA_THEME_FILE` mechanism and requires a code change.

---

## Example: Midnight Blue Theme

The following snippet applies a cool deep-blue palette while keeping the default accent gold.

```css
/* midnight-blue.css — a cool deep-blue Dilla theme */
:root {
  /* Backgrounds */
  --bg-primary: #0d1b2a;
  --bg-secondary: #0a1420;
  --bg-tertiary: #070f18;
  --bg-floating: #162536;

  /* Text */
  --text-normal: #dde6ee;
  --text-primary: #eaf1f7;
  --text-secondary: #7e9bb4;
  --text-muted: #5a7a94;
  --text-link: #5bc8e8;

  /* Brand */
  --brand-500: #1a6ea8;
  --brand-560: #2485c8;
  --brand-alpha-10: rgba(26, 110, 168, 0.1);
  --brand-alpha-20: rgba(26, 110, 168, 0.2);

  /* Glass (tinted to match new bg-primary) */
  --glass-bg-primary: rgba(13, 27, 42, 0.85);
  --glass-bg-secondary: rgba(10, 20, 32, 0.80);
  --glass-bg-modal: rgba(10, 20, 32, 0.92);

  /* Gradient */
  --gradient-brand: linear-gradient(135deg, #1a6ea8 0%, #0f4d7a 100%);

  /* Scrollbar */
  --scrollbar-thin-thumb: #162536;

  /* Inputs / modals */
  --modal-bg: #0a1420;
  --input-bg: #070f18;
}
```

Set `DILLA_THEME_FILE=/etc/dilla/midnight-blue.css` and restart the server.
