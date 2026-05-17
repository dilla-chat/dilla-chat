import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SearchPalette, { type SearchHit } from './SearchPalette';

function makeHits(): SearchHit[] {
  return [
    {
      id: 'm1',
      channelId: 'c1',
      channelName: 'design',
      author: 'ada',
      timestamp: '14:02',
      body: 'fresh take on the mesh look',
    },
    {
      id: 'm2',
      channelId: 'c1',
      channelName: 'design',
      author: 'ben',
      timestamp: '14:08',
      body: 'love the brutalist edges',
    },
    {
      id: 'm3',
      channelId: 'c2',
      channelName: 'dev',
      author: 'thim',
      timestamp: '15:11',
      body: 'shipping the mesh redesign',
    },
  ];
}

describe('SearchPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <SearchPalette
        open={false}
        onClose={() => {}}
        scopedChannelName="design"
        search={() => makeHits()}
        onSelectHit={() => {}}
      />,
    );
    expect(container.querySelector('.search-palette')).not.toBeInTheDocument();
  });

  it('shows filter tips when query is empty', () => {
    render(
      <SearchPalette
        open
        onClose={() => {}}
        scopedChannelName="design"
        search={() => makeHits()}
        onSelectHit={() => {}}
      />,
    );
    expect(screen.getByText(/filters/i)).toBeInTheDocument();
    expect(screen.getByText('from:')).toBeInTheDocument();
  });

  it('typing a query renders matching hits scoped to channel by default', () => {
    const search = vi.fn((_q: string, scope: 'channel' | 'all') => {
      return scope === 'channel'
        ? makeHits().filter((h) => h.channelName === 'design')
        : makeHits();
    });
    render(
      <SearchPalette
        open
        onClose={() => {}}
        scopedChannelName="design"
        search={search}
        onSelectHit={() => {}}
      />,
    );
    const input = screen.getByLabelText(/search query/i);
    fireEvent.change(input, { target: { value: 'mesh' } });
    expect(search).toHaveBeenCalledWith('mesh', 'channel');
    expect(screen.getByText(/fresh take on the/i)).toBeInTheDocument();
    expect(screen.queryByText(/shipping the/i)).not.toBeInTheDocument();
  });

  it('clicking scope pill toggles to all kanals', () => {
    const search = vi.fn((_q: string, scope: 'channel' | 'all') => {
      return scope === 'all' ? makeHits() : [];
    });
    render(
      <SearchPalette
        open
        onClose={() => {}}
        scopedChannelName="design"
        search={search}
        onSelectHit={() => {}}
      />,
    );
    const input = screen.getByLabelText(/search query/i);
    fireEvent.change(input, { target: { value: 'mesh' } });
    fireEvent.click(screen.getByText(/✓ #design/i));
    expect(search).toHaveBeenCalledWith('mesh', 'all');
    expect(screen.getByText(/shipping the/i)).toBeInTheDocument();
  });

  it('Enter selects current hit and closes', () => {
    const onSelectHit = vi.fn();
    const onClose = vi.fn();
    render(
      <SearchPalette
        open
        onClose={onClose}
        scopedChannelName="design"
        search={(_q, _scope) => makeHits()}
        onSelectHit={onSelectHit}
      />,
    );
    const input = screen.getByLabelText(/search query/i);
    fireEvent.change(input, { target: { value: 'mesh' } });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onSelectHit).toHaveBeenCalledOnce();
    expect(onSelectHit.mock.calls[0][0].id).toBe('m1');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(
      <SearchPalette
        open
        onClose={onClose}
        scopedChannelName="design"
        search={() => []}
        onSelectHit={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
