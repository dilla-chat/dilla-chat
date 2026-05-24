import { describe, it, expect } from 'vitest';
import { THEMES } from './themes';

describe('THEMES export', () => {
  it('exposes pulse / aurora / slate / mesh + ALL + DENSITY + themeVars', () => {
    expect(THEMES.pulse).toBeDefined();
    expect(THEMES.aurora).toBeDefined();
    expect(THEMES.slate).toBeDefined();
    expect(THEMES.mesh).toBeDefined();
    expect(Array.isArray(THEMES.ALL)).toBe(true);
    expect(THEMES.ALL).toHaveLength(4);
    expect(THEMES.DENSITY).toBeDefined();
    expect(typeof THEMES.themeVars).toBe('function');
  });

  it('every theme has name + style + at least the core CSS vars', () => {
    for (const t of THEMES.ALL) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.style).toBe('string');
      expect(t['--bg']).toBeDefined();
      expect(t['--fg']).toBeDefined();
      expect(t['--accent']).toBeDefined();
    }
  });

  it('each theme.style is unique', () => {
    const styles = THEMES.ALL.map((t) => t.style);
    expect(new Set(styles).size).toBe(styles.length);
  });
});

describe('THEMES.DENSITY', () => {
  it('has compact / regular / cozy presets', () => {
    expect(THEMES.DENSITY.compact).toBeDefined();
    expect(THEMES.DENSITY.regular).toBeDefined();
    expect(THEMES.DENSITY.cozy).toBeDefined();
  });

  it('avatar grows monotonically across density tiers', () => {
    expect(THEMES.DENSITY.compact.avatar).toBeLessThan(THEMES.DENSITY.regular.avatar);
    expect(THEMES.DENSITY.regular.avatar).toBeLessThan(THEMES.DENSITY.cozy.avatar);
  });

  it('lineHeight grows monotonically across density tiers', () => {
    expect(THEMES.DENSITY.compact.lineHeight).toBeLessThan(THEMES.DENSITY.regular.lineHeight);
    expect(THEMES.DENSITY.regular.lineHeight).toBeLessThan(THEMES.DENSITY.cozy.lineHeight);
  });
});

describe('THEMES.themeVars', () => {
  it('extracts only the --* CSS variables (not name/blurb/style)', () => {
    const out = THEMES.themeVars(THEMES.pulse);
    expect(out['--bg']).toBeDefined();
    expect(out['--accent']).toBeDefined();
    expect(out.name).toBeUndefined();
    expect(out.style).toBeUndefined();
  });

  it('opts.accent overrides --accent', () => {
    const out = THEMES.themeVars(THEMES.pulse, { accent: '#abcdef' });
    expect(out['--accent']).toBe('#abcdef');
  });

  it('opts.sidebar emits --sidebar-w with px suffix', () => {
    const out = THEMES.themeVars(THEMES.pulse, { sidebar: 280 });
    expect(out['--sidebar-w']).toBe('280px');
  });

  it('opts.density applies the density preset variables', () => {
    const out = THEMES.themeVars(THEMES.pulse, { density: 'compact' });
    expect(out['--row-pad']).toBe('4px 16px');
    expect(out['--avatar-sz']).toBe('28px');
  });

  it('opts.density falls back to "regular" for unknown values', () => {
    const out = THEMES.themeVars(THEMES.pulse, { density: 'bogus' });
    expect(out['--row-pad']).toBe('6px 18px');
  });

  it('combining sidebar + density + accent works together', () => {
    const out = THEMES.themeVars(THEMES.pulse, {
      density: 'cozy', sidebar: 240, accent: '#ff0',
    });
    expect(out['--row-pad']).toBe('10px 20px');
    expect(out['--sidebar-w']).toBe('240px');
    expect(out['--accent']).toBe('#ff0');
  });

  it('no opts → only --* vars from the theme', () => {
    const out = THEMES.themeVars(THEMES.mesh);
    expect(out['--bg']).toBe(THEMES.mesh['--bg']);
    expect(out['--row-pad']).toBeUndefined();
  });
});
