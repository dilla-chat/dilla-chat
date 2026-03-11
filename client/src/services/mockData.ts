import type { Team, Channel, Member, Role } from '../stores/teamStore';
import type { Message } from '../stores/messageStore';
import type { DMChannel } from '../stores/dmStore';
import type { Thread } from '../stores/threadStore';
import type { UserPresence } from '../stores/presenceStore';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEMO_TEAM_ID = 'demo-team';
export const DEMO_CURRENT_USER_ID = 'user-1';

// ─── Users ───────────────────────────────────────────────────────────────────

export interface MockUser {
  id: string;
  username: string;
  displayName: string;
}

export const MOCK_USERS: MockUser[] = [
  { id: 'user-1', username: 'alice', displayName: 'Alice' },
  { id: 'user-2', username: 'bob', displayName: 'Bob' },
  { id: 'user-3', username: 'charlie', displayName: 'Charlie' },
  { id: 'user-4', username: 'diana', displayName: 'Diana' },
  { id: 'user-5', username: 'eve', displayName: 'Eve' },
];

// ─── Team ────────────────────────────────────────────────────────────────────

export const MOCK_TEAM: Team = {
  id: DEMO_TEAM_ID,
  name: 'Slimcord Demo',
  description: 'A demo team to explore Slimcord',
  iconUrl: '',
  maxFileSize: 10_485_760,
  allowMemberInvites: true,
};

// ─── Roles ───────────────────────────────────────────────────────────────────

export const MOCK_ROLES: Role[] = [
  { id: 'role-admin', name: 'Admin', color: '#e74c3c', position: 2, permissions: 0xFFF, isDefault: false },
  { id: 'role-mod', name: 'Moderator', color: '#3498db', position: 1, permissions: 0x1FF, isDefault: false },
  { id: 'role-everyone', name: '@everyone', color: '#95a5a6', position: 0, permissions: 0x47, isDefault: true },
];

// ─── Channels ────────────────────────────────────────────────────────────────

export const MOCK_CHANNELS: Channel[] = [
  { id: 'ch-1', teamId: DEMO_TEAM_ID, name: 'welcome', topic: 'Welcome to Slimcord!', type: 'text', position: 0, category: 'General' },
  { id: 'ch-2', teamId: DEMO_TEAM_ID, name: 'general', topic: 'General discussion', type: 'text', position: 1, category: 'General' },
  { id: 'ch-3', teamId: DEMO_TEAM_ID, name: 'Voice Lounge', topic: '', type: 'voice', position: 2, category: 'General' },
  { id: 'ch-4', teamId: DEMO_TEAM_ID, name: 'backend', topic: 'Go server development', type: 'text', position: 3, category: 'Development' },
  { id: 'ch-5', teamId: DEMO_TEAM_ID, name: 'frontend', topic: 'Tauri client work', type: 'text', position: 4, category: 'Development' },
  { id: 'ch-6', teamId: DEMO_TEAM_ID, name: 'Standup', topic: '', type: 'voice', position: 5, category: 'Development' },
  { id: 'ch-7', teamId: DEMO_TEAM_ID, name: 'random', topic: 'Anything goes', type: 'text', position: 6, category: 'Off-Topic' },
];

// ─── Members ─────────────────────────────────────────────────────────────────

export const MOCK_MEMBERS: Member[] = [
  { id: 'member-1', userId: 'user-1', username: 'alice', displayName: 'Alice', nickname: '', roles: [MOCK_ROLES[0], MOCK_ROLES[2]], statusType: 'online' },
  { id: 'member-2', userId: 'user-2', username: 'bob', displayName: 'Bob', nickname: '', roles: [MOCK_ROLES[1], MOCK_ROLES[2]], statusType: 'idle' },
  { id: 'member-3', userId: 'user-3', username: 'charlie', displayName: 'Charlie', nickname: '', roles: [MOCK_ROLES[2]], statusType: 'online' },
  { id: 'member-4', userId: 'user-4', username: 'diana', displayName: 'Diana', nickname: '', roles: [MOCK_ROLES[2]], statusType: 'dnd' },
  { id: 'member-5', userId: 'user-5', username: 'eve', displayName: 'Eve', nickname: '', roles: [MOCK_ROLES[2]], statusType: 'offline' },
];

// ─── Helper: timestamps spread over the last hour ────────────────────────────

function ts(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// ─── Messages (in #general, ch-2) ────────────────────────────────────────────

export const MOCK_GENERAL_MESSAGES: Message[] = [
  {
    id: 'msg-1', channelId: 'ch-2', authorId: 'user-1', username: 'alice',
    content: 'Hey everyone! Welcome to the **Slimcord Demo** 🎉',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(58), reactions: [
      { emoji: '🎉', users: ['user-2', 'user-3', 'user-4'], count: 3 },
      { emoji: '❤️', users: ['user-3'], count: 1 },
    ],
  },
  {
    id: 'msg-2', channelId: 'ch-2', authorId: 'user-2', username: 'bob',
    content: 'Thanks Alice! This looks really great.',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(55), reactions: [
      { emoji: '👍', users: ['user-1'], count: 1 },
    ],
  },
  {
    id: 'msg-3', channelId: 'ch-2', authorId: 'user-3', username: 'charlie',
    content: 'Is this built with Tauri? The performance is incredible.',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(50), reactions: [],
  },
  {
    id: 'msg-4', channelId: 'ch-2', authorId: 'user-1', username: 'alice',
    content: 'Yep! Tauri + React + Go backend. The stack is:\n- Frontend: React with TypeScript\n- Desktop: Tauri\n- Backend: Go with WebSocket support',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(48), reactions: [
      { emoji: '🎉', users: ['user-3', 'user-5'], count: 2 },
    ],
  },
  {
    id: 'msg-5', channelId: 'ch-2', authorId: 'user-4', username: 'diana',
    content: 'The dark theme looks amazing. Is there a light theme option?',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(42), reactions: [],
  },
  {
    id: 'msg-6', channelId: 'ch-2', authorId: 'user-2', username: 'bob',
    content: "Not yet, but it's on the roadmap! Check #frontend for the discussion.",
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(40), reactions: [
      { emoji: '👍', users: ['user-4'], count: 1 },
    ],
  },
  {
    id: 'msg-7', channelId: 'ch-2', authorId: 'user-5', username: 'eve',
    content: 'Just joined! This feels so much snappier than Electron apps.',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(35), reactions: [
      { emoji: '❤️', users: ['user-1', 'user-2'], count: 2 },
    ],
  },
  {
    id: 'msg-8', channelId: 'ch-2', authorId: 'user-3', username: 'charlie',
    content: 'Has anyone tried the voice channels? Curious about latency.',
    encryptedContent: '', type: 'text', threadId: 'thread-1', editedAt: null,
    deleted: false, createdAt: ts(30), reactions: [],
  },
  {
    id: 'msg-9', channelId: 'ch-2', authorId: 'user-1', username: 'alice',
    content: "We're using WebRTC for voice. Should be pretty low latency! Try the Voice Lounge.",
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(28), reactions: [],
  },
  {
    id: 'msg-10', channelId: 'ch-2', authorId: 'user-4', username: 'diana',
    content: 'Love the threading support. Makes it way easier to follow conversations.',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(22), reactions: [
      { emoji: '😂', users: ['user-2'], count: 1 },
    ],
  },
  {
    id: 'msg-11', channelId: 'ch-2', authorId: 'user-2', username: 'bob',
    content: 'Quick tip: you can use `Ctrl+K` to open search and `Ctrl+/` for keyboard shortcuts.',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(18), reactions: [
      { emoji: '👍', users: ['user-3', 'user-5'], count: 2 },
    ],
  },
  {
    id: 'msg-12', channelId: 'ch-2', authorId: 'user-3', username: 'charlie',
    content: 'Check out this screenshot of the new member list design:',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(12), reactions: [],
  },
  {
    id: 'msg-13', channelId: 'ch-2', authorId: 'user-5', username: 'eve',
    content: "The emoji reactions are a nice touch 🙌",
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(8), reactions: [
      { emoji: '🎉', users: ['user-1', 'user-2', 'user-4'], count: 3 },
    ],
  },
  {
    id: 'msg-14', channelId: 'ch-2', authorId: 'user-1', username: 'alice',
    content: "Thanks everyone for checking out the demo! Feel free to explore all the channels and features. DMs work too — try sending one!",
    encryptedContent: '', type: 'text', threadId: null, editedAt: ts(4),
    deleted: false, createdAt: ts(5), reactions: [
      { emoji: '❤️', users: ['user-2', 'user-3', 'user-4', 'user-5'], count: 4 },
    ],
  },
  {
    id: 'msg-15', channelId: 'ch-2', authorId: 'user-2', username: 'bob',
    content: "Who's up for a standup call in the Dev voice channel?",
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(2), reactions: [],
  },
];

// ─── Welcome channel messages ────────────────────────────────────────────────

export const MOCK_WELCOME_MESSAGES: Message[] = [
  {
    id: 'wmsg-1', channelId: 'ch-1', authorId: 'user-1', username: 'alice',
    content: '# Welcome to Slimcord! 👋\n\nThis is a self-hosted, privacy-first chat platform. Explore the channels and have fun!',
    encryptedContent: '', type: 'text', threadId: null, editedAt: null,
    deleted: false, createdAt: ts(120), reactions: [
      { emoji: '👍', users: ['user-2', 'user-3', 'user-4', 'user-5'], count: 4 },
    ],
  },
];

// ─── DM Channels ─────────────────────────────────────────────────────────────

export const MOCK_DM_CHANNELS: DMChannel[] = [
  {
    id: 'dm-1', team_id: DEMO_TEAM_ID, is_group: false,
    members: [
      { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
      { user_id: 'user-2', username: 'bob', display_name: 'Bob' },
    ],
    last_message: {
      id: 'dm-msg-3', channelId: 'dm-1', authorId: 'user-2', username: 'bob',
      content: 'Sure, let me check the PR.', encryptedContent: '', type: 'text',
      threadId: null, editedAt: null, deleted: false, createdAt: ts(10), reactions: [],
    },
    created_at: ts(200),
  },
  {
    id: 'dm-2', team_id: DEMO_TEAM_ID, is_group: true,
    members: [
      { user_id: 'user-1', username: 'alice', display_name: 'Alice' },
      { user_id: 'user-3', username: 'charlie', display_name: 'Charlie' },
      { user_id: 'user-4', username: 'diana', display_name: 'Diana' },
    ],
    last_message: {
      id: 'dm2-msg-2', channelId: 'dm-2', authorId: 'user-4', username: 'diana',
      content: 'Sounds good, see you at 3!', encryptedContent: '', type: 'text',
      threadId: null, editedAt: null, deleted: false, createdAt: ts(30), reactions: [],
    },
    created_at: ts(300),
  },
];

// ─── DM Messages ─────────────────────────────────────────────────────────────

export const MOCK_DM_MESSAGES: Record<string, Message[]> = {
  'dm-1': [
    {
      id: 'dm-msg-1', channelId: 'dm-1', authorId: 'user-1', username: 'alice',
      content: 'Hey Bob, have you seen the latest federation changes?',
      encryptedContent: '', type: 'text', threadId: null, editedAt: null,
      deleted: false, createdAt: ts(20), reactions: [],
    },
    {
      id: 'dm-msg-2', channelId: 'dm-1', authorId: 'user-2', username: 'bob',
      content: 'Not yet! Is the gossip protocol working?',
      encryptedContent: '', type: 'text', threadId: null, editedAt: null,
      deleted: false, createdAt: ts(15), reactions: [],
    },
    {
      id: 'dm-msg-3', channelId: 'dm-1', authorId: 'user-2', username: 'bob',
      content: 'Sure, let me check the PR.',
      encryptedContent: '', type: 'text', threadId: null, editedAt: null,
      deleted: false, createdAt: ts(10), reactions: [],
    },
  ],
  'dm-2': [
    {
      id: 'dm2-msg-1', channelId: 'dm-2', authorId: 'user-3', username: 'charlie',
      content: 'Should we sync up about the UI redesign?',
      encryptedContent: '', type: 'text', threadId: null, editedAt: null,
      deleted: false, createdAt: ts(45), reactions: [],
    },
    {
      id: 'dm2-msg-2', channelId: 'dm-2', authorId: 'user-4', username: 'diana',
      content: 'Sounds good, see you at 3!',
      encryptedContent: '', type: 'text', threadId: null, editedAt: null,
      deleted: false, createdAt: ts(30), reactions: [],
    },
  ],
};

// ─── Threads ─────────────────────────────────────────────────────────────────

export const MOCK_THREADS: Thread[] = [
  {
    id: 'thread-1', channel_id: 'ch-2', parent_message_id: 'msg-8',
    team_id: DEMO_TEAM_ID, creator_id: 'user-3', title: 'Voice channel latency',
    message_count: 3, last_message_at: ts(25), created_at: ts(30),
  },
];

export const MOCK_THREAD_MESSAGES: Record<string, Message[]> = {
  'thread-1': [
    {
      id: 'tmsg-1', channelId: 'ch-2', authorId: 'user-2', username: 'bob',
      content: 'I tested it yesterday — latency was around 50ms in my local network.',
      encryptedContent: '', type: 'text', threadId: 'thread-1', editedAt: null,
      deleted: false, createdAt: ts(29), reactions: [],
    },
    {
      id: 'tmsg-2', channelId: 'ch-2', authorId: 'user-1', username: 'alice',
      content: 'Nice! We plan to add Opus codec support for even better quality.',
      encryptedContent: '', type: 'text', threadId: 'thread-1', editedAt: null,
      deleted: false, createdAt: ts(27), reactions: [
        { emoji: '👍', users: ['user-3'], count: 1 },
      ],
    },
    {
      id: 'tmsg-3', channelId: 'ch-2', authorId: 'user-3', username: 'charlie',
      content: "That would be awesome. I'll keep an eye on the #backend channel for updates.",
      encryptedContent: '', type: 'text', threadId: 'thread-1', editedAt: null,
      deleted: false, createdAt: ts(25), reactions: [],
    },
  ],
};

// ─── Presences ───────────────────────────────────────────────────────────────

export const MOCK_PRESENCES: Record<string, UserPresence> = {
  'user-1': { user_id: 'user-1', status: 'online', custom_status: '', last_active: ts(0) },
  'user-2': { user_id: 'user-2', status: 'idle', custom_status: '', last_active: ts(5) },
  'user-3': { user_id: 'user-3', status: 'online', custom_status: '', last_active: ts(0) },
  'user-4': { user_id: 'user-4', status: 'dnd', custom_status: 'In a meeting', last_active: ts(0) },
  'user-5': { user_id: 'user-5', status: 'offline', custom_status: '', last_active: ts(60) },
};

// ─── Random message content for simulated new messages ───────────────────────

export const RANDOM_MESSAGES = [
  'Has anyone tried the new keyboard shortcuts?',
  'Just pushed a fix for the notification bug 🐛',
  'The federation feature is looking really promising!',
  'brb, grabbing coffee ☕',
  "Who's available for a quick code review?",
  'Love how fast the messages load 🚀',
  'Just found an easter egg in the settings page 😄',
  'The thread support works really well!',
  'Anyone else excited about the upcoming release?',
  'Great work on the UI polish everyone! 👏',
];
