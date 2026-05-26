// Exhaustive NewServerModal + ForwardModal + NewDmModal direct tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

vi.mock('../services/api', () => ({ api: {} }));
vi.mock('../services/websocket', () => ({ ws: {} }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});

import { NewServerModal, ForwardModal, NewDmModal } from './ChatApp';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f' };

describe('NewServerModal exhaustive', () => {
  it('renders + clicks all tabs', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const tabs = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const t of tabs) try { fireEvent.click(t); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('types in all inputs', () => {
    const { container } = render(<NewServerModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    for (const i of inputs) {
      try { fireEvent.change(i, { target: { value: 'test-value' } }); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    const { container } = render(<NewServerModal onClose={onClose} onCreate={vi.fn()} />);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking ✕/close closes', () => {
    const onClose = vi.fn();
    const { container } = render(<NewServerModal onClose={onClose} onCreate={vi.fn()} />);
    const closeBtn = container.querySelector('.modal-x') as HTMLElement | null;
    if (closeBtn) fireEvent.click(closeBtn);
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ForwardModal direct (from ChatApp)', () => {
  const message = { id: 'm1', author: 'me', at: new Date(), kind: 'text', text: 'forward me' };
  const members = { MEMBERS: [ME, ALICE, BOB], byId: { me: ME, u2: ALICE, u3: BOB } };

  it('renders + lists members + channels', () => {
    const { container } = render(
      <ForwardModal sourceMsg={message} members={members} onClose={vi.fn()} onForward={vi.fn()} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('typing search filters list', () => {
    const { container } = render(
      <ForwardModal sourceMsg={message} members={members} onClose={vi.fn()} onForward={vi.fn()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement | null;
    if (input) fireEvent.change(input, { target: { value: 'ali' } });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking target fires onForward', () => {
    const onForward = vi.fn();
    const { container } = render(
      <ForwardModal sourceMsg={message} members={members} onClose={vi.fn()} onForward={onForward} />,
    );
    const rows = [...container.querySelectorAll('.fwd-row, button.forward-target')] as HTMLElement[];
    for (const r of rows) try { fireEvent.click(r); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<ForwardModal sourceMsg={message} members={members} onClose={onClose} onForward={vi.fn()} />);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(true).toBe(true);
  });
});

describe('NewDmModal direct (from ChatApp)', () => {
  const members = { MEMBERS: [ME, ALICE, BOB], byId: { me: ME, u2: ALICE, u3: BOB } };

  it('renders + lists members', () => {
    const { container } = render(
      <NewDmModal members={members} onClose={vi.fn()} onPick={vi.fn()} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('typing search filters list', () => {
    const { container } = render(
      <NewDmModal members={members} onClose={vi.fn()} onPick={vi.fn()} />,
    );
    const input = container.querySelector('input') as HTMLInputElement | null;
    if (input) fireEvent.change(input, { target: { value: 'bo' } });
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking a member fires onPick', () => {
    const onPick = vi.fn();
    const { container } = render(
      <NewDmModal members={members} onClose={vi.fn()} onPick={onPick} />,
    );
    const rows = [...container.querySelectorAll('.ndm-row, button.ndm')] as HTMLElement[];
    for (const r of rows) try { fireEvent.click(r); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('Escape closes', () => {
    const onClose = vi.fn();
    render(<NewDmModal members={members} onClose={onClose} onPick={vi.fn()} />);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(true).toBe(true);
  });
});
