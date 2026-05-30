import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from './icons';

const NAMES = [
  'Attach', 'Bars', 'Chat', 'Cog', 'Download', 'Emoji', 'File', 'Hash',
  'Headphones', 'Help', 'Lightning', 'Lock', 'Mic', 'People', 'Pin', 'Plus',
  'Reply', 'Screen', 'Search', 'Send', 'Shield', 'Speaker', 'Thread', 'Video',
] as const;

describe('shell/icons', () => {
  it('exports all 24 named icons', () => {
    for (const name of NAMES) {
      expect((Icon as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it.each(NAMES.map((n) => [n] as const))('Icon.%s renders an svg element', (name) => {
    const IconComp = (Icon as Record<string, () => JSX.Element>)[name];
    const { container } = render(<IconComp />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('Icon.Mic accepts an `off` prop and renders the slash overlay', () => {
    const { container: on } = render(<Icon.Mic />);
    const { container: off } = render(<Icon.Mic off />);
    // The "off" variant adds <line> elements for the strike-through.
    expect(off.querySelectorAll('line').length).toBeGreaterThan(on.querySelectorAll('line').length);
  });

  it('Icon.Headphones accepts an `off` prop', () => {
    const { container } = render(<Icon.Headphones off />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('Icon.Video accepts an `off` prop', () => {
    const { container } = render(<Icon.Video off />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('Icon.Screen accepts an `off` prop', () => {
    const { container } = render(<Icon.Screen off />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('passes a custom size prop to the svg width/height', () => {
    const { container } = render(<Icon.Hash size={32} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('height')).toBe('32');
  });

  it('default size is sane (14 / 12 / 13 — small enough for sidebar use)', () => {
    const { container } = render(<Icon.Hash />);
    const w = Number.parseInt(container.querySelector('svg')?.getAttribute('width') ?? '0', 10);
    expect(w).toBeGreaterThan(8);
    expect(w).toBeLessThanOrEqual(16);
  });
});
