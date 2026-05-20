import { create } from 'zustand';

// Global "are you sure?" dialog — replaces window.confirm so we never
// surface OS chrome inside the app. Callers use `dillaConfirm(...)` which
// returns a Promise<boolean>; the ConfirmHost component (mounted once at
// AppShell level) renders the actual modal and resolves the promise on
// click. Only one prompt can be pending at a time; if you call
// dillaConfirm again while one is open the previous resolver is replaced
// (and the previous promise resolves to false so callers don't hang).

export interface ConfirmRequest {
  /** Optional title. Defaults to "Are you sure?". */
  title?: string;
  /** Body text (one paragraph; line breaks allowed). */
  body: string;
  /** Label on the confirm action. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label on the cancel action. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Tint the confirm button red and bias keyboard focus to Cancel. */
  danger?: boolean;
}

interface ConfirmStore {
  pending: ConfirmRequest | null;
  /** Internal — the open Promise's resolver. Cleared together with pending. */
  resolve: ((ok: boolean) => void) | null;
  ask: (req: ConfirmRequest) => Promise<boolean>;
  answer: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  pending: null,
  resolve: null,
  ask: (req) =>
    new Promise<boolean>((resolve) => {
      // If a previous request is still open, reject it as Cancel so its
      // caller's `if (!confirmed) return` path runs and we don't end up
      // resolving the wrong promise when the user clicks the new one.
      const prev = get().resolve;
      if (prev) prev(false);
      set({ pending: req, resolve });
    }),
  answer: (ok) => {
    const { resolve } = get();
    if (resolve) resolve(ok);
    set({ pending: null, resolve: null });
  },
}));

/** Convenience: open the confirm dialog and await the user's answer. */
export function dillaConfirm(req: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().ask(req);
}
