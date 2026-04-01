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
  });
});
