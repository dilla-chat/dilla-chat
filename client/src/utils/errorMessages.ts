import type { TFunction } from 'i18next';

/**
 * Map raw server/network error messages to user-friendly i18n keys.
 * Falls back to a generic message if no pattern matches.
 */
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/UNIQUE constraint failed: users\.username/i, 'errors.usernameAlreadyTaken'],
  [/UNIQUE constraint failed: users\.public_key/i, 'errors.publicKeyAlreadyRegistered'],
  [/username or public key already registered/i, 'errors.usernameAlreadyTaken'],
  [/invalid bootstrap token/i, 'errors.invalidBootstrapToken'],
  [/bootstrap token already used/i, 'errors.bootstrapTokenUsed'],
  [/invite not found/i, 'errors.invalidInviteToken'],
  [/invite max uses reached/i, 'errors.inviteMaxUses'],
  [/invite has expired/i, 'errors.inviteExpired'],
  [/invite has been revoked/i, 'errors.inviteRevoked'],
  [/invalid signature/i, 'errors.invalidSignature'],
  [/challenge not found or expired/i, 'errors.challengeExpired'],
  [/challenge expired/i, 'errors.challengeExpired'],
  [/no account found/i, 'errors.noAccount'],
  [/Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED/i, 'errors.networkError'],
  [/fetch|network/i, 'errors.networkError'],
];

export function friendlyError(error: unknown, t: TFunction): string {
  const raw = error instanceof Error ? error.message : String(error);

  for (const [pattern, key] of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return t(key);
    }
  }

  return t('errors.unknown');
}
