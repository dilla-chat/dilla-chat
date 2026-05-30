import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import ServerAddressInput, { type ServerStatus } from './ServerAddressInput';

function renderInput(status: ServerStatus, value = 'srv.example') {
  const onChange = vi.fn();
  const ui = render(
    <ServerAddressInput
      placeholder="server address"
      value={value}
      onChange={onChange}
      serverStatus={status}
    />,
  );
  return { ...ui, onChange };
}

describe('ServerAddressInput', () => {
  it('renders an input with the given placeholder + value', () => {
    const { container } = renderInput('unknown', 'srv.io');
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.placeholder).toBe('server address');
    expect(input.value).toBe('srv.io');
  });

  it('fires onChange on input', () => {
    const { container, onChange } = renderInput('unknown', '');
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new.host' } });
    expect(onChange).toHaveBeenCalledWith('new.host');
  });

  it('renders the green online icon when serverStatus="online"', () => {
    const { container } = renderInput('online');
    // tabler-react renders SVGs; the right-side adornment is the only
    // SVG in the tree.
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the red offline icon when serverStatus="offline"', () => {
    const { container } = renderInput('offline');
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the spinning checking icon when serverStatus="checking"', () => {
    const { container } = renderInput('checking');
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders no icon when serverStatus="unknown"', () => {
    const { container } = renderInput('unknown');
    expect(container.querySelectorAll('svg').length).toBe(0);
  });
});
