import { describe, it, expect, beforeEach } from 'vitest';
import { useConfirmStore, dillaConfirm } from './confirmStore';

describe('useConfirmStore', () => {
  beforeEach(() => {
    useConfirmStore.setState({ pending: null, resolve: null });
  });

  it('starts with no pending request', () => {
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it('ask publishes a pending request', () => {
    const promise = useConfirmStore.getState().ask({ body: 'sure?' });
    expect(useConfirmStore.getState().pending?.body).toBe('sure?');
    // Resolve so the test doesn't leave a dangling promise.
    useConfirmStore.getState().answer(false);
    return promise;
  });

  it('answer(true) resolves the promise with true and clears state', async () => {
    const promise = useConfirmStore.getState().ask({ body: 'proceed?' });
    useConfirmStore.getState().answer(true);
    expect(await promise).toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(useConfirmStore.getState().resolve).toBeNull();
  });

  it('answer(false) resolves the promise with false', async () => {
    const promise = useConfirmStore.getState().ask({ body: 'wait' });
    useConfirmStore.getState().answer(false);
    expect(await promise).toBe(false);
  });

  it('opening a second prompt cancels the first as false', async () => {
    const first = useConfirmStore.getState().ask({ body: 'first?' });
    const second = useConfirmStore.getState().ask({ body: 'second?' });
    // The first promise must already have settled to false.
    expect(await first).toBe(false);
    // Second is still pending; answer it true.
    useConfirmStore.getState().answer(true);
    expect(await second).toBe(true);
  });

  it('dillaConfirm convenience wraps useConfirmStore.ask', async () => {
    const promise = dillaConfirm({ body: 'really?' });
    expect(useConfirmStore.getState().pending?.body).toBe('really?');
    useConfirmStore.getState().answer(false);
    expect(await promise).toBe(false);
  });

  it('answer when nothing is pending is a no-op', () => {
    expect(() => useConfirmStore.getState().answer(true)).not.toThrow();
    expect(useConfirmStore.getState().pending).toBeNull();
  });
});
