import { create } from 'zustand';

const STORAGE_KEY = 'dilla:verified-contacts:v1';

interface VerifiedRecord {
  /** Hex public key snapshot at the time of verification. If the peer's
   *  key later changes, the UI surfaces the mismatch so the user can
   *  re-verify rather than silently accepting a key rotation. */
  publicKeyHex: string;
  verifiedAt: number;
}

interface State {
  byUserId: Record<string, VerifiedRecord>;
  isVerified(userId: string, currentPublicKeyHex: string): 'verified' | 'changed' | 'unverified';
  markVerified(userId: string, publicKeyHex: string): void;
  clearVerified(userId: string): void;
}

function load(): Record<string, VerifiedRecord> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function persist(byUserId: Record<string, VerifiedRecord>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byUserId));
  } catch {
    /* quota / private mode — degrade silently */
  }
}

export const useVerifiedContacts = create<State>((set, get) => ({
  byUserId: load(),
  isVerified(userId, currentPublicKeyHex) {
    const rec = get().byUserId[userId];
    if (!rec) return 'unverified';
    const normalized = currentPublicKeyHex.replace(/[^0-9a-f]/gi, '').toLowerCase();
    if (!normalized) return 'unverified';
    return rec.publicKeyHex === normalized ? 'verified' : 'changed';
  },
  markVerified(userId, publicKeyHex) {
    const normalized = publicKeyHex.replace(/[^0-9a-f]/gi, '').toLowerCase();
    if (!normalized) return;
    const next = {
      ...get().byUserId,
      [userId]: { publicKeyHex: normalized, verifiedAt: Date.now() },
    };
    set({ byUserId: next });
    persist(next);
  },
  clearVerified(userId) {
    const next = { ...get().byUserId };
    delete next[userId];
    set({ byUserId: next });
    persist(next);
  },
}));
