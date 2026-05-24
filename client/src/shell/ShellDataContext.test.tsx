import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { ShellDataProvider, useShellDataContext } from './ShellDataContext';

describe('ShellDataContext', () => {
  it('useShellDataContext returns null outside a provider', () => {
    const { result } = renderHook(() => useShellDataContext());
    expect(result.current).toBeNull();
  });

  it('useShellDataContext returns the provider value', () => {
    const data = { SERVERS: [{ id: 't1' }], CHANNELS: [] };
    const { result } = renderHook(() => useShellDataContext(), {
      wrapper: ({ children }) => <ShellDataProvider value={data}>{children}</ShellDataProvider>,
    });
    expect(result.current).toBe(data);
  });

  it('ShellDataProvider renders its children', () => {
    const { getByText } = render(
      <ShellDataProvider value={null}>
        <span>child</span>
      </ShellDataProvider>,
    );
    expect(getByText('child')).toBeTruthy();
  });

  it('ShellDataProvider accepts explicit null value', () => {
    const { result } = renderHook(() => useShellDataContext(), {
      wrapper: ({ children }) => <ShellDataProvider value={null}>{children}</ShellDataProvider>,
    });
    expect(result.current).toBeNull();
  });

  it('different providers in different subtrees yield different values', () => {
    const a = { tag: 'a' };
    const b = { tag: 'b' };
    const { result: ra } = renderHook(() => useShellDataContext(), {
      wrapper: ({ children }) => <ShellDataProvider value={a}>{children}</ShellDataProvider>,
    });
    const { result: rb } = renderHook(() => useShellDataContext(), {
      wrapper: ({ children }) => <ShellDataProvider value={b}>{children}</ShellDataProvider>,
    });
    expect(ra.current).toBe(a);
    expect(rb.current).toBe(b);
  });
});
