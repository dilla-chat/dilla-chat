import { cryptoService, getIdentityKeys } from '../services/crypto';
import { toBase64 } from '../services/cryptoCore';
import { cacheMessage, getCachedMessage } from '../services/messageCache';
import type { Message } from '../stores/messageStore';
import type { Member } from '../stores/teamStore';

const DEV_PREFIX = '[DEV: unencrypted] ';

// In-memory cache: ciphertext → plaintext for messages we just sent.
// The sender key ratchet advances on encrypt, so we can't decrypt our own
// messages when the server echoes them back. This cache bridges the gap
// until the message ID is known and we can persist to the message cache.
const sentPlaintextCache = new Map<string, string>();
const MAX_SENT_CACHE = 200;

export interface ServerMessage {
  id: string;
  channel_id: string;
  author_id: string;
  username: string;
  content: string;
  type: string;
  thread_id: string | null;
  reply_to_message_id?: string | null;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  reactions: Array<{ emoji: string; users: string[]; count: number }>;
  attachments?: Array<{ id: string; filename: string; content_type: string; size: number; url: string }>;
}

// In-memory set of message IDs that already failed to decrypt this session.
// Subsequent calls return the placeholder without re-attempting the AES-GCM
// open (which would just fail the same way and re-warn). The set is per-tab
// and cleared by `forgetDecryptFailure(channelId)` whenever a fresh sender
// key for that channel arrives, so a successful redistribute does still
// trigger a retry. NOT persisted \u2014 a reload starts a fresh attempt.
// messageId -> { channelId, ciphertext }. The ciphertext lets us detect when
// the server-side wire content has changed (an edit landed) so we re-attempt
// instead of returning the placeholder forever.
const failedDecrypts = new Map<string, { channelId: string; ciphertext: string }>();

export function forgetDecryptFailure(channelId: string): void {
  for (const [msgId, entry] of failedDecrypts) {
    if (entry.channelId === channelId) failedDecrypts.delete(msgId);
  }
}

function placeholderFor(clean: string): string {
  if (clean.length > 80 && /^[A-Za-z0-9+/=\s]+$/.test(clean.trim())) {
    return '\u{1F512} *Unable to decrypt \u2014 encrypted with a previous session key*';
  }
  return clean;
}

export async function tryDecrypt(
  messageId: string,
  content: string,
  senderId: string,
  channelId: string,
  derivedKey: string | null,
): Promise<string> {
  // Check persistent message cache first — pass the wire ciphertext so a
  // server-side edit (different ciphertext for the same id) invalidates the
  // cache and forces a re-decrypt, instead of returning stale plaintext.
  const cached = await getCachedMessage(messageId, content);
  if (cached !== null) return cached;

  // Check sent-message plaintext cache (for our own messages echoed back)
  const sentPlaintext = sentPlaintextCache.get(content);
  if (sentPlaintext !== undefined) {
    sentPlaintextCache.delete(content);
    // Persist to durable cache now that we have the message ID
    await cacheMessage(messageId, channelId, sentPlaintext, content);
    return sentPlaintext;
  }

  const clean = content.startsWith(DEV_PREFIX) ? content.slice(DEV_PREFIX.length) : content;
  if (!derivedKey) return '\u{1F512} *Encrypted message \u2014 unlock your identity to read*';

  // Short-circuit messages that already failed this session \u2014 but only
  // when the wire ciphertext hasn't changed since the failure. An edit
  // produces a new ciphertext and deserves a fresh attempt.
  const prev = failedDecrypts.get(messageId);
  if (prev && prev.ciphertext === content) {
    return placeholderFor(clean);
  }
  try {
    const userId = getIdentityKeys().publicKeyBytes;
    const plaintext = await cryptoService.decryptChannel(
      channelId,
      toBase64(userId),
      senderId,
      content,
      derivedKey,
    );
    await cacheMessage(messageId, channelId, plaintext, content);
    failedDecrypts.delete(messageId);
    return plaintext;
  } catch (err) {
    failedDecrypts.set(messageId, { channelId, ciphertext: content });
    console.warn(`[Decrypt] Failed for msg=${messageId} channel=${channelId} sender=${senderId}:`, err);
    return placeholderFor(clean);
  }
}

export async function tryEncrypt(
  plaintext: string,
  channelId: string,
  derivedKey: string | null,
): Promise<string> {
  if (!derivedKey) throw new Error('Encryption key not available');
  const userId = getIdentityKeys().publicKeyBytes;
  const ciphertext = await cryptoService.encryptChannel(channelId, toBase64(userId), plaintext, derivedKey);

  // Cache plaintext keyed by ciphertext so tryDecrypt can find it when
  // the server echoes the message back (ratchet has already advanced).
  sentPlaintextCache.set(ciphertext, plaintext);
  if (sentPlaintextCache.size > MAX_SENT_CACHE) {
    // Evict oldest entry
    const first = sentPlaintextCache.keys().next().value;
    if (first) sentPlaintextCache.delete(first);
  }

  return ciphertext;
}

function resolveDisplayName(member: Member | undefined): string | null {
  if (!member) return null;
  const raw = member as unknown as Record<string, string>;
  return member.displayName || raw.display_name || member.username || null;
}

export function serverToMessage(
  msg: ServerMessage,
  decryptedContent: string,
  teamMembers?: Member[],
): Message {
  let username: string = msg.username || 'Unknown';
  if (teamMembers) {
    const raw = teamMembers as unknown as Array<Record<string, string>>;
    const member = teamMembers.find(
      (m, i) => (m.userId || raw[i].user_id) === msg.author_id || m.id === msg.author_id,
    );
    username = resolveDisplayName(member) ?? username;
  }
  return {
    id: msg.id,
    channelId: msg.channel_id,
    authorId: msg.author_id,
    username: username ?? 'Unknown',
    content: decryptedContent,
    encryptedContent: msg.content,
    type: msg.type,
    threadId: msg.thread_id,
    replyToMessageId: msg.reply_to_message_id ?? null,
    editedAt: msg.edited_at,
    deleted: msg.deleted,
    createdAt: msg.created_at,
    reactions: msg.reactions ?? [],
    attachments: msg.attachments?.map((a) => ({
      ...a,
      url: a.url.startsWith('/') ? `${window.location.origin}${a.url}` : a.url,
    })),
  } as Message;
}
