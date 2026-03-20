/**
 * WebAuthn/Passkey service with PRF extension for key derivation.
 *
 * The PRF extension derives a deterministic 32-byte secret from the passkey,
 * which is used to encrypt/decrypt the Ed25519 identity keypair.
 */

let cachedRpId: string | null = null;
let cachedRpName: string = 'Dilla';

/** Fetch RP config from the server, with fallback for Tauri */
async function getRpConfig(): Promise<{ rpId: string; rpName: string }> {
  if (cachedRpId) return { rpId: cachedRpId, rpName: cachedRpName };

  try {
    // Try fetching from the server that served this page
    const origin = window.location.origin;
    const resp = await fetch(`${origin}/api/v1/config`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const config = await resp.json();
      cachedRpId = config.rp_id || 'localhost';
      cachedRpName = config.rp_name || 'Dilla';
      return { rpId: cachedRpId!, rpName: cachedRpName };
    }
  } catch {
    // Not served from Go server (e.g. Tauri dev, Vite dev)
  }

  // Fallback to localhost for development
  cachedRpId = 'localhost';
  cachedRpName = 'Dilla';
  return { rpId: cachedRpId, rpName: cachedRpName };
}

/** Fetch RP config from a specific server URL */
export async function getRpConfigFromServer(serverUrl: string): Promise<{ rpId: string; rpName: string }> {
  try {
    const resp = await fetch(`${serverUrl}/api/v1/config`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const config = await resp.json();
      return {
        rpId: config.rp_id || 'localhost',
        rpName: config.rp_name || 'Dilla',
      };
    }
  } catch { /* fall through */ }
  return { rpId: 'localhost', rpName: 'Dilla' };
}

// PRF salt — fixed per-app constant used alongside the per-user salt
const APP_PRF_SALT = new TextEncoder().encode('dilla-prf-v1');

export interface PasskeyRegistrationResult {
  credentialId: string; // base64url-encoded
  credentialName: string;
  prfOutput: ArrayBuffer; // 32-byte PRF-derived secret
  prfSupported: boolean;
}

export interface PasskeyAuthResult {
  prfOutput: ArrayBuffer | null; // 32-byte PRF-derived secret, null if PRF unavailable
}

/**
 * Build the PRF extension input using both the app salt and a user-specific salt.
 */
function buildPRFExtension(userSalt: Uint8Array): Record<string, unknown> {
  // Combine app salt + user salt for the PRF eval input
  const combinedSalt = new Uint8Array(APP_PRF_SALT.length + userSalt.length);
  combinedSalt.set(APP_PRF_SALT, 0);
  combinedSalt.set(userSalt, APP_PRF_SALT.length);

  return {
    prf: {
      eval: {
        first: combinedSalt,
      },
    },
  };
}

/**
 * Register a new passkey with PRF extension.
 *
 * @param username - The user's display name for the credential
 * @param userId - Unique user identifier (e.g. UUID bytes)
 * @param prfSalt - The PRF salt to use (stored in identity.key)
 */
export async function registerPasskey(
  username: string,
  userId: Uint8Array,
  prfSalt: Uint8Array,
  serverUrl?: string,
): Promise<PasskeyRegistrationResult> {
  const { rpId, rpName } = serverUrl
    ? await getRpConfigFromServer(serverUrl)
    : await getRpConfig();
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const createOptions: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: {
      name: rpName,
      id: rpId,
    },
    user: {
      id: userId as BufferSource,
      name: username,
      displayName: username,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' }, // ES256
      { alg: -8, type: 'public-key' }, // EdDSA
      { alg: -257, type: 'public-key' }, // RS256
    ],
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    timeout: 60000,
    extensions: buildPRFExtension(prfSalt) as AuthenticationExtensionsClientInputs,
  };

  const credential = (await navigator.credentials.create({
    publicKey: createOptions,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error('Passkey registration was cancelled');
  }

  const credentialId = arrayBufferToBase64Url(credential.rawId);

  // Extract PRF output from extensions
  const extensions = credential.getClientExtensionResults() as Record<string, unknown>;
  const prfResults = extensions.prf as
    | { enabled?: boolean; results?: { first?: ArrayBuffer } }
    | undefined;

  const prfSupported = !!prfResults?.enabled || !!prfResults?.results?.first;
  let prfOutput: ArrayBuffer;

  if (prfResults?.results?.first) {
    prfOutput = prfResults.results.first;
  } else {
    // PRF not supported — caller checks prfSupported and falls back to passphrase
    prfOutput = new ArrayBuffer(0);
  }

  // Determine credential name from authenticator type
  const authenticatorName = detectAuthenticatorName();

  return {
    credentialId,
    credentialName: authenticatorName,
    prfOutput,
    prfSupported,
  };
}

/**
 * Authenticate with an existing passkey and get PRF output.
 *
 * @param credentialIds - Base64url-encoded credential IDs to allow
 * @param prfSalt - The PRF salt (from identity.key)
 */
export async function authenticatePasskey(
  credentialIds: string[],
  prfSalt: Uint8Array,
  serverUrl?: string,
): Promise<PasskeyAuthResult> {
  const { rpId } = serverUrl
    ? await getRpConfigFromServer(serverUrl)
    : await getRpConfig();
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const allowCredentials: PublicKeyCredentialDescriptor[] = credentialIds.map(
    (id) => ({
      id: base64UrlToArrayBuffer(id),
      type: 'public-key',
    }),
  );

  const getOptions: PublicKeyCredentialRequestOptions = {
    challenge,
    rpId,
    allowCredentials,
    userVerification: 'required',
    timeout: 60000,
    extensions: buildPRFExtension(prfSalt) as AuthenticationExtensionsClientInputs,
  };

  const assertion = (await navigator.credentials.get({
    publicKey: getOptions,
  })) as PublicKeyCredential | null;

  if (!assertion) {
    throw new Error('Passkey authentication was cancelled');
  }

  const extensions = assertion.getClientExtensionResults() as Record<string, unknown>;
  const prfResults = extensions.prf as
    | { results?: { first?: ArrayBuffer } }
    | undefined;

  if (!prfResults?.results?.first) {
    return { prfOutput: null };
  }

  return {
    prfOutput: prfResults.results.first,
  };
}

/**
 * Convert PRF output (ArrayBuffer) to a base64 string for passing to Tauri.
 */
export function prfOutputToBase64(prfOutput: ArrayBuffer): string {
  const bytes = new Uint8Array(prfOutput);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base32 recovery key string back to bytes.
 */
export function decodeRecoveryKey(encoded: string): Uint8Array {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const clean = encoded.replace(/-/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const result: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = ALPHABET.indexOf(clean[i]);
    if (idx === -1) throw new Error(`Invalid recovery key character: ${clean[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      result.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(result);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function detectAuthenticatorName(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'Touch ID';
  if (ua.includes('win')) return 'Windows Hello';
  if (ua.includes('android')) return 'Android Biometric';
  if (ua.includes('linux')) return 'Linux Authenticator';
  return 'Passkey';
}
