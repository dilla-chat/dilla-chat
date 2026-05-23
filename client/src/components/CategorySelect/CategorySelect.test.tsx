import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import CategorySelect from './CategorySelect';
import { useTeamStore } from '../../stores/teamStore';

// react-i18next noop translator — the t fallback strings cover the
// rendered text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));

function seedTeam(channels: Array<{ id: string; category: string }>) {
  useTeamStore.setState({
    activeTeamId: 't1',
    channels: new Map([['t1', channels as never]]),
  });
}

describe('CategorySelect', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: null, channels: new Map() });
  });

  it('renders a select with the "No category" default + the +Create new sentinel', () => {
    const { container } = render(
      <CategorySelect
        id="cat"
        category=""
        newCategory=""
        onCategoryChange={vi.fn()}
        onNewCategoryChange={vi.fn()}
      />,
    );
    const opts = container.querySelectorAll('option');
    expect([...opts].map((o) => o.textContent)).toEqual([
      'No category',
      '+ Create new',
    ]);
  });

  it('populates options from the channel list, deduped', () => {
    seedTeam([
      { id: 'ch-1', category: 'Engineering' },
      { id: 'ch-2', category: 'Engineering' }, // dup → collapses
      { id: 'ch-3', category: 'Design' },
      { id: 'ch-4', category: '' }, // empty → filtered
    ]);
    const { container } = render(
      <CategorySelect
        id="cat"
        category=""
        newCategory=""
        onCategoryChange={vi.fn()}
        onNewCategoryChange={vi.fn()}
      />,
    );
    const texts = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(texts).toContain('Engineering');
    expect(texts).toContain('Design');
    expect(texts.filter((t) => t === 'Engineering').length).toBe(1);
  });

  it('filters out the UI bucket labels ("Voice Channels"/"Text Channels")', () => {
    seedTeam([
      { id: 'ch-1', category: 'Voice Channels' },
      { id: 'ch-2', category: 'Text Channels' },
      { id: 'ch-3', category: 'Real' },
    ]);
    const { container } = render(
      <CategorySelect
        id="cat"
        category=""
        newCategory=""
        onCategoryChange={vi.fn()}
        onNewCategoryChange={vi.fn()}
      />,
    );
    const texts = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(texts).not.toContain('Voice Channels');
    expect(texts).not.toContain('Text Channels');
    expect(texts).toContain('Real');
  });

  it('fires onCategoryChange when an existing category is selected', () => {
    seedTeam([{ id: 'ch-1', category: 'Engineering' }]);
    const onChange = vi.fn();
    const { container } = render(
      <CategorySelect
        id="cat"
        category=""
        newCategory=""
        onCategoryChange={onChange}
        onNewCategoryChange={vi.fn()}
      />,
    );
    fireEvent.change(container.querySelector('select')!, { target: { value: 'Engineering' } });
    expect(onChange).toHaveBeenCalledWith('Engineering');
  });

  it('shows the new-category text input when category="__new__"', () => {
    const { container } = render(
      <CategorySelect
        id="cat"
        category="__new__"
        newCategory="emerging"
        onCategoryChange={vi.fn()}
        onNewCategoryChange={vi.fn()}
      />,
    );
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('emerging');
  });

  it('fires onNewCategoryChange when the new-category input changes', () => {
    const onNew = vi.fn();
    const { container } = render(
      <CategorySelect
        id="cat"
        category="__new__"
        newCategory=""
        onCategoryChange={vi.fn()}
        onNewCategoryChange={onNew}
      />,
    );
    fireEvent.change(container.querySelector('input[type="text"]')!, {
      target: { value: 'new-bucket' },
    });
    expect(onNew).toHaveBeenCalledWith('new-bucket');
  });
});
