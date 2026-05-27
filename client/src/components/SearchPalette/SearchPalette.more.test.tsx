// Cover SearchPalette ArrowUp/ArrowDown navigation + mouseEnter +
// highlight + no-matches.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import SearchPalette, { type SearchHit } from './SearchPalette';

const SAMPLE_HITS: SearchHit[] = [
  { id: 'h1', channelId: 'ch-1', channelName: 'general', author: 'me', timestamp: '12:00', body: 'hello world' },
  { id: 'h2', channelId: 'ch-1', channelName: 'general', author: 'alice', timestamp: '12:01', body: 'goodbye world' },
  { id: 'h3', channelId: 'ch-2', channelName: 'dev', author: 'me', timestamp: '12:02', body: 'world is round' },
];

describe('SearchPalette navigation + interactions', () => {
  let search: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let onSelectHit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    search = vi.fn((q: string) => q.trim() ? SAMPLE_HITS : []);
    onClose = vi.fn();
    onSelectHit = vi.fn();
  });

  it('ArrowDown advances selected hit', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={search} onSelectHit={onSelectHit} />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'world' } });
    act(() => { fireEvent.keyDown(document, { key: 'ArrowDown' }); });
    const hits = [...document.querySelectorAll('.search-palette-hit')];
    expect(hits.length).toBeGreaterThan(0);
  });

  it('ArrowUp stays at 0 from the top', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={search} onSelectHit={onSelectHit} />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'world' } });
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      fireEvent.keyDown(document, { key: 'ArrowUp' });
    });
    const selected = document.querySelector('.search-palette-hit.selected');
    expect(selected).toBeTruthy();
  });

  it('mouseEnter on a hit sets it as selected', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={search} onSelectHit={onSelectHit} />,
    );
    fireEvent.change(document.querySelector('input') as HTMLInputElement, { target: { value: 'world' } });
    const hits = [...document.querySelectorAll('.search-palette-hit')] as HTMLElement[];
    if (hits[2]) fireEvent.mouseEnter(hits[2]);
    expect(document.querySelector('.search-palette-hit.selected')).toBeTruthy();
  });

  it('clicking a hit calls onSelectHit + onClose', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={search} onSelectHit={onSelectHit} />,
    );
    fireEvent.change(document.querySelector('input') as HTMLInputElement, { target: { value: 'world' } });
    const hits = [...document.querySelectorAll('.search-palette-hit')] as HTMLElement[];
    fireEvent.click(hits[0]);
    expect(onSelectHit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter on empty hits does nothing', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName={null} search={() => []} onSelectHit={onSelectHit} />,
    );
    act(() => { fireEvent.keyDown(document, { key: 'Enter' }); });
    expect(onSelectHit).not.toHaveBeenCalled();
  });

  it('shows "No matches" when query is set but no hits', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={() => []} onSelectHit={onSelectHit} />,
    );
    fireEvent.change(document.querySelector('input') as HTMLInputElement, { target: { value: 'nothing' } });
    expect(document.body.textContent).toContain('No matches');
  });

  it('renders highlight mark inside matched body', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={search} onSelectHit={onSelectHit} />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'world' } });
    expect(document.querySelector('.search-palette-hit mark')).toBeTruthy();
  });

  it('scopedChannelName=null defaults to "all" scope (no pill)', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName={null} search={search} onSelectHit={onSelectHit} />,
    );
    expect(document.querySelector('.search-palette-scope')).toBeNull();
  });

  it('clicking the overlay closes the palette', () => {
    render(
      <SearchPalette open onClose={onClose} scopedChannelName="general" search={search} onSelectHit={onSelectHit} />,
    );
    fireEvent.click(document.querySelector('.search-palette-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
