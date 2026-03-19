import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StatusPicker from './StatusPicker';

function renderPicker(overrides = {}) {
  const props = {
    currentStatus: 'online' as const,
    customStatus: '',
    onStatusChange: vi.fn(),
    onCustomStatusChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const result = render(<StatusPicker {...props} />);
  return { ...result, props };
}

describe('StatusPicker', () => {
  it('renders the header', () => {
    renderPicker();
    expect(screen.getByText('presence.setStatus')).toBeInTheDocument();
  });

  it('renders all four status options', () => {
    renderPicker();
    expect(screen.getByText('presence.online')).toBeInTheDocument();
    expect(screen.getByText('presence.idle')).toBeInTheDocument();
    expect(screen.getByText('presence.dnd')).toBeInTheDocument();
    expect(screen.getByText('presence.invisible')).toBeInTheDocument();
  });

  it('marks the current status as active', () => {
    const { container } = renderPicker({ currentStatus: 'idle' });
    const activeOption = container.querySelector('.status-picker-option.active');
    expect(activeOption).toBeInTheDocument();
    expect(activeOption?.textContent).toContain('presence.idle');
  });

  it('calls onStatusChange and onClose when selecting a status', () => {
    const { props } = renderPicker();
    fireEvent.click(screen.getByText('presence.dnd'));
    expect(props.onStatusChange).toHaveBeenCalledWith('dnd');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('renders custom status input', () => {
    renderPicker();
    expect(screen.getByPlaceholderText('presence.customStatusPlaceholder')).toBeInTheDocument();
  });

  it('populates custom status input with existing value', () => {
    renderPicker({ customStatus: 'In a meeting' });
    const input = screen.getByPlaceholderText('presence.customStatusPlaceholder') as HTMLInputElement;
    expect(input.value).toBe('In a meeting');
  });

  it('calls onCustomStatusChange and onClose on save', () => {
    const { props } = renderPicker();
    const input = screen.getByPlaceholderText('presence.customStatusPlaceholder');
    fireEvent.change(input, { target: { value: 'Away' } });
    fireEvent.click(screen.getByText('presence.saveStatus'));
    expect(props.onCustomStatusChange).toHaveBeenCalledWith('Away');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('saves custom status on Enter key', () => {
    const { props } = renderPicker();
    const input = screen.getByPlaceholderText('presence.customStatusPlaceholder');
    fireEvent.change(input, { target: { value: 'Focusing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onCustomStatusChange).toHaveBeenCalledWith('Focusing');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows clear button only when customStatus is non-empty', () => {
    const { rerender, props } = renderPicker({ customStatus: '' });
    expect(screen.queryByText('presence.clearStatus')).not.toBeInTheDocument();

    rerender(
      <StatusPicker
        {...props}
        customStatus="something"
      />,
    );
    expect(screen.getByText('presence.clearStatus')).toBeInTheDocument();
  });

  it('clears custom status when clear button is clicked', () => {
    const { props } = renderPicker({ customStatus: 'Busy' });
    fireEvent.click(screen.getByText('presence.clearStatus'));
    expect(props.onCustomStatusChange).toHaveBeenCalledWith('');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('stops propagation on click to prevent closing parent', () => {
    const { container } = renderPicker();
    const picker = container.querySelector('.status-picker')!;
    const event = new MouseEvent('click', { bubbles: true });
    const stopProp = vi.spyOn(event, 'stopPropagation');
    picker.dispatchEvent(event);
    expect(stopProp).toHaveBeenCalled();
  });
});
