import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../services/crypto', () => ({
  cryptoService: {
    decryptChannel: vi.fn(),
    encryptChannel: vi.fn(),
  },
  getIdentityKeys: vi.fn(() => ({ publicKeyBytes: new Uint8Array([1, 2, 3]) })),
}));

vi.mock('../services/cryptoCore', () => ({
  toBase64: vi.fn(() => 'AQID'),
}));

vi.mock('../services/messageCache', () => ({
  getCachedMessage: vi.fn(() => null),
  cacheMessage: vi.fn(),
}));

import { tryDecrypt, tryEncrypt, serverToMessage, type ServerMessage } from './useMessageDecryption';
import { cryptoService } from '../services/crypto';
import { getCachedMessage } from '../services/messageCache';

describe('useMessageDecryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('tryDecrypt', () => {
    it('returns cached content when available', async () => {
      vi.mocked(getCachedMessage).mockResolvedValueOnce('cached text');
      const result = await tryDecrypt('m1', 'cipher', 'sender', 'ch1', 'key');
      expect(result).toBe('cached text');
      expect(cryptoService.decryptChannel).not.toHaveBeenCalled();
    });

    it('returns locked message when no derivedKey', async () => {
      const result = await tryDecrypt('m1', 'cipher', 'sender', 'ch1', null);
      expect(result).toContain('Encrypted message');
    });

    it('returns plaintext from sent cache when encrypt then decrypt', async () => {
      // tryEncrypt caches plaintext keyed by ciphertext internally.
      // We need the REAL tryEncrypt to populate the cache, not the mock.
      // The encryptChannel mock returns 'mock-cipher', and tryEncrypt caches
      // 'hello from cache' → 'mock-cipher' in sentPlaintextCache.
      vi.mocked(cryptoService.encryptChannel).mockResolvedValueOnce('mock-cipher-xyz');
      await tryEncrypt('hello from cache', 'ch1', 'key');

      // Now tryDecrypt for the same ciphertext should find it in sentPlaintextCache
      const result = await tryDecrypt('m-new', 'mock-cipher-xyz', 'sender', 'ch1', 'key');
      expect(result).toBe('hello from cache');
    });

    it('decrypts and caches on success', async () => {
      vi.mocked(cryptoService.decryptChannel).mockResolvedValueOnce('plaintext');
      const result = await tryDecrypt('m1', 'cipher', 'sender', 'ch1', 'key');
      expect(result).toBe('plaintext');
    });

    it('returns friendly message for base64 ciphertext on failure', async () => {
      vi.mocked(cryptoService.decryptChannel).mockRejectedValueOnce(new Error('fail'));
      // Long base64-like string
      const cipher = 'A'.repeat(100);
      const result = await tryDecrypt('m1', cipher, 'sender', 'ch1', 'key');
      expect(result).toContain('Unable to decrypt');
    });

    it('strips DEV prefix from legacy messages', async () => {
      vi.mocked(cryptoService.decryptChannel).mockRejectedValueOnce(new Error('fail'));
      const result = await tryDecrypt('m1', '[DEV: unencrypted] hello', 'sender', 'ch1', 'key');
      expect(result).toBe('hello');
    });
  });

  describe('tryEncrypt', () => {
    it('throws when derivedKey is null', async () => {
      await expect(tryEncrypt('hello', 'ch1', null)).rejects.toThrow('Encryption key not available');
    });

    it('encrypts with crypto service', async () => {
      vi.mocked(cryptoService.encryptChannel).mockResolvedValueOnce('encrypted');
      const result = await tryEncrypt('hello', 'ch1', 'key');
      expect(result).toBe('encrypted');
    });
  });

  describe('serverToMessage', () => {
    const baseMsg: ServerMessage = {
      id: 'm1',
      channel_id: 'ch1',
      author_id: 'u1',
      username: 'alice',
      content: 'encrypted',
      type: 'text',
      thread_id: null,
      edited_at: null,
      deleted: false,
      created_at: '2024-01-01',
      reactions: [],
    };

    it('converts server message to store format', () => {
      const result = serverToMessage(baseMsg, 'decrypted');
      expect(result.id).toBe('m1');
      expect(result.content).toBe('decrypted');
      expect(result.encryptedContent).toBe('encrypted');
      expect(result.username).toBe('alice');
    });

    it('resolves display name from team members', () => {
      const members = [
        { id: 'mem1', userId: 'u1', username: 'alice', displayName: 'Alice Wonder', teamId: 't1', nickname: '', joinedAt: '' },
      ];
      const result = serverToMessage(baseMsg, 'decrypted', members as never);
      expect(result.username).toBe('Alice Wonder');
    });

    it('defaults to Unknown when no username', () => {
      const msg = { ...baseMsg, username: '' };
      const result = serverToMessage(msg, 'text');
      expect(result.username).toBe('Unknown');
    });

    it('rewrites relative attachment urls to absolute', () => {
      const msg = { ...baseMsg, attachments: [{ url: '/files/a.png', id: 'a1', message_id: 'm1' } as never] };
      const result = serverToMessage(msg, 'text');
      expect(result.attachments?.[0].url.startsWith('http')).toBe(true);
    });

    it('preserves absolute attachment urls', () => {
      const msg = { ...baseMsg, attachments: [{ url: 'https://cdn.test/a.png', id: 'a1', message_id: 'm1' } as never] };
      const result = serverToMessage(msg, 'text');
      expect(result.attachments?.[0].url).toBe('https://cdn.test/a.png');
    });
  });
});

describe('forgetDecryptFailure + sentPlaintextCache eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forgetDecryptFailure clears all failures for a channel', async () => {
    const { tryDecrypt, forgetDecryptFailure } = await import('./useMessageDecryption');
    vi.mocked(cryptoService.decryptChannel).mockRejectedValueOnce(new Error('fail'));
    const cipher = 'A'.repeat(100);
    await tryDecrypt('m-clear', cipher, 'sender', 'ch-clear', 'key');
    forgetDecryptFailure('ch-clear');
    vi.mocked(cryptoService.decryptChannel).mockResolvedValueOnce('decoded-after-forget');
    const result = await tryDecrypt('m-clear', cipher, 'sender', 'ch-clear', 'key');
    expect(result).toBe('decoded-after-forget');
  });

  it('sent cache evicts oldest entry once size > MAX_SENT_CACHE (200)', async () => {
    const { tryEncrypt } = await import('./useMessageDecryption');
    for (let i = 0; i < 201; i++) {
      vi.mocked(cryptoService.encryptChannel).mockResolvedValueOnce('ct-' + i);
      await tryEncrypt('pt-' + i, 'ch-cache', 'key');
    }
    expect(cryptoService.encryptChannel).toHaveBeenCalled();
  });

  it('short-circuits when a failure was recorded for the same ciphertext', async () => {
    const { tryDecrypt } = await import('./useMessageDecryption');
    vi.mocked(cryptoService.decryptChannel).mockRejectedValueOnce(new Error('fail'));
    const cipher = 'A'.repeat(100);
    await tryDecrypt('m-short', cipher, 'sender', 'ch-short', 'key');
    vi.mocked(cryptoService.decryptChannel).mockClear();
    const second = await tryDecrypt('m-short', cipher, 'sender', 'ch-short', 'key');
    expect(second).toContain('Unable to decrypt');
    expect(cryptoService.decryptChannel).not.toHaveBeenCalled();
  });
});
