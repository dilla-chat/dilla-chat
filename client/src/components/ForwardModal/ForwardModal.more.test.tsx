// Cover ForwardModal Arrow nav + Escape + empty-state + DM target kind.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import ForwardModal, { type ForwardTarget } from './ForwardModal';

const TARGETS: ForwardTarget[] = [
  { id: 'ch-1', label: '#general', kind: 'channel' },
  { id: 'ch-2', label: '#dev', kind: 'channel' },
  { id: 'dm-1', label: '@alice', kind: 'dm' },
  { id: 'dm-2', label: 'group: ada, ben', kind: 'dm' },
];

const SOURCE = { author: 'me', timestamp: '12:00', body: 'forward me' };

describe('ForwardModal arrow keys / Escape / empty', () => {
  it('ArrowDown advances selection', () => {
    const onForward = vi.fn();
    const onClose = vi.fn();
    render(<ForwardModal open onClose={onClose} source={SOURCE} targets={TARGETS} onForward={onForward} />);
    act(() => { fireEvent.keyDown(document, { key: 'ArrowDown' }); });
    act(() => { fireEvent.keyDown(document, { key: 'Enter' }); });
    expect(onForward).toHaveBeenCalledWith(TARGETS[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('ArrowUp from top stays at 0', () => {
    const onForward = vi.fn();
    const onClose = vi.fn();
    render(<ForwardModal open onClose={onClose} source={SOURCE} targets={TARGETS} onForward={onForward} />);
    act(() => {
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      fireEvent.keyDown(document, { key: 'ArrowUp' });
      fireEvent.keyDown(document, { key: 'Enter' });
    });
    expect(onForward).toHaveBeenCalledWith(TARGETS[0]);
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<ForwardModal open onClose={onClose} source={SOURCE} targets={TARGETS} onForward={vi.fn()} />);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter on empty filtered list does nothing', () => {
    const onForward = vi.fn();
    render(<ForwardModal open onClose={vi.fn()} source={SOURCE} targets={[]} onForward={onForward} />);
    act(() => { fireEvent.keyDown(document, { key: 'Enter' }); });
    expect(onForward).not.toHaveBeenCalled();
  });

  it('renders different kinds (channel vs dm)', () => {
    render(<ForwardModal open onClose={vi.fn()} source={SOURCE} targets={TARGETS} onForward={vi.fn()} />);
    expect(document.body.textContent).toContain('#general');
    expect(document.body.textContent).toContain('@alice');
  });

  it('source author + timestamp + body are visible', () => {
    render(<ForwardModal open onClose={vi.fn()} source={{ ...SOURCE, authorColor: '#f00' }} targets={TARGETS} onForward={vi.fn()} />);
    expect(document.body.textContent).toContain('me');
    expect(document.body.textContent).toContain('12:00');
    expect(document.body.textContent).toContain('forward me');
  });
});
