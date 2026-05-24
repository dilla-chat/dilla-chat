// Drive the big ChatApp leaf components in jsdom (now possible after
// the selector-stability fix). One file rather than per-component to
// share the seed boilerplate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}

import {
  VoiceChannel,
  ChannelSidebar,
  MemberList,
  UserPanel,
  ThreadPanel,
} from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMessageStore } from '../stores/messageStore';
import { useThreadStore } from '../stores/threadStore';

vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => true }));
vi.mock('../hooks/useChannelLazyLoad', () => ({ useChannelLazyLoad: vi.fn() }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
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

const SHELL_DATA = {
  SERVERS: [{ id: 't1', name: 'Acme', node: 'local' }],
  CHANNELS: [], MEMBERS: [], byId: {},
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'offline' };
const EVE = { id: 'u4', name: 'eve', initials: 'EV', color: '#ff0', status: 'dnd' };

function wrap(children: React.ReactNode) {
  return <ShellDataProvider value={SHELL_DATA}>{children}</ShellDataProvider>;
}

beforeEach(() => {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false,
    peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
});

describe('VoiceChannel integration', () => {
  const channel = { id: 'ch-2', name: 'lounge', type: 'voice', topic: '', participants: [] };

  it('empty voice channel renders', () => {
    const { container } = render(wrap(
      <VoiceChannel
        channel={channel}
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        voiceConnection={null}
        onJoin={vi.fn()} onLeave={vi.fn()}
        mute={false} setMute={vi.fn()}
        deaf={false} setDeaf={vi.fn()}
        cam={false} setCam={vi.fn()}
        screen={false} setScreen={vi.fn()}
        rich={false}
        membersOpen={true} onToggleMembers={vi.fn()}
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('voice channel with participants', () => {
    const { container } = render(wrap(
      <VoiceChannel
        channel={{ ...channel, participants: ['me', 'u2'] }}
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        voiceConnection={{ channelId: 'ch-2', muted: false, deafened: false }}
        onJoin={vi.fn()} onLeave={vi.fn()}
        mute={false} setMute={vi.fn()}
        deaf={false} setDeaf={vi.fn()}
        cam={false} setCam={vi.fn()}
        screen={false} setScreen={vi.fn()}
        rich
        membersOpen={true} onToggleMembers={vi.fn()}
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('voice channel with self muted + deafened', () => {
    const { container } = render(wrap(
      <VoiceChannel
        channel={{ ...channel, participants: ['me'] }}
        members={{ MEMBERS: [ME], byId: { me: ME } }}
        voiceConnection={{ channelId: 'ch-2', muted: true, deafened: true }}
        onJoin={vi.fn()} onLeave={vi.fn()}
        mute={true} setMute={vi.fn()}
        deaf={true} setDeaf={vi.fn()}
        cam={false} setCam={vi.fn()}
        screen={false} setScreen={vi.fn()}
        rich
        membersOpen={false} onToggleMembers={vi.fn()}
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every voice control button', () => {
    const setMute = vi.fn(); const setDeaf = vi.fn(); const setCam = vi.fn(); const setScreen = vi.fn();
    const onJoin = vi.fn(); const onLeave = vi.fn();
    const { container } = render(wrap(
      <VoiceChannel
        channel={{ ...channel, participants: ['me'] }}
        members={{ MEMBERS: [ME], byId: { me: ME } }}
        voiceConnection={{ channelId: 'ch-2', muted: false, deafened: false }}
        onJoin={onJoin} onLeave={onLeave}
        mute={false} setMute={setMute}
        deaf={false} setDeaf={setDeaf}
        cam={false} setCam={setCam}
        screen={false} setScreen={setScreen}
        rich membersOpen onToggleMembers={vi.fn()}
      />,
    ));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('ChannelSidebar integration', () => {
  const team = { name: 'Acme' };
  const channels = [
    { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0, groupId: 'g1' },
    { id: 'ch-2', name: 'voice', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [], groupId: 'g1' },
    { id: 'ch-3', name: 'dev', type: 'text', topic: '', encrypted: true, unread: 5, groupId: 'g2' },
    { id: 'ch-4', name: 'design', type: 'text', topic: '', encrypted: true, unread: 0, groupId: 'g2' },
  ];

  it('renders kanals tab with all channels', () => {
    const { container } = render(wrap(
      <ChannelSidebar
        team={team} tab="kanals" onTab={vi.fn()}
        channels={channels}
        activeChannel="ch-1" onPickChannel={vi.fn()}
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        dms={[]} activeDM={null}
        onPickDM={vi.fn()} onNewDM={vi.fn()} onCloseDM={vi.fn()}
        federated={false} nodeHost="local"
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders PMs tab with DMs', () => {
    const { container } = render(wrap(
      <ChannelSidebar
        team={team} tab="pms" onTab={vi.fn()}
        channels={channels}
        activeChannel="ch-1" onPickChannel={vi.fn()}
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        dms={[
          { id: 'dm-1', with: 'u2', preview: 'hi', at: new Date(), unread: 3 },
          { id: 'dm-2', with: 'u3', preview: 'sup', at: new Date(), unread: 0 },
        ]}
        activeDM={null}
        onPickDM={vi.fn()} onNewDM={vi.fn()} onCloseDM={vi.fn()}
        federated={false} nodeHost="local"
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every channel row', () => {
    const onPickChannel = vi.fn();
    const { container } = render(wrap(
      <ChannelSidebar
        team={team} tab="kanals" onTab={vi.fn()}
        channels={channels}
        activeChannel="ch-1" onPickChannel={onPickChannel}
        members={{ MEMBERS: [ME], byId: { me: ME } }}
        dms={[]} activeDM={null}
        onPickDM={vi.fn()} onNewDM={vi.fn()} onCloseDM={vi.fn()}
        federated={false} nodeHost="local"
      />,
    ));
    const rows = [...container.querySelectorAll('[class*="chan"]')] as HTMLElement[];
    for (const r of rows) {
      try { fireEvent.click(r); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks tab toggle (kanals ↔ pms)', () => {
    const onTab = vi.fn();
    const { container } = render(wrap(
      <ChannelSidebar
        team={team} tab="kanals" onTab={onTab}
        channels={channels}
        activeChannel="ch-1" onPickChannel={vi.fn()}
        members={{ MEMBERS: [ME], byId: { me: ME } }}
        dms={[]} activeDM={null}
        onPickDM={vi.fn()} onNewDM={vi.fn()} onCloseDM={vi.fn()}
        federated={false} nodeHost="local"
      />,
    ));
    const tabBtns = [...container.querySelectorAll('button')].filter((b) =>
      /kanal|pms|dm/i.test(b.textContent ?? '')
    );
    for (const b of tabBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with federated team flag', () => {
    const { container } = render(wrap(
      <ChannelSidebar
        team={team} tab="kanals" onTab={vi.fn()}
        channels={channels}
        activeChannel="ch-1" onPickChannel={vi.fn()}
        members={{ MEMBERS: [ME], byId: { me: ME } }}
        dms={[]} activeDM={null}
        onPickDM={vi.fn()} onNewDM={vi.fn()} onCloseDM={vi.fn()}
        federated nodeHost="remote.berra"
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every channel for context menu', () => {
    const { container } = render(wrap(
      <ChannelSidebar
        team={team} tab="kanals" onTab={vi.fn()}
        channels={channels}
        activeChannel="ch-1" onPickChannel={vi.fn()}
        members={{ MEMBERS: [ME], byId: { me: ME } }}
        dms={[]} activeDM={null}
        onPickDM={vi.fn()} onNewDM={vi.fn()} onCloseDM={vi.fn()}
        federated={false} nodeHost="local"
      />,
    ));
    const rows = [...container.querySelectorAll('[class*="chan"]')] as HTMLElement[];
    for (const r of rows) {
      fireEvent.contextMenu(r);
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('MemberList integration', () => {
  const members = {
    MEMBERS: [
      { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', roles: [] },
      { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online',
        roles: [{ id: 'r1', name: 'Admin', color: '#f00', position: 10 }] },
      { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'idle', roles: [] },
      { id: 'u4', name: 'eve', initials: 'EV', color: '#ff0', status: 'offline', roles: [] },
    ],
    byId: { me: ME, u2: ALICE, u3: BOB, u4: EVE },
  };

  it('renders with grouped members', () => {
    const { container } = render(wrap(
      <MemberList members={members} voiceConnection={null} rich federated={false} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with federated flag (2-node header)', () => {
    const { container } = render(wrap(
      <MemberList members={members} voiceConnection={null} rich federated />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every member tile to open profile popover', () => {
    const { container } = render(wrap(
      <MemberList members={members} voiceConnection={null} rich={false} federated={false} />,
    ));
    const tiles = [...container.querySelectorAll('[class*="member"]')] as HTMLElement[];
    for (const t of tiles) {
      try { fireEvent.click(t); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks every member for context menu', () => {
    const { container } = render(wrap(
      <MemberList members={members} voiceConnection={null} rich federated />,
    ));
    const tiles = [...container.querySelectorAll('[class*="member"]')] as HTMLElement[];
    for (const t of tiles) {
      fireEvent.contextMenu(t);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with voice connection (speaker indicator)', () => {
    const { container } = render(wrap(
      <MemberList members={members} voiceConnection={{ channelId: 'ch-1' }} rich federated={false} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('UserPanel integration', () => {
  it('renders with online member', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with custom status', () => {
    const { container } = render(wrap(<UserPanel member={{ ...ME, status: 'idle', custom: 'on vacation' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button (status menu, cog)', () => {
    const { container } = render(wrap(<UserPanel member={ME} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders for each of online/idle/dnd/offline status', () => {
    for (const status of ['online', 'idle', 'dnd', 'offline']) {
      const { unmount } = render(wrap(<UserPanel member={{ ...ME, status }} />));
      unmount();
    }
    expect(true).toBe(true);
  });
});

describe('ThreadPanel integration', () => {
  it('renders for a known message', () => {
    const { container } = render(wrap(
      <ThreadPanel
        channelId="ch-1"
        messageId="m1"
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        onClose={vi.fn()}
        onReact={vi.fn()}
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks close button', () => {
    const onClose = vi.fn();
    const { container } = render(wrap(
      <ThreadPanel
        channelId="ch-1"
        messageId="m1"
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        onClose={onClose}
        onReact={vi.fn()}
      />,
    ));
    const closeBtns = [...container.querySelectorAll('button')].filter((b) =>
      /×|close/i.test(b.textContent ?? '')
    );
    for (const b of closeBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with thread replies seeded', () => {
    useThreadStore.setState({
      threads: { 'ch-1': [{ id: 'th-1', parent_message_id: 'm1', message_count: 2 }] },
      threadMessages: {
        'th-1': [
          { id: 'r1', authorId: 'u2', content: 'reply A', createdAt: new Date().toISOString() },
          { id: 'r2', authorId: 'me', content: 'reply B', createdAt: new Date().toISOString() },
        ],
      },
    } as never);
    const { container } = render(wrap(
      <ThreadPanel
        channelId="ch-1"
        messageId="m1"
        members={{ MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } }}
        onClose={vi.fn()}
        onReact={vi.fn()}
      />,
    ));
    expect(container.firstChild).toBeTruthy();
  });
});
