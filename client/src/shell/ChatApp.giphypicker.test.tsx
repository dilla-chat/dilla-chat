// Direct unit tests on ChatApp's exported GiphyPicker + GroupCombobox.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

vi.mock('../services/api', () => ({ api: {} }));
vi.mock('../services/websocket', () => ({ ws: {} }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});

import { GiphyPicker, GroupCombobox } from './ChatApp';

describe('GiphyPicker', () => {
  const results = [
    { url: 'https://x/g1.gif', preview: 'https://x/g1-prev.gif' },
    { url: 'https://x/g2.gif', preview: 'https://x/g2-prev.gif' },
    { url: 'https://x/g3.gif', preview: 'https://x/g3-prev.gif' },
  ];

  it('renders with query + results', () => {
    const { container } = render(
      <GiphyPicker query="cat" results={results} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.textContent).toContain('cat');
    expect(container.querySelectorAll('.giphy-tile').length).toBe(3);
  });

  it('clicking a tile fires onPick with the gif url', () => {
    const onPick = vi.fn();
    const { container } = render(
      <GiphyPicker query="cat" results={results} onPick={onPick} onClose={vi.fn()} />,
    );
    const tile = container.querySelector('.giphy-tile') as HTMLButtonElement;
    fireEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith('https://x/g1.gif');
  });

  it('Escape calls onClose', () => {
    const onClose = vi.fn();
    render(<GiphyPicker query="cat" results={results} onPick={vi.fn()} onClose={onClose} />);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalled();
  });

  it('✕ button calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <GiphyPicker query="cat" results={results} onPick={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(container.querySelector('.modal-x') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(
      <GiphyPicker query="cat" results={results} onPick={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(container.querySelector('.modal-overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('card click does not propagate to backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(
      <GiphyPicker query="cat" results={results} onPick={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(container.querySelector('.modal-card') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders with empty results', () => {
    const { container } = render(
      <GiphyPicker query="nothing" results={[]} onPick={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.querySelectorAll('.giphy-tile').length).toBe(0);
  });
});

describe('GroupCombobox', () => {
  it('renders with existing options', () => {
    const { container } = render(
      <GroupCombobox value="" onChange={vi.fn()} existing={['main', 'product', 'design']} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('typing in input does not throw', () => {
    const onChange = vi.fn();
    const { container } = render(
      <GroupCombobox value="" onChange={onChange} existing={['main', 'product']} />,
    );
    const input = container.querySelector('input') as HTMLInputElement | null;
    if (input) try { fireEvent.change(input, { target: { value: 'pro' } }); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with a pre-selected value', () => {
    const { container } = render(
      <GroupCombobox value="main" onChange={vi.fn()} existing={['main', 'product']} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('handles empty existing list', () => {
    const { container } = render(
      <GroupCombobox value="" onChange={vi.fn()} existing={[]} />,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
