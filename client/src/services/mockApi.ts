import type { Message } from '../stores/messageStore';
import type { Channel } from '../stores/teamStore';
import type { DMChannel } from '../stores/dmStore';
import type { Thread } from '../stores/threadStore';
import type { UserPresence, ReactionGroup, Attachment, VoiceState } from './api';
import type { ServerMessage } from '../hooks/useMessageDecryption';
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

/** Mock fixtures are stored in client-shape (camelCase) for ergonomics, but
 *  the real api returns ServerMessage snake-case off the wire. Project the
 *  fixture shape into ServerMessage when handing data to the load flow so
 *  serverToMessage / tryDecrypt see exactly what they would in prod. */
function toServer(msg: Message): ServerMessage {
  return {
    id: msg.id,
    channel_id: msg.channelId,
    author_id: msg.authorId,
    username: msg.username,
    content: msg.content,
    type: msg.type,
    thread_id: msg.threadId,
    edited_at: msg.editedAt,
    deleted: msg.deleted,
    created_at: msg.createdAt,
    reactions: msg.reactions,
  };
}

/**
 * Mock API service that stores everything in memory.
 * Has the same public method signatures as the real ApiService.
 */
export class MockApiService {
  private channels: Channel[] = [...MOCK_CHANNELS];
  private readonly messages: Map<string, Message[]> = new Map([
    ['ch-1', [...MOCK_WELCOME_MESSAGES]],
    ['ch-2', [...MOCK_GENERAL_MESSAGES]],
  ]);
  private readonly dmChannels: DMChannel[] = [...MOCK_DM_CHANNELS];
  private readonly dmMessages: Map<string, Message[]> = new Map(
    Object.entries(MOCK_DM_MESSAGES).map(([k, v]) => [k, [...v]]),
  );
  private threads: Thread[] = [...MOCK_THREADS];
  private readonly threadMessages: Map<string, Message[]> = new Map(
    Object.entries(MOCK_THREAD_MESSAGES).map(([k, v]) => [k, [...v]]),
  );

  // Connection stubs
  addTeam(_teamId: string, _baseUrl: string): void { /* noop */ }
  removeTeam(_teamId: string): void { /* noop */ }
  setToken(_teamId: string, _token: string): void { /* noop */ }
  setAuthErrorHandler(_handler: () => void): void { /* noop — mock never expires */ }
  getConnectionInfo(_teamId: string) {
    return { baseUrl: 'mock://demo', token: 'demo-token' };
  }
  async getWsTicket(_teamId: string): Promise<string> {
    return 'demo-ticket';
  }

  /** Synchronous handle on the demo identity so a wrapper can seed authStore
   *  before any React render, mimicking the persisted post-login state. */
  getDemoIdentity() {
    return {
      teamId: DEMO_TEAM_ID,
      token: 'demo-token',
      user: { id: DEMO_CURRENT_USER_ID, username: 'alice', display_name: 'Alice' },
      team: MOCK_TEAM,
    };
  }

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
  async revokeInvite() { /* noop */ }
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
  async updateMember() { /* noop */ }
  async kickMember() { /* noop */ }
  async banMember() { /* noop */ }
  async unbanMember() { /* noop */ }

  // Roles
  async getRoles() { return MOCK_ROLES; }
  async createRole(_teamId: string, data: { name: string; color: string; permissions: number }) {
    return { id: uid('role'), ...data, position: MOCK_ROLES.length, isDefault: false };
  }
  async updateRole(_teamId: string, _roleId: string, updates: Record<string, unknown>) { return updates; }
  async deleteRole() { /* noop */ }

  // Messages
  async getMessages(_teamId: string, channelId: string, _limit?: number, _before?: string): Promise<ServerMessage[]> {
    return (this.messages.get(channelId) ?? []).map(toServer);
  }

  // Federation
  async getFederationStatus() {
    return { node_name: 'demo-node', peers: [], lamport_ts: 1 };
  }
  async getFederationPeers() { return []; }
  async generateJoinToken() { return { token: 'demo-join', join_command: 'dilla-server join demo-join' }; }

  // DMs
  async createDM(_teamId: string, memberIds: string[]) {
    const members = memberIds.map(id => {
      const u = MOCK_USERS.find(u => u.id === id);
      return { user_id: id, username: u?.username ?? 'unknown', display_name: u?.displayName ?? 'Unknown' };
    });
    // Always include current user
    if (!members.some(m => m.user_id === DEMO_CURRENT_USER_ID)) {
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
  async getDMMessages(_teamId: string, dmId: string): Promise<ServerMessage[]> {
    return (this.dmMessages.get(dmId) ?? []).map(toServer);
  }
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
  async addDMMembers() { /* noop */ }
  async removeDMMember() { /* noop */ }

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
  async getThreadMessages(_teamId: string, threadId: string): Promise<ServerMessage[]> {
    return (this.threadMessages.get(threadId) ?? []).map(toServer);
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
  async deleteAttachment() { /* noop */ }

  // Presence
  async getPresences(): Promise<Record<string, UserPresence>> { return { ...MOCK_PRESENCES }; }
  async getUserPresence(_teamId: string, userId: string): Promise<UserPresence> {
    return MOCK_PRESENCES[userId] ?? { user_id: userId, status: 'offline' as const, custom_status: '', last_active: now() };
  }
  async updatePresence() { /* noop */ }

  // Voice
  async getVoiceState(_teamId: string, channelId: string): Promise<VoiceState> {
    return { channel_id: channelId, peers: [] };
  }
  async joinVoice(_teamId: string, channelId: string): Promise<VoiceState> {
    return { channel_id: channelId, peers: [{ user_id: DEMO_CURRENT_USER_ID, username: 'alice', muted: false, deafened: false, speaking: false, voiceLevel: 0 }] };
  }
  async leaveVoice() { /* noop */ }

  // Polls — keyed by channel_id so the mock matches the server's
  // list-by-channel endpoint. Each entry holds tallies and voter ids per
  // option so vote/unvote round-trips behave like the real server.
  private polls: Map<string, Array<{
    id: string; team_id: string; channel_id: string; question: string;
    options: string[]; voters: string[][]; created_by: string; created_at: string;
  }>> = new Map();

  async getPolls(_teamId: string, channelId: string): Promise<unknown[]> {
    return (this.polls.get(channelId) ?? []).map((p) => ({
      ...p,
      tallies: p.voters.map((v) => v.length),
    }));
  }
  async createPoll(
    teamId: string,
    channelId: string,
    body: { question: string; options: string[] },
  ): Promise<unknown> {
    const poll = {
      id: uid('poll'),
      team_id: teamId,
      channel_id: channelId,
      question: body.question.trim(),
      options: [...body.options],
      voters: body.options.map(() => [] as string[]),
      created_by: DEMO_CURRENT_USER_ID,
      created_at: now(),
    };
    const list = this.polls.get(channelId) ?? [];
    list.push(poll);
    this.polls.set(channelId, list);
    return { ...poll, tallies: poll.voters.map((v) => v.length) };
  }
  async votePoll(_teamId: string, pollId: string, optionIndex: number): Promise<unknown> {
    for (const list of this.polls.values()) {
      const poll = list.find((p) => p.id === pollId);
      if (!poll) continue;
      // Single-choice: clear the voter from every option, then add to chosen.
      poll.voters = poll.voters.map((arr) => arr.filter((u) => u !== DEMO_CURRENT_USER_ID));
      if (optionIndex >= 0 && optionIndex < poll.voters.length) {
        poll.voters[optionIndex].push(DEMO_CURRENT_USER_ID);
      }
      return { ...poll, tallies: poll.voters.map((v) => v.length) };
    }
    throw new Error('poll not found');
  }
  async unvotePoll(_teamId: string, pollId: string): Promise<unknown> {
    for (const list of this.polls.values()) {
      const poll = list.find((p) => p.id === pollId);
      if (!poll) continue;
      poll.voters = poll.voters.map((arr) => arr.filter((u) => u !== DEMO_CURRENT_USER_ID));
      return { ...poll, tallies: poll.voters.map((v) => v.length) };
    }
    throw new Error('poll not found');
  }

  // Channel mutes — keyed by channel_id, value is mutedUntil ISO (or null
  // for indefinite). Mirrors the real /me/muted-channels endpoint.
  private muted: Map<string, string | null> = new Map();
  async listMutedChannels(_teamId: string): Promise<unknown[]> {
    return Array.from(this.muted.entries()).map(([channel_id, muted_until]) => ({
      channel_id, muted_until,
    }));
  }
  async muteChannel(_teamId: string, channelId: string, mutedUntil?: string | null): Promise<unknown> {
    this.muted.set(channelId, mutedUntil ?? null);
    return { channel_id: channelId, muted_until: mutedUntil ?? null };
  }
  async unmuteChannel(_teamId: string, channelId: string): Promise<unknown> {
    this.muted.delete(channelId);
    return { ok: true };
  }

  // Gif search — mock returns a recognizable placeholder so the design
  // preview can demonstrate the message rendering without a network call.
  async searchGif(_teamId: string, query: string, limit?: number): Promise<{ url: string; query: string; results?: Array<{ url: string; preview: string }> }> {
    // Three demo URLs the mock cycles through so the picker has
    // distinguishable tiles. Real Giphy paths.
    const demo = [
      'https://media.giphy.com/media/3o7TKsQ8gqVrxZZprS/giphy.gif',
      'https://media.giphy.com/media/26ufnwz3wDUli7GU0/giphy.gif',
      'https://media.giphy.com/media/l0HlMVtNTGOuxAQqQ/giphy.gif',
    ];
    if (!limit || limit === 1) {
      return { url: demo[0], query };
    }
    const slice = demo.slice(0, Math.min(limit, demo.length));
    return {
      url: slice[0],
      query,
      results: slice.map((url) => ({ url, preview: url })),
    };
  }

  // Self-leave — mock no-op. On /mesh the demo team only has one member;
  // the real flow would tear down auth + redirect, but the demo session
  // can't re-bootstrap so we just resolve and let the UI notify.
  async leaveTeam(_teamId: string): Promise<void> { /* noop */ }

  // Block list — in-memory Set so /mesh can demo the unblock flow.
  private blocks: Set<string> = new Set();
  async listBlocks(_teamId: string): Promise<string[]> {
    return [...this.blocks];
  }
  async blockUser(_teamId: string, blockedId: string): Promise<void> {
    this.blocks.add(blockedId);
  }
  async unblockUser(_teamId: string, blockedId: string): Promise<void> {
    this.blocks.delete(blockedId);
  }

  // Pinned messages — { [channelId]: messageId[] } so /mesh can demo
  // the pin/unpin flow against the same store the real api hits.
  private pins: Map<string, string[]> = new Map();
  async listPins(_teamId: string, channelId: string): Promise<string[]> {
    return [...(this.pins.get(channelId) ?? [])];
  }
  async pinMessage(_teamId: string, channelId: string, messageId: string): Promise<void> {
    const list = this.pins.get(channelId) ?? [];
    if (!list.includes(messageId)) {
      this.pins.set(channelId, [messageId, ...list]);
    }
  }
  async unpinMessage(_teamId: string, channelId: string, messageId: string): Promise<void> {
    const list = this.pins.get(channelId) ?? [];
    this.pins.set(channelId, list.filter((id) => id !== messageId));
  }

  // Integrations — Giphy key flag, mirrored locally so /mesh can demo
  // the admin flow without a real backend.
  private giphyConfigured = false;
  async getGiphyIntegration(_teamId: string): Promise<{ configured: boolean }> {
    return { configured: this.giphyConfigured };
  }
  async setGiphyApiKey(_teamId: string, apiKey: string): Promise<{ configured: boolean }> {
    this.giphyConfigured = apiKey.trim().length > 0;
    return { configured: this.giphyConfigured };
  }

  // Channel groups — mirror the real-server CRUD + access endpoints so
  // /mesh can demo the right-click group settings flow.
  private groups: Array<{ id: string; name: string; position: number; access_role_ids: string[]; hidden_if_restricted: boolean }> = [];
  async listGroups(_teamId: string): Promise<Array<{ id: string; name: string; position: number; access_role_ids: string[]; hidden_if_restricted: boolean }>> {
    return this.groups.map((g) => ({ ...g }));
  }
  async createGroup(_teamId: string, name: string): Promise<{ id: string; name: string; position: number }> {
    const g = { id: uid('grp'), name: name.trim(), position: this.groups.length, access_role_ids: [], hidden_if_restricted: false };
    this.groups.push(g);
    return { id: g.id, name: g.name, position: g.position };
  }
  async updateGroup(_teamId: string, groupId: string, body: { name?: string; position?: number; hidden_if_restricted?: boolean }): Promise<{ id: string; name: string; position: number }> {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) throw new Error('group not found');
    if (body.name !== undefined) g.name = body.name.trim();
    if (body.position !== undefined) g.position = body.position;
    if (body.hidden_if_restricted !== undefined) g.hidden_if_restricted = body.hidden_if_restricted;
    return { id: g.id, name: g.name, position: g.position };
  }
  async deleteGroup(_teamId: string, groupId: string): Promise<void> {
    this.groups = this.groups.filter((g) => g.id !== groupId);
  }
  async getGroupAccess(_teamId: string, groupId: string): Promise<{ role_ids: string[]; hidden_if_restricted: boolean }> {
    const g = this.groups.find((x) => x.id === groupId);
    return { role_ids: g?.access_role_ids ?? [], hidden_if_restricted: g?.hidden_if_restricted ?? false };
  }
  async setGroupAccess(_teamId: string, groupId: string, roleIds: string[], hiddenIfRestricted?: boolean): Promise<{ role_ids: string[]; hidden_if_restricted: boolean }> {
    const g = this.groups.find((x) => x.id === groupId);
    if (g) {
      g.access_role_ids = [...roleIds];
      if (hiddenIfRestricted !== undefined) g.hidden_if_restricted = hiddenIfRestricted;
    }
    return { role_ids: roleIds, hidden_if_restricted: g?.hidden_if_restricted ?? false };
  }

  // Health
  async checkHealth(): Promise<boolean> { return true; }

  // Helper: add a message to a channel (used by MockWebSocket simulation)
  _addChannelMessage(channelId: string, msg: Message) {
    const list = this.messages.get(channelId) ?? [];
    list.push(msg);
    this.messages.set(channelId, list);
  }
}
