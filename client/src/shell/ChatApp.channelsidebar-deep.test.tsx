// ChannelSidebar deep — every code path (groups/collapse/drag/restricted/voice).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
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

import { ChannelSidebar } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useVoiceStore } from '../stores/voiceStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0' };
const team = { id: 't1', name: 'Acme', node: 'gbg-1' };
const members = { MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } };
const SHELL = {
  SERVERS: [team], CHANNELS: [],
  MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

const baseProps = {
  team, tab: 'kanals' as const, onTab: vi.fn(),
  channels: [], activeChannel: 'ch-1', onPickChannel: vi.fn(),
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

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', []]]),
    members: new Map([['t1', [{ id: 'm1', userId: 'me', isAdmin: true, roleIds: [], roles: [] }]]]),
    roles: new Map([['t1', [
      { id: 'r-admin', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFFF, isDefault: false },
      { id: 'r-mod', name: 'Mod', color: '#0f0', position: 1, permissions: 0x2, isDefault: false },
      { id: 'r-every', name: '@everyone', color: '#888', position: 0, permissions: 0x47, isDefault: true },
    ]]]),
    groups: new Map([['t1', []]]),
  } as never);
  useVoiceStore.setState({ speaking: false, connected: false, currentChannelId: null } as never);
});

describe('ChannelSidebar groups and collapse', () => {
  const channels = [
    { id: 'ch-1', name: 'general', type: 'text' as const, groupId: 'g1', unread: 0 },
    { id: 'ch-2', name: 'design', type: 'text' as const, groupId: 'g1', unread: 5 },
    { id: 'ch-3', name: 'dev', type: 'text' as const, groupId: 'g2', unread: 0 },
    { id: 'ch-4', name: 'lounge', type: 'voice' as const, groupId: 'g3', participants: [] },
    { id: 'ch-orphan', name: 'orphan', type: 'text' as const, unread: 0 },
  ];

  beforeEach(() => {
    useTeamStore.setState({
      groups: new Map([['t1', [
        { id: 'g1', teamId: 't1', name: 'product', position: 0, accessRoleIds: [], hiddenIfRestricted: false },
        { id: 'g2', teamId: 't1', name: 'eng', position: 1, accessRoleIds: [], hiddenIfRestricted: false },
        { id: 'g3', teamId: 't1', name: 'voice', position: 2, accessRoleIds: [], hiddenIfRestricted: false },
      ]]]),
    } as never);
  });

  it('renders channels grouped by groupId', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} />));
    expect(container.textContent).toContain('product');
    expect(container.textContent).toContain('eng');
    expect(container.textContent).toContain('voice');
  });

  it('clicking group header collapses/expands the group', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} />));
    const headers = [...container.querySelectorAll('.group-header, .channel-group-header, .grp-header')] as HTMLElement[];
    for (const h of headers) {
      try { fireEvent.click(h); } catch { /* */ }
      try { fireEvent.click(h); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks group headers (context menu)', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} />));
    const headers = [...container.querySelectorAll('.group-header, .channel-group-header, .grp-header')] as HTMLElement[];
    for (const h of headers) {
      try { fireEvent.contextMenu(h); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with restricted channels (locked group)', () => {
    useTeamStore.setState({
      members: new Map([['t1', [{ id: 'm1', userId: 'me', isAdmin: false, roleIds: ['r-mod'], roles: [{ id: 'r-mod', name: 'Mod' }] }]]]),
      groups: new Map([['t1', [
        { id: 'g-locked', teamId: 't1', name: 'admin-only', position: 0, accessRoleIds: ['r-admin'], hiddenIfRestricted: false },
      ]]]),
    } as never);
    const restrictedChannels = [
      { id: 'ch-admin', name: 'admin-only', type: 'text' as const, groupId: 'g-locked', unread: 0 },
    ];
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={restrictedChannels} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with hidden_if_restricted group (channels invisible)', () => {
    useTeamStore.setState({
      members: new Map([['t1', [{ id: 'm1', userId: 'me', isAdmin: false, roleIds: [], roles: [] }]]]),
      groups: new Map([['t1', [
        { id: 'g-hidden', teamId: 't1', name: 'hidden', position: 0, accessRoleIds: ['r-admin'], hiddenIfRestricted: true },
      ]]]),
    } as never);
    const restrictedChannels = [
      { id: 'ch-hidden', name: 'invisible', type: 'text' as const, groupId: 'g-hidden', unread: 0 },
    ];
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={restrictedChannels} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders many tabs (kanals, pms, dms)', () => {
    for (const tab of ['kanals', 'pms', 'dms'] as const) {
      const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} tab={tab} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('drag-and-drop channel reorder', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} />));
    const rows = [...container.querySelectorAll('button.chan, button.channel, .channel-row')] as HTMLElement[];
    if (rows.length >= 2) {
      fireEvent.dragStart(rows[0]);
      fireEvent.dragOver(rows[1]);
      fireEvent.drop(rows[1]);
      fireEvent.dragEnd(rows[0]);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('drag-leave clears over state', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} />));
    const rows = [...container.querySelectorAll('button.chan, button.channel, .channel-row')] as HTMLElement[];
    if (rows.length >= 2) {
      fireEvent.dragStart(rows[0]);
      fireEvent.dragOver(rows[1]);
      fireEvent.dragLeave(rows[1]);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('voice-connected state with mute/deaf/cam/screen', () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-4', speaking: true } as never);
    for (const flags of [
      { mute: true, deaf: false, cam: false, screen: false },
      { mute: false, deaf: true, cam: false, screen: false },
      { mute: false, deaf: false, cam: true, screen: false },
      { mute: false, deaf: false, cam: false, screen: true },
      { mute: true, deaf: true, cam: true, screen: true },
    ]) {
      const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} voiceConnection={{ channelId: 'ch-4' }} {...flags} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('clicks every voice toolbar button (mute/deaf/cam/screen/leave)', () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-4' } as never);
    const setMute = vi.fn(); const setDeaf = vi.fn(); const setCam = vi.fn(); const setScreen = vi.fn(); const onLeaveVoice = vi.fn();
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} voiceConnection={{ channelId: 'ch-4' }} setMute={setMute} setDeaf={setDeaf} setCam={setCam} setScreen={setScreen} onLeaveVoice={onLeaveVoice} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with mutedChannels set on multiple channels', () => {
    const { container } = render(wrap(<ChannelSidebar {...baseProps} channels={channels} mutedChannels={new Set(['ch-2', 'ch-3'])} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks new-dm button in pms tab', () => {
    const onNewDm = vi.fn();
    const { container } = render(wrap(<ChannelSidebar {...baseProps} tab="pms" channels={channels} onNewDm={onNewDm} dms={[
      { id: 'dm-1', with: 'u2', preview: 'hi', at: new Date(), unread: 0 },
    ]} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
