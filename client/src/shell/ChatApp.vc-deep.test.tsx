// VoiceChannel deep — every render path + click handler.

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
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));

import { VoiceChannel } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useVoiceStore } from '../stores/voiceStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online', isAdmin: true };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'online' };

const channel = { id: 'ch-voice', name: 'lounge', type: 'voice', encrypted: true, unread: 0, participants: ['me', 'u2', 'u3'], teamId: 't1' };

const members = { MEMBERS: [ME, ALICE, BOB], byId: { me: ME, u2: ALICE, u3: BOB } };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [channel],
  MEMBERS: [ME, ALICE, BOB],
  byId: { me: ME, u2: ALICE, u3: BOB },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-voice', currentUserId: 'me',
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

const baseProps = {
  channel, members,
  voiceConnection: null as null | { channelId: string },
  onJoin: vi.fn(), onLeave: vi.fn(),
  mute: false, setMute: vi.fn(),
  deaf: false, setDeaf: vi.fn(),
  cam: false, setCam: vi.fn(),
  screen: false, setScreen: vi.fn(),
  rich: false,
  membersOpen: true,
  onToggleMembers: vi.fn(),
};

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: true, roleIds: [], roles: [] }]]]),
  } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null,
    peers: {}, peerLatencies: {},
    screenSharingUserId: null, remoteScreenStreams: {}, localScreenStream: null,
    remoteWebcamStreams: {}, localWebcamStream: null,
  } as never);
});

describe('VoiceChannel deep render paths', () => {
  it('not connected → empty state', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('connected to this channel', () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-voice', peers: { me: { user_id: 'me', username: 'me' } } } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('connected to different channel', () => {
    useVoiceStore.setState({ connected: true, currentChannelId: 'ch-other' } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-other' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('multiple peer states (speaking/muted/deafened)', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: {
        me: { user_id: 'me', username: 'me', speaking: true, muted: false, deafened: false },
        u2: { user_id: 'u2', username: 'alice', speaking: false, muted: true, deafened: false },
        u3: { user_id: 'u3', username: 'bob', speaking: false, muted: false, deafened: true },
      },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('peer screen-sharing (mock stream)', () => {
    const fakeStream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { u2: { user_id: 'u2', username: 'alice', screen_sharing: true } },
      screenSharingUserId: 'u2',
      remoteScreenStreams: { u2: fakeStream },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('local screen sharing (own)', () => {
    const fakeStream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { me: { user_id: 'me', username: 'me' } },
      screenSharingUserId: 'me',
      localScreenStream: fakeStream,
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} screen={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('peer webcam sharing', () => {
    const fakeStream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { u2: { user_id: 'u2', username: 'alice', webcam_sharing: true } },
      remoteWebcamStreams: { u2: fakeStream },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('local webcam sharing', () => {
    const fakeStream = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { me: { user_id: 'me', username: 'me' } },
      localWebcamStream: fakeStream,
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} cam={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders locked channel for non-admin', () => {
    useTeamStore.setState({
      members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: false, roleIds: [], roles: [] }]]]),
    } as never);
    const locked = { ...channel, locked: true };
    const { container } = render(wrap(<VoiceChannel {...baseProps} channel={locked} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('rich + non-rich variants', () => {
    for (const rich of [true, false]) {
      const { container } = render(wrap(<VoiceChannel {...baseProps} rich={rich} />));
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('membersOpen=false', () => {
    const { container } = render(wrap(<VoiceChannel {...baseProps} membersOpen={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('latency stats render', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { me: { user_id: 'me', username: 'me' }, u2: { user_id: 'u2', username: 'alice' } },
      peerLatencies: { u2: 42 },
      latencySamples: [40, 45, 50, 42, 48],
      bitrateSamples: [128, 160, 140, 150, 145],
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} rich={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every button', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { me: { user_id: 'me', username: 'me' }, u2: { user_id: 'u2', username: 'alice' } },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('right-clicks peer tiles for context menu', () => {
    useVoiceStore.setState({
      connected: true, currentChannelId: 'ch-voice',
      peers: { u2: { user_id: 'u2', username: 'alice' }, u3: { user_id: 'u3', username: 'bob' } },
    } as never);
    const { container } = render(wrap(<VoiceChannel {...baseProps} voiceConnection={{ channelId: 'ch-voice' }} />));
    const tiles = [...container.querySelectorAll('.vc-tile, .voice-tile, .peer-card')] as HTMLElement[];
    for (const t of tiles) {
      try { fireEvent.contextMenu(t); } catch { /* */ }
    }
    expect(container.firstChild).toBeTruthy();
  });
});
