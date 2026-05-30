import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useVerifiedContacts } from './verifiedContactsStore';

const STORAGE_KEY = 'dilla:verified-contacts:v1';

describe('useVerifiedContacts', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    useVerifiedContacts.setState({ byUserId: {} });
  });

  it('returns "unverified" for an unknown user', () => {
    const status = useVerifiedContacts.getState().isVerified('u1', 'abc123');
    expect(status).toBe('unverified');
  });

  it('returns "verified" when the snapshotted key matches', () => {
    useVerifiedContacts.getState().markVerified('u1', 'AB CD ef');
    const status = useVerifiedContacts.getState().isVerified('u1', 'abcdef');
    expect(status).toBe('verified');
  });

  it('returns "changed" when the snapshotted key differs', () => {
    useVerifiedContacts.getState().markVerified('u1', 'abcdef');
    const status = useVerifiedContacts.getState().isVerified('u1', 'fedcba');
    expect(status).toBe('changed');
  });

  it('normalizes input — strips non-hex + lowercases', () => {
    useVerifiedContacts.getState().markVerified('u1', 'AB:CD\tEF');
    const status = useVerifiedContacts.getState().isVerified('u1', 'AB CD EF');
    expect(status).toBe('verified');
  });

  it('empty/non-hex input reads as "unverified" even when recorded', () => {
    useVerifiedContacts.getState().markVerified('u1', 'abcdef');
    expect(useVerifiedContacts.getState().isVerified('u1', '!!!')).toBe(
      'unverified',
    );
  });

  it('markVerified persists into localStorage', () => {
    useVerifiedContacts.getState().markVerified('u1', 'abcdef');
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.u1?.publicKeyHex).toBe('abcdef');
  });

  it('markVerified with non-hex input does nothing', () => {
    useVerifiedContacts.getState().markVerified('u1', '!!!');
    expect(useVerifiedContacts.getState().byUserId.u1).toBeUndefined();
  });

  it('clearVerified removes the record', () => {
    useVerifiedContacts.getState().markVerified('u1', 'abcdef');
    useVerifiedContacts.getState().clearVerified('u1');
    expect(useVerifiedContacts.getState().byUserId.u1).toBeUndefined();
    expect(useVerifiedContacts.getState().isVerified('u1', 'abcdef')).toBe(
      'unverified',
    );
  });

  it('load() returns {} when JSON.parse fails (catch branch L26-27)', async () => {
    localStorage.setItem(STORAGE_KEY, '{this is not}');
    vi.resetModules();
    const { useVerifiedContacts: fresh } = await import('./verifiedContactsStore');
    expect(fresh.getState().byUserId).toEqual({});
  });

  it('load() returns {} when JSON.parse yields non-object (L25)', async () => {
    localStorage.setItem(STORAGE_KEY, 'null');
    vi.resetModules();
    const { useVerifiedContacts: fresh } = await import('./verifiedContactsStore');
    expect(fresh.getState().byUserId).toEqual({});
  });

  it('load() hydrates from a valid stored payload (L24-25 success)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      'u-saved': { publicKeyHex: 'aabbcc', verifiedAt: 12345 },
    }));
    vi.resetModules();
    const { useVerifiedContacts: fresh } = await import('./verifiedContactsStore');
    expect(fresh.getState().byUserId['u-saved']?.publicKeyHex).toBe('aabbcc');
  });
});
