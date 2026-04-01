import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFocusTrap } from './useFocusTrap';

function makeContainer() {
  const container = document.createElement('div');
  container.setAttribute('tabindex', '-1');
  document.body.appendChild(container);
  return container;
}

describe('useFocusTrap', () => {
  it('does nothing when not active', () => {
    const ref = { current: makeContainer() };
    const { unmount } = renderHook(() => useFocusTrap(ref, false));
    unmount();
    document.body.removeChild(ref.current);
  });

  it('activates without errors when active', () => {
    const container = makeContainer();
    // focus-trap activates; jsdom has limited focus support but no errors thrown
    const { unmount } = renderHook(() => useFocusTrap({ current: container }, true));
    unmount();
    document.body.removeChild(container);
  });

  it('calls onEscape on deactivate', () => {
    const container = makeContainer();
    const onEscape = vi.fn();
    renderHook(() => useFocusTrap({ current: container }, true, onEscape));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledOnce();
    document.body.removeChild(container);
  });

  it('deactivates cleanly on unmount', () => {
    const container = makeContainer();
    const { unmount } = renderHook(() => useFocusTrap({ current: container }, true));
    unmount();
    document.body.removeChild(container);
  });

  it('does nothing with null ref', () => {
    const ref = { current: null };
    const { unmount } = renderHook(() => useFocusTrap(ref, true));
    unmount();
  });
});
