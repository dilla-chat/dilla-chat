import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  CodeIcon,
  CodeBlockIcon,
  OrderedListIcon,
  UnorderedListIcon,
  BlockquoteIcon,
  PlusCircleIcon,
} from './Icons';

describe('MessageInput icons', () => {
  const cases: Array<[string, () => JSX.Element]> = [
    ['BoldIcon', BoldIcon],
    ['ItalicIcon', ItalicIcon],
    ['StrikethroughIcon', StrikethroughIcon],
    ['CodeIcon', CodeIcon],
    ['CodeBlockIcon', CodeBlockIcon],
    ['OrderedListIcon', OrderedListIcon],
    ['UnorderedListIcon', UnorderedListIcon],
    ['BlockquoteIcon', BlockquoteIcon],
    ['PlusCircleIcon', PlusCircleIcon],
  ];

  for (const [name, Icon] of cases) {
    it(`${name} renders an <svg>`, () => {
      const { container } = render(<Icon />);
      expect(container.querySelector('svg')).not.toBeNull();
    });
  }

  it('icons share a consistent 18×18 box (except PlusCircleIcon at 20×20)', () => {
    const eighteen = [BoldIcon, ItalicIcon, StrikethroughIcon, CodeIcon, CodeBlockIcon, OrderedListIcon, UnorderedListIcon, BlockquoteIcon];
    for (const Icon of eighteen) {
      const { container } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('width')).toBe('18');
      expect(svg?.getAttribute('height')).toBe('18');
    }
    const { container: pc } = render(<PlusCircleIcon />);
    expect(pc.querySelector('svg')?.getAttribute('width')).toBe('20');
  });
});
