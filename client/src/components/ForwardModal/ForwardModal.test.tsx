import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ForwardModal, { type ForwardTarget } from './ForwardModal';

function makeTargets(): ForwardTarget[] {
  return [
    { id: 'c1', label: 'design', kind: 'channel' },
    { id: 'c2', label: 'dev', kind: 'channel' },
    { id: 'c3', label: 'mesh-status', kind: 'channel' },
    { id: 'd1', label: 'ada', kind: 'dm' },
    { id: 'd2', label: 'bob', kind: 'dm' },
  ];
}

const source = {
  author: 'thim',
  timestamp: '14:32',
  body: 'mesh redesign is shipping',
};

describe('ForwardModal', () => {
  it('renders nothing when closed', () => {
    render(
      <ForwardModal
        open={false}
        onClose={() => {}}
        source={source}
        targets={makeTargets()}
        onForward={() => {}}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders source preview + targets', () => {
    render(
      <ForwardModal
        open
        onClose={() => {}}
        source={source}
        targets={makeTargets()}
        onForward={() => {}}
      />,
    );
    expect(screen.getByText(/mesh redesign is shipping/i)).toBeInTheDocument();
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.getByText('ada')).toBeInTheDocument();
  });

  it('filters targets by query', () => {
    render(
      <ForwardModal
        open
        onClose={() => {}}
        source={source}
        targets={makeTargets()}
        onForward={() => {}}
      />,
    );
    const search = screen.getByLabelText(/filter targets/i);
    fireEvent.change(search, { target: { value: 'mesh' } });
    expect(screen.getByText('mesh-status')).toBeInTheDocument();
    expect(screen.queryByText('design')).not.toBeInTheDocument();
  });

  it('Enter selects current target and closes', () => {
    const onForward = vi.fn();
    const onClose = vi.fn();
    render(
      <ForwardModal
        open
        onClose={onClose}
        source={source}
        targets={makeTargets()}
        onForward={onForward}
      />,
    );
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onForward).toHaveBeenCalledOnce();
    expect(onForward.mock.calls[0][0].id).toBe('c2');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking a row forwards', () => {
    const onForward = vi.fn();
    render(
      <ForwardModal
        open
        onClose={() => {}}
        source={source}
        targets={makeTargets()}
        onForward={onForward}
      />,
    );
    fireEvent.click(screen.getByText('ada'));
    expect(onForward).toHaveBeenCalledOnce();
    expect(onForward.mock.calls[0][0].kind).toBe('dm');
  });
});
