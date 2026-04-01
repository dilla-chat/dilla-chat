import { cryptoService, getIdentityKeys } from '../services/crypto';
import { toBase64 } from '../services/cryptoCore';
import { cacheMessage, getCachedMessage } from '../services/messageCache';
import type { Message } from '../stores/messageStore';
import type { Member } from '../stores/teamStore';

const DEV_PREFIX = '[DEV: unencrypted] ';

export interface ServerMessage {
  id: string;
  channel_id: string;
  author_id: string;
  username: string;
  content: string;
  type: string;
  thread_id: string | null;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  reactions: Array<{ emoji: string; users: string[]; count: number }>;
}

export async function tryDecrypt(
  messageId: string,
  content: string,
  senderId: string,
  channelId: string,
  derivedKey: string | null,
): Promise<string> {
  const cached = await getCachedMessage(messageId);
  if (cached !== null) return cached;
  const clean = content.startsWith(DEV_PREFIX) ? content.slice(DEV_PREFIX.length) : content;
  if (!derivedKey) return '\u{1F512} *Encrypted message \u2014 unlock your identity to read*';
  try {
    const userId = getIdentityKeys().publicKeyBytes;
    const plaintext = await cryptoService.decryptChannel(
      channelId,
      toBase64(userId),
      senderId,
      content,
      derivedKey,
    );
    await cacheMessage(messageId, channelId, plaintext);
    return plaintext;
  } catch {
    if (clean.length > 80 && /^[A-Za-z0-9+/=\s]+$/.test(clean.trim())) {
      return '\u{1F512} *Unable to decrypt \u2014 encrypted with a previous session key*';
    }
    return clean;
  }
}

export async function tryEncrypt(
  plaintext: string,
  channelId: string,
  derivedKey: string | null,
): Promise<string> {
  if (!derivedKey) throw new Error('Encryption key not available');
  const userId = getIdentityKeys().publicKeyBytes;
  return await cryptoService.encryptChannel(channelId, toBase64(userId), plaintext, derivedKey);
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
    editedAt: msg.edited_at,
    deleted: msg.deleted,
    createdAt: msg.created_at,
    reactions: msg.reactions ?? [],
  };
}
