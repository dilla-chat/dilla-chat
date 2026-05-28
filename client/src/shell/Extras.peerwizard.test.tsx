// AddPeerWizard isn't directly exported but it appears via window event
// from elsewhere. Use a minimal harness that renders it via the same
// import path the rest of Extras uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { AddPeerWizard } from './Extras';
import { ShellDataProvider } from './ShellDataContext';

vi.mock('../utils/randomId', () => ({ shortId: (p: string) => `${p}-x` }));

function wrap(children: React.ReactElement, data: Record<string, unknown> = { SERVERS: [{ name: 'Acme', node: 'gbg-1' }] }) {
  return <ShellDataProvider value={data}>{children}</ShellDataProvider>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AddPeerWizard', () => {
  it('returns null when not open', () => {
    const { container } = render(wrap(<AddPeerWizard open={false} onClose={vi.fn()} />));
    expect(container.firstChild).toBeNull();
  });

  it('renders step 0 with "I have a token" by default', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    expect(container.textContent).toContain('Add a peer node');
    expect(container.textContent).toContain('I have a token');
  });

  it('switches to "Generate one for a peer" mode', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    const segs = [...container.querySelectorAll('.apw-seg button')] as HTMLButtonElement[];
    fireEvent.click(segs[1]);
    expect(container.textContent).toContain('Run this on the new node');
  });

  it('Parse button is disabled when token too short', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    const parseBtn = [...container.querySelectorAll('button')].find((b) => /parse/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(parseBtn.disabled).toBe(true);
  });

  it('typing a long token enables Parse, click advances to step 1', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'eyJraWQiOiJoczI1Ni-test-token' } });
    const parseBtn = [...container.querySelectorAll('button')].find((b) => /parse/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(parseBtn.disabled).toBe(false);
    fireEvent.click(parseBtn);
    expect(container.textContent).toContain('node name');
  });

  it('Back from step 1 returns to step 0', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'eyJraWQiOiJoczI1Ni-test-token' } });
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /parse/i.test(b.textContent ?? '')) as HTMLButtonElement);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /back/i.test(b.textContent ?? '')) as HTMLButtonElement);
    expect(container.textContent).toContain('I have a token');
  });

  it('Connect peer advances to handshake step (logs accumulate via timers)', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'eyJraWQiOiJoczI1Ni-test-token' } });
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /parse/i.test(b.textContent ?? '')) as HTMLButtonElement);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /connect peer/i.test(b.textContent ?? '')) as HTMLButtonElement);
    expect(container.textContent).toContain('Handshaking');
    act(() => { vi.advanceTimersByTime(400); });
    expect(container.textContent).toContain('parsing');
  });

  it('full handshake sequence advances to step 3 (Done)', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />));
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'eyJraWQiOiJoczI1Ni-test-token' } });
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /parse/i.test(b.textContent ?? '')) as HTMLButtonElement);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /connect peer/i.test(b.textContent ?? '')) as HTMLButtonElement);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(container.textContent).toMatch(/joined the mesh|Done/i);
  });

  it('clicking ✕ in header calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<AddPeerWizard open onClose={onClose} />));
    fireEvent.click(container.querySelector('.sc-x') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the backdrop calls onClose; clicking inside does not', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<AddPeerWizard open onClose={onClose} />));
    fireEvent.click(container.querySelector('.apw') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay-dismiss') as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel button in generate mode calls onClose', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(<AddPeerWizard open onClose={onClose} />));
    fireEvent.click([...container.querySelectorAll('.apw-seg button')][1] as HTMLButtonElement);
    fireEvent.click([...container.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? '')) as HTMLButtonElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('falls back to localhost when nodeName is "local"', () => {
    const { container } = render(wrap(<AddPeerWizard open onClose={vi.fn()} />, { SERVERS: [{ name: 'Acme', node: 'local' }] }));
    fireEvent.click([...container.querySelectorAll('.apw-seg button')][1] as HTMLButtonElement);
    expect(container.textContent).toContain('localhost');
  });
});
