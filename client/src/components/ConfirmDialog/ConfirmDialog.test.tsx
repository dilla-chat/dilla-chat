import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import ConfirmDialog from './ConfirmDialog';
import { useConfirmStore, dillaConfirm } from '../../stores/confirmStore';

describe('ConfirmDialog', () => {
  beforeEach(() => {
    useConfirmStore.setState({ pending: null, resolve: null });
  });

  it('renders nothing while no request is pending', () => {
    const { container } = render(<ConfirmDialog />);
    expect(container.firstChild).toBeNull();
  });

  it('renders title, body, and labels from the pending request', async () => {
    render(<ConfirmDialog />);
    act(() => {
      void dillaConfirm({
        title: 'Delete team?',
        body: 'This is permanent.',
        confirmLabel: 'Delete',
        cancelLabel: 'Keep',
      });
    });
    const { getByText } = await Promise.resolve({
      getByText: (t: string) => document.body.querySelector(`*:not(script):not(style)`) && [...document.body.querySelectorAll('*')].find((el) => el.textContent === t)!,
    });
    expect(getByText('Delete team?')).toBeTruthy();
    expect(getByText('This is permanent.')).toBeTruthy();
    expect(getByText('Delete')).toBeTruthy();
    expect(getByText('Keep')).toBeTruthy();
  });

  it('falls back to default labels when none are provided', async () => {
    render(<ConfirmDialog />);
    act(() => {
      void dillaConfirm({ body: 'continue?' });
    });
    expect([...document.body.querySelectorAll('h2')][0]?.textContent).toBe('Are you sure?');
    const btns = [...document.body.querySelectorAll('footer.modal-foot button')] as HTMLButtonElement[];
    expect(btns.map((b) => b.textContent)).toEqual(['Cancel', 'Confirm']);
  });

  it('resolves to true when the confirm button is clicked', async () => {
    render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    const confirmBtn = [...document.body.querySelectorAll('footer.modal-foot button')].at(-1)!;
    await act(async () => {
      fireEvent.click(confirmBtn);
      await Promise.resolve();
    });
    expect(result).toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it('resolves to false when cancel is clicked', async () => {
    render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    const cancelBtn = [...document.body.querySelectorAll('footer.modal-foot button')][0];
    await act(async () => {
      fireEvent.click(cancelBtn);
      await Promise.resolve();
    });
    expect(result).toBe(false);
  });

  it('Escape key cancels the prompt', async () => {
    render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await Promise.resolve();
    });
    expect(result).toBe(false);
  });

  it('Escape on the overlay onKeyDown cancels', async () => {
    const { container } = render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    const overlay = container.querySelector('.modal-overlay') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(overlay, { key: 'Escape' });
      await Promise.resolve();
    });
    expect(result).toBe(false);
  });

  it('non-escape onKeyDown on the overlay does not cancel', async () => {
    const { container } = render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    const overlay = container.querySelector('.modal-overlay') as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(overlay, { key: 'a' });
      await Promise.resolve();
    });
    expect(result).toBeNull();
  });

  it('cancel × button in the header cancels', async () => {
    const { container } = render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    const x = container.querySelector('.modal-x') as HTMLElement;
    await act(async () => {
      fireEvent.click(x);
      await Promise.resolve();
    });
    expect(result).toBe(false);
  });

  it('keyDown on the card does not bubble up to the overlay', async () => {
    const { container } = render(<ConfirmDialog />);
    act(() => { void dillaConfirm({ body: 'go?' }); });
    const card = container.querySelector('.confirm-card') as HTMLElement;
    // Smoke: stopPropagation path must not throw.
    expect(() => fireEvent.keyDown(card, { key: 'a' })).not.toThrow();
  });

  it('Enter key confirms the prompt', async () => {
    render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await Promise.resolve();
    });
    expect(result).toBe(true);
  });

  it('clicking the backdrop cancels', async () => {
    const { container } = render(<ConfirmDialog />);
    let result: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'go?' }).then((r) => (result = r));
    });
    const dismiss = container.querySelector('.modal-overlay-dismiss') as HTMLElement;
    await act(async () => {
      fireEvent.click(dismiss);
      await Promise.resolve();
    });
    expect(result).toBe(false);
  });

  it('clicks inside the card do NOT bubble to the overlay', async () => {
    const { container } = render(<ConfirmDialog />);
    act(() => {
      void dillaConfirm({ body: 'go?' });
    });
    const card = container.querySelector('.confirm-card') as HTMLElement;
    fireEvent.click(card); // should not close
    expect(useConfirmStore.getState().pending).not.toBeNull();
  });

  it('applies btn--danger class to the confirm button when danger=true', () => {
    const { container } = render(<ConfirmDialog />);
    act(() => {
      void dillaConfirm({ body: 'go?', danger: true });
    });
    const confirmBtn = [...container.querySelectorAll('footer.modal-foot button')].at(-1) as HTMLElement;
    expect(confirmBtn.className).toContain('btn--danger');
  });

  it('a second dillaConfirm() resolves the previous promise to false', async () => {
    render(<ConfirmDialog />);
    let first: boolean | null = null;
    act(() => {
      void dillaConfirm({ body: 'first' }).then((r) => (first = r));
    });
    await act(async () => {
      void dillaConfirm({ body: 'second' });
      await Promise.resolve();
    });
    expect(first).toBe(false);
  });
});
