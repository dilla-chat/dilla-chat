import type { Message } from '../stores/messageStore';
import type { Channel } from '../stores/teamStore';
import type { DMChannel } from '../stores/dmStore';
import type { Thread } from '../stores/threadStore';
import type { UserPresence, ReactionGroup, Attachment, VoiceState } from './api';
import {
  DEMO_TEAM_ID, DEMO_CURRENT_USER_ID,
  MOCK_TEAM, MOCK_ROLES, MOCK_CHANNELS, MOCK_MEMBERS,
  MOCK_GENERAL_MESSAGES, MOCK_WELCOME_MESSAGES,
  MOCK_DM_CHANNELS, MOCK_DM_MESSAGES,
  MOCK_THREADS, MOCK_THREAD_MESSAGES,
  MOCK_PRESENCES, MOCK_USERS,
} from './mockData';

let counter = 1000;
function uid(prefix: string) { return `${prefix}-${++counter}`; }
function now() { return new Date().toISOString(); }

/**
 * Mock API service that stores everything in memory.
 * Has the same public method signatures as the real ApiService.
 */
export class MockApiService {
  private channels: Channel[] = [...MOCK_CHANNELS];
  private messages: Map<string, Message[]> = new Map([
    ['ch-1', [...MOCK_WELCOME_MESSAGES]],
    ['ch-2', [...MOCK_GENERAL_MESSAGES]],
  ]);
  private dmChannels: DMChannel[] = [...MOCK_DM_CHANNELS];
  private dmMessages: Map<string, Message[]> = new Map(
    Object.entries(MOCK_DM_MESSAGES).map(([k, v]) => [k, [...v]]),
  );
  private threads: Thread[] = [...MOCK_THREADS];
  private threadMessages: Map<string, Message[]> = new Map(
    Object.entries(MOCK_THREAD_MESSAGES).map(([k, v]) => [k, [...v]]),
  );

  // Connection stubs
  addTeam(_teamId: string, _baseUrl: string): void {}
  removeTeam(_teamId: string): void {}
  setToken(_teamId: string, _token: string): void {}

  // Auth — resolve immediately
  async requestChallenge(_teamId: string, _publicKey: string) {
    return { challenge_id: 'demo', nonce: 'demo' };
  }
  async verifyChallenge(_teamId: string, _challengeId: string, _publicKey: string, _signature: string) {
    return { token: 'demo-token', user: { id: DEMO_CURRENT_USER_ID, username: 'alice' } };
  }
  async register() { return { user: { id: DEMO_CURRENT_USER_ID, username: 'alice' }, token: 'demo-token' }; }
  async bootstrap() { return { user: { id: DEMO_CURRENT_USER_ID, username: 'alice' }, token: 'demo-token', team: MOCK_TEAM }; }

  // Invites
  async createInvite() { return { id: uid('inv'), token: 'demo-invite', uses: 0, max_uses: 10 }; }
  async listInvites() { return []; }
  async revokeInvite() {}
  async getInviteInfo() { return { team_name: MOCK_TEAM.name }; }

  // Team
  async getTeam() { return MOCK_TEAM; }
  async updateTeam(_teamId: string, updates: Record<string, unknown>) { return { ...MOCK_TEAM, ...updates }; }

  // Channels
  async getChannels() { return this.channels; }
  async createChannel(_teamId: string, data: { name: string; type: string; topic?: string; category?: string }) {
    const ch: Channel = {
      id: uid('ch'),
      teamId: DEMO_TEAM_ID,
      name: data.name,
      type: data.type as 'text' | 'voice',
      topic: data.topic ?? '',
      position: this.channels.length,
      category: data.category ?? '',
    };
    this.channels.push(ch);
    return ch;
  }
  async updateChannel(_teamId: string, channelId: string, updates: Record<string, unknown>) {
    const idx = this.channels.findIndex(c => c.id === channelId);
    if (idx >= 0) this.channels[idx] = { ...this.channels[idx], ...updates } as Channel;
    return this.channels[idx];
  }
  async deleteChannel(_teamId: string, channelId: string) {
    this.channels = this.channels.filter(c => c.id !== channelId);
  }

  // Members
  async getMembers() { return MOCK_MEMBERS; }
  async updateMember() {}
  async kickMember() {}
  async banMember() {}
  async unbanMember() {}

  // Roles
  async getRoles() { return MOCK_ROLES; }
  async createRole(_teamId: string, data: { name: string; color: string; permissions: number }) {
    return { id: uid('role'), ...data, position: MOCK_ROLES.length, isDefault: false };
  }
  async updateRole(_teamId: string, _roleId: string, updates: Record<string, unknown>) { return updates; }
  async deleteRole() {}

  // Messages
  async getMessages(_teamId: string, channelId: string, _limit?: number, _before?: string) {
    return this.messages.get(channelId) ?? [];
  }

  // Federation
  async getFederationStatus() {
    return { node_name: 'demo-node', peers: [], lamport_ts: 1 };
  }
  async getFederationPeers() { return []; }
  async generateJoinToken() { return { token: 'demo-join', join_command: 'slimcord join demo-join' }; }

  // DMs
  async createDM(_teamId: string, memberIds: string[]) {
    const members = memberIds.map(id => {
      const u = MOCK_USERS.find(u => u.id === id);
      return { user_id: id, username: u?.username ?? 'unknown', display_name: u?.displayName ?? 'Unknown' };
    });
    // Always include current user
    if (!members.find(m => m.user_id === DEMO_CURRENT_USER_ID)) {
      members.unshift({ user_id: DEMO_CURRENT_USER_ID, username: 'alice', display_name: 'Alice' });
    }
    const dm: DMChannel = {
      id: uid('dm'), team_id: DEMO_TEAM_ID,
      is_group: members.length > 2, members, created_at: now(),
    };
    this.dmChannels.push(dm);
    return dm;
  }
  async getDMChannels() { return this.dmChannels; }
  async getDMChannel(_teamId: string, dmId: string) { return this.dmChannels.find(d => d.id === dmId); }
  async sendDMMessage(_teamId: string, dmId: string, content: string) {
    const msg: Message = {
      id: uid('dm-msg'), channelId: dmId, authorId: DEMO_CURRENT_USER_ID, username: 'alice',
      content, encryptedContent: '', type: 'text', threadId: null,
      editedAt: null, deleted: false, createdAt: now(), reactions: [],
    };
    const list = this.dmMessages.get(dmId) ?? [];
    list.push(msg);
    this.dmMessages.set(dmId, list);
    return msg;
  }
  async getDMMessages(_teamId: string, dmId: string) { return this.dmMessages.get(dmId) ?? []; }
  async editDMMessage(_teamId: string, dmId: string, msgId: string, content: string) {
    const list = this.dmMessages.get(dmId) ?? [];
    const msg = list.find(m => m.id === msgId);
    if (msg) { msg.content = content; msg.editedAt = now(); }
    return msg;
  }
  async deleteDMMessage(_teamId: string, dmId: string, msgId: string) {
    const list = this.dmMessages.get(dmId) ?? [];
    const msg = list.find(m => m.id === msgId);
    if (msg) { msg.deleted = true; msg.content = ''; }
  }
  async addDMMembers() {}
  async removeDMMember() {}

  // Threads
  async createThread(_teamId: string, channelId: string, parentMessageId: string, title?: string) {
    const t: Thread = {
      id: uid('thread'), channel_id: channelId, parent_message_id: parentMessageId,
      team_id: DEMO_TEAM_ID, creator_id: DEMO_CURRENT_USER_ID, title: title ?? '',
      message_count: 0, last_message_at: null, created_at: now(),
    };
    this.threads.push(t);
    return t;
  }
  async getChannelThreads(_teamId: string, channelId: string) {
    return this.threads.filter(t => t.channel_id === channelId);
  }
  async getThread(_teamId: string, threadId: string) {
    return this.threads.find(t => t.id === threadId);
  }
  async updateThread(_teamId: string, threadId: string, title: string) {
    const t = this.threads.find(th => th.id === threadId);
    if (t) t.title = title;
    return t;
  }
  async deleteThread(_teamId: string, threadId: string) {
    this.threads = this.threads.filter(t => t.id !== threadId);
    this.threadMessages.delete(threadId);
  }
  async getThreadMessages(_teamId: string, threadId: string) {
    return this.threadMessages.get(threadId) ?? [];
  }
  async sendThreadMessage(_teamId: string, threadId: string, content: string) {
    const msg: Message = {
      id: uid('tmsg'), channelId: '', authorId: DEMO_CURRENT_USER_ID, username: 'alice',
      content, encryptedContent: '', type: 'text', threadId,
      editedAt: null, deleted: false, createdAt: now(), reactions: [],
    };
    const list = this.threadMessages.get(threadId) ?? [];
    list.push(msg);
    this.threadMessages.set(threadId, list);
    // Update thread meta
    const t = this.threads.find(th => th.id === threadId);
    if (t) { t.message_count++; t.last_message_at = now(); }
    return msg;
  }
  async editThreadMessage(_teamId: string, threadId: string, msgId: string, content: string) {
    const list = this.threadMessages.get(threadId) ?? [];
    const msg = list.find(m => m.id === msgId);
    if (msg) { msg.content = content; msg.editedAt = now(); }
    return msg;
  }
  async deleteThreadMessage(_teamId: string, threadId: string, msgId: string) {
    const list = this.threadMessages.get(threadId) ?? [];
    const msg = list.find(m => m.id === msgId);
    if (msg) { msg.deleted = true; msg.content = ''; }
  }

  // Reactions
  async addReaction(_teamId: string, channelId: string, messageId: string, emoji: string) {
    const list = this.messages.get(channelId) ?? [];
    const msg = list.find(m => m.id === messageId);
    if (!msg) return;
    const existing = msg.reactions.find(r => r.emoji === emoji);
    if (existing) {
      if (!existing.users.includes(DEMO_CURRENT_USER_ID)) {
        existing.users.push(DEMO_CURRENT_USER_ID);
        existing.count++;
      }
    } else {
      msg.reactions.push({ emoji, users: [DEMO_CURRENT_USER_ID], count: 1 });
    }
  }
  async removeReaction(_teamId: string, channelId: string, messageId: string, emoji: string) {
    const list = this.messages.get(channelId) ?? [];
    const msg = list.find(m => m.id === messageId);
    if (!msg) return;
    const r = msg.reactions.find(r => r.emoji === emoji);
    if (r) {
      r.users = r.users.filter(u => u !== DEMO_CURRENT_USER_ID);
      r.count = r.users.length;
      if (r.count === 0) msg.reactions = msg.reactions.filter(rx => rx.emoji !== emoji);
    }
  }
  async getReactions(_teamId: string, channelId: string, messageId: string): Promise<ReactionGroup[]> {
    const list = this.messages.get(channelId) ?? [];
    const msg = list.find(m => m.id === messageId);
    if (!msg) return [];
    return msg.reactions.map(r => ({
      emoji: r.emoji, count: r.count, users: r.users,
      me: r.users.includes(DEMO_CURRENT_USER_ID),
    }));
  }

  // Files — no-ops in demo
  async uploadFile(): Promise<Attachment> {
    return {
      id: uid('att'), message_id: '', filename: 'demo.png',
      content_type: 'image/png', size: 12345, url: '',
    };
  }
  getAttachmentUrl(): string { return ''; }
  async deleteAttachment() {}

  // Presence
  async getPresences(): Promise<Record<string, UserPresence>> { return { ...MOCK_PRESENCES }; }
  async getUserPresence(_teamId: string, userId: string): Promise<UserPresence> {
    return MOCK_PRESENCES[userId] ?? { user_id: userId, status: 'offline' as const, custom_status: '', last_active: now() };
  }
  async updatePresence() {}

  // Voice
  async getVoiceState(_teamId: string, channelId: string): Promise<VoiceState> {
    return { channel_id: channelId, peers: [] };
  }
  async joinVoice(_teamId: string, channelId: string): Promise<VoiceState> {
    return { channel_id: channelId, peers: [{ user_id: DEMO_CURRENT_USER_ID, username: 'alice', muted: false, deafened: false, speaking: false }] };
  }
  async leaveVoice() {}

  // Health
  async checkHealth(): Promise<boolean> { return true; }

  // Helper: add a message to a channel (used by MockWebSocket simulation)
  _addChannelMessage(channelId: string, msg: Message) {
    const list = this.messages.get(channelId) ?? [];
    list.push(msg);
    this.messages.set(channelId, list);
  }
}
