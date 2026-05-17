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

describe('layout-width tokens', () => {
  it('base-tokens.css defines mesh rail + bar tokens', async () => {
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
    expect(css).toMatch(/--team-sidebar-width:\s*var\(--rail-w\)/);
  });
});
