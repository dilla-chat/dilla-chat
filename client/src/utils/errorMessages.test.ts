import { describe, it, expect, vi } from 'vitest';
import { friendlyError } from './errorMessages';

const t = vi.fn((key: string) => key);

describe('friendlyError', () => {
  it('maps UNIQUE constraint on username', () => {
    expect(friendlyError(new Error('db: UNIQUE constraint failed: users.username'), t))
      .toBe('errors.usernameAlreadyTaken');
  });

  it('maps UNIQUE constraint on public_key', () => {
    expect(friendlyError('Error: db: UNIQUE constraint failed: users.public_key', t))
      .toBe('errors.publicKeyAlreadyRegistered');
  });

  it('maps username or public key already registered', () => {
    expect(friendlyError(new Error('username or public key already registered'), t))
      .toBe('errors.usernameAlreadyTaken');
  });

  it('maps invalid bootstrap token', () => {
    expect(friendlyError(new Error('invalid bootstrap token'), t))
      .toBe('errors.invalidBootstrapToken');
  });

  it('maps bootstrap token already used', () => {
    expect(friendlyError(new Error('bootstrap token already used'), t))
      .toBe('errors.bootstrapTokenUsed');
  });

  it('maps invite not found', () => {
    expect(friendlyError(new Error('invite not found'), t))
      .toBe('errors.invalidInviteToken');
  });

  it('maps invite max uses reached', () => {
    expect(friendlyError(new Error('invite max uses reached'), t))
      .toBe('errors.inviteMaxUses');
  });

  it('maps invite expired', () => {
    expect(friendlyError(new Error('invite has expired'), t))
      .toBe('errors.inviteExpired');
  });

  it('maps invite revoked', () => {
    expect(friendlyError(new Error('invite has been revoked'), t))
      .toBe('errors.inviteRevoked');
  });

  it('maps invalid signature', () => {
    expect(friendlyError(new Error('invalid signature'), t))
      .toBe('errors.invalidSignature');
  });

  it('maps challenge expired', () => {
    expect(friendlyError(new Error('challenge not found or expired'), t))
      .toBe('errors.challengeExpired');
  });

  it('maps no account found', () => {
    expect(friendlyError(new Error('no account found for this public key — register first'), t))
      .toBe('errors.noAccount');
  });

  it('maps network errors', () => {
    expect(friendlyError(new Error('Failed to fetch'), t))
      .toBe('errors.networkError');
  });

  it('falls back to unknown for unrecognized errors', () => {
    expect(friendlyError(new Error('something completely unexpected'), t))
      .toBe('errors.unknown');
  });

  it('handles non-Error values', () => {
    expect(friendlyError(42, t)).toBe('errors.unknown');
  });
});
