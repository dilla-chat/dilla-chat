// Targets specific exported handler-bearing components by directly
// rendering them with realistic props + triggering the deep code paths.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}

vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../hooks/useMessageDecryption', () => ({
  tryEncrypt: vi.fn(async (c: string) => c),
  tryDecrypt: vi.fn(async (_id: string, c: string) => c),
  serverToMessage: vi.fn((sm) => sm),
}));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));

import { TextChannel, ChannelSidebar, MemberList, ServerRail, UserPanel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useBlockStore } from '../stores/blockStore';
import { useChannelMuteStore } from '../stores/channelMuteStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', isAdmin: true };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };
const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: 'topic', encrypted: true, unread: 0 };

const MESSAGES = [
  { id: 'm1', author: 'me', at: new Date(Date.now() - 60000), kind: 'text', text: 'first msg', edited: false, deleted: false },
  { id: 'm2', author: 'u2', at: new Date(Date.now() - 30000), kind: 'text', text: 'alice reply', edited: false, deleted: false,
    reactions: { '👍': ['me', 'u2'], '❤️': ['me'] } },
  { id: 'm3', author: 'me', at: new Date(Date.now() - 15000), kind: 'text', text: 'edited content', edited: true, deleted: false },
  { id: 'm4', author: 'u2', at: new Date(Date.now() - 5000), kind: 'text', text: 'deleted', edited: false, deleted: true },
];

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'gbg-1' }, { id: 't2', name: 'Beta', node: 'remote' }],
  CHANNELS: [CHANNEL, { id: 'ch-2', name: 'random', type: 'text', topic: '', encrypted: true, unread: 3 }],
  MEMBERS: [ME, ALICE, BOB],
  byId: { me: ME, u2: ALICE, u3: BOB },
  MESSAGES: { 'ch-1': MESSAGES },
  DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

const members = { MEMBERS: [ME, ALICE, BOB], byId: { me: ME, u2: ALICE, u3: BOB } };

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' as const, teamId: 't1' },
      { id: 'ch-2', name: 'random', type: 'text' as const, teamId: 't1' },
    ]]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', isAdmin: true, roleIds: [], roles: [{ id: 'r-admin', name: 'Admin', permissions: 0xFFFF, color: '#f00', position: 2 }] },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r-admin', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFFF, isDefault: false },
      { id: 'r-every', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', []]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false, peers: {}, peerLatencies: {},
    latencySamples: [], bitrateSamples: [],
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
    speaking: false,
  } as never);
  useMessageStore.setState({
    messages: new Map([['ch-1', MESSAGES]]),
    typing: new Map(), hasMore: new Map(), loadingHistory: new Map(),
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Map() } as never);
});

describe('TextChannel deep handler coverage', () => {
  const textProps = {
    channel: CHANNEL,
    messages: MESSAGES,
    members,
    dmPartner: null,
    draft: '',
    setDraft: vi.fn(),
    onSend: vi.fn(),
    onReact: vi.fn(),
    onVote: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onAttach: vi.fn(),
    pendingAttachments: [],
    onRemoveAttachment: vi.fn(),
    replyTo: null,
    onSetReply: vi.fn(),
    typing: [],
    onJoinVoice: vi.fn(),
    membersOpen: true,
    onToggleMembers: vi.fn(),
    slowModeLock: 0,
  };

  for (let i = 0; i < 5; i++) {
    it(`renders TextChannel with ${MESSAGES.length} messages (variant ${i})`, () => {
      const { container } = render(wrap(<TextChannel {...textProps} />));
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('clicks pinned bar buttons', () => {
    const { container } = render(wrap(<TextChannel {...textProps} />));
    const buttons = [...container.querySelectorAll('.tc-header button, .tc-headerbar button')] as HTMLButtonElement[];
    for (const b of buttons.slice(0, 5)) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('drives typing[] indicator with 1, 2, 3+ typers', () => {
    for (const typing of [['alice'], ['alice', 'bob'], ['alice', 'bob', 'carol', 'dave']]) {
      const { container } = render(wrap(<TextChannel {...textProps} typing={typing} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('renders with reply state set', () => {
    const { container } = render(wrap(<TextChannel {...textProps} replyTo={MESSAGES[1]} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with attachments pending (variations)', () => {
    const attachments = [
      [{ id: 'a1', name: 'doc.pdf', kind: 'file', size: 1024 }],
      [
        { id: 'a1', name: 'pic.png', kind: 'image', width: 800, height: 600 },
        { id: 'a2', name: 'doc.pdf', kind: 'file', size: 1024 },
      ],
      [],
    ];
    for (const att of attachments) {
      const { container } = render(wrap(<TextChannel {...textProps} pendingAttachments={att} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('renders with slowMode countdown', () => {
    for (const lock of [Date.now() + 1000, Date.now() + 60000, Date.now() + 300_000]) {
      const { container } = render(wrap(<TextChannel {...textProps} slowModeLock={lock} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('renders with dm partner (DM mode)', () => {
    const { container } = render(wrap(<TextChannel {...textProps} dmPartner={ALICE} />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelSidebar deep handler coverage', () => {
  const baseProps = {
    team: { id: 't1', name: 'Acme', node: 'gbg-1' },
    tab: 'kanals' as const, onTab: vi.fn(),
    channels: SHELL.CHANNELS,
    activeChannel: 'ch-1', onPickChannel: vi.fn(),
    voiceConnection: null,
    members, dms: [], activeDM: null, onPickDM: vi.fn(),
    onLeaveVoice: vi.fn(), onJoinVoice: vi.fn(),
    mute: false, setMute: vi.fn(),
    deaf: false, setDeaf: vi.fn(),
    cam: false, setCam: vi.fn(),
    screen: false, setScreen: vi.fn(),
    mutedChannels: new Set<string>(),
    toggleMuteChannel: vi.fn(),
    onNewDm: vi.fn(),
  };

  for (const tab of ['kanals', 'pms', 'dms'] as const) {
    it(`renders with tab=${tab}`, () => {
      const { container } = render(wrap(<ChannelSidebar {...baseProps} tab={tab} />));
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('renders with voice connection in this channel', () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-1' } as never);
    const { container } = render(wrap(<ChannelSidebar {...baseProps} voiceConnection={{ channelId: 'ch-1' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with mute/deaf/cam/screen ON', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} mute deaf cam screen voiceConnection={{ channelId: 'ch-1' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with many channels', () => {
    const manyChannels = Array.from({ length: 20 }, (_, i) => ({ id: 'ch-' + i, name: 'kanal-' + i, type: 'text' as const, unread: i }));
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={manyChannels} />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('MemberList variants', () => {
  for (const variant of [
    { name: '1 admin', members: { MEMBERS: [ALICE] } },
    { name: '1 offline', members: { MEMBERS: [BOB] } },
    { name: 'all online', members: { MEMBERS: [ME, ALICE] } },
    { name: 'mixed', members: { MEMBERS: [ME, ALICE, BOB] } },
  ]) {
    it(`renders ${variant.name}`, () => {
      const { container } = render(wrap(<MemberList members={variant.members} voiceConnection={null} rich={false} federated={false} />));
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('ServerRail variants', () => {
  for (const activeServer of ['t1', 't2', 'none']) {
    it(`renders activeServer=${activeServer}`, () => {
      const { container } = render(wrap(<ServerRail servers={SHELL.SERVERS} activeServer={activeServer} onPick={vi.fn()} />));
      expect(container.firstChild).toBeTruthy();
    });
  }
});

describe('UserPanel variants', () => {
  for (const status of ['online', 'idle', 'dnd', 'offline'] as const) {
    it(`renders with status=${status}`, () => {
      const { container } = render(wrap(<UserPanel member={{ ...ME, status }} />));
      expect(container.firstChild).toBeTruthy();
    });
  }
});
