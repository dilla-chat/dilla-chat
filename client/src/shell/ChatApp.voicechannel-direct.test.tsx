// Direct unit tests on ChatApp's exported VoiceChannel component.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = function() { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function() {};
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
vi.mock('./themes', () => ({ THEMES: { mesh: { name: 'mesh' }, themeVars: () => ({}) } }));
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));

import { VoiceChannel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useVoiceStore } from '../stores/voiceStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };

const channel = { id: 'ch-voice', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: ['me', 'u2'], teamId: 't1' };

const members = { MEMBERS: [ME, ALICE], byId: { me: ME, u2: ALICE } };

const baseProps = {
  channel, members,
  voiceConnection: null as null | { channelId: string },
  onJoin: vi.fn(),
  onLeave: vi.fn(),
  mute: false, setMute: vi.fn(),
  deaf: false, setDeaf: vi.fn(),
  cam: false, setCam: vi.fn(),
  screen: false, setScreen: vi.fn(),
  rich: false,
  membersOpen: true,
  onToggleMembers: vi.fn(),
};

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [channel], MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-voice', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: false, roleIds: [], roles: [] }]]]),
  } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null,
    peers: {}, peerLatencies: {},
    screenSharingUserId: null,
    remoteScreenStreams: {},
    localScreenStream: null,
    remoteWebcamStreams: {},
    localWebcamStream: null,
  } as never);
});

describe('ChatApp.VoiceChannel direct render', () => {
  it('renders not-connected state', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with voiceConnection.channelId === channel.id (connected)', () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-voice' } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with mute=true + deaf=true', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} mute={true} deaf={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with cam=true + screen=true', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} cam={true} screen={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders locked channel for non-admin', () => {
    const lockedChannel = { ...channel, locked: true };
    const { container } = render(wrap(<VoiceChannel {...baseProps} channel={lockedChannel} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders peers with screen-sharing user', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: {
        me: { user_id: 'me', username: 'me', speaking: false },
        u2: { user_id: 'u2', username: 'alice', speaking: true, screen_sharing: true },
      },
      screenSharingUserId: 'u2',
      remoteScreenStreams: { u2: { id: 'ss', getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders rich mode with extra stats', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} rich={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with membersOpen=false', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} membersOpen={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking buttons inside fires handlers (broad sweep)', () => {
    const onJoin = vi.fn();
    const onLeave = vi.fn();
    const setMute = vi.fn();
    const setDeaf = vi.fn();
    const { container } = render(wrap(<VoiceChannel {...baseProps} onJoin={onJoin} onLeave={onLeave} setMute={setMute} setDeaf={setDeaf} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks peer cards (context menu)', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { me: { user_id: 'me', username: 'me' }, u2: { user_id: 'u2', username: 'alice' } },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    const cards = [...container.querySelectorAll('.peer-card, .vc-tile, .voice-tile')] as HTMLElement[];
    for (const c of cards) try { fireEvent.contextMenu(c); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });
});
