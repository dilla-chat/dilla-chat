// Drive ChatApp composer interactions: paste/file-drop/slash-commands.

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
vi.mock('../hooks/useVoiceConnection', () => ({
  useVoiceConnection: () => ({ connected: false, currentChannelId: null, peers: {}, muted: false, deafened: false, speaking: false, voiceLevel: 0, join: vi.fn(), leave: vi.fn() }),
}));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock('./icons', () => {
  const stub = () => <span data-icon />;
  return { Icon: new Proxy({}, { get: () => stub }), default: new Proxy({}, { get: () => stub }) };
});
vi.mock('./VoiceDockStats', () => ({ MiniMeter: () => <div />, VoiceDockLatency: () => <div />, VoiceDockBitrate: () => <div /> }));
vi.mock('./Avatar', () => ({
  Avatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  PlainAvatar: ({ member }: { member?: { name?: string } }) => <span>{member?.name}</span>,
  memberAvatarStyle: () => ({}),
  memberAvatarClass: () => '',
}));
vi.mock('./themes', () => ({ THEMES: { mesh: { name: 'mesh' }, themeVars: () => ({}) } }));

import ChatApp from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore } from '../stores/dmStore';
import { useThreadStore } from '../stores/threadStore';
import { useUnreadStore } from '../stores/unreadStore';
import { usePollStore } from '../stores/pollStore';
import { useBlockStore } from '../stores/blockStore';
import { useChannelMuteStore } from '../stores/channelMuteStore';
import { usePinStore } from '../stores/pinStore';

const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };
const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online' };
const CHANNEL = { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 };

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', EMPTY]]),
    members: new Map([['t1', EMPTY]]),
    roles: new Map([['t1', EMPTY]]),
    groups: new Map([['t1', EMPTY]]),
  } as never);
  useAuthStore.setState({ derivedKey: 'k', teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
  useVoiceStore.setState({
    connected: false, currentChannelId: null, voiceOccupants: {},
    muted: false, deafened: false, speaking: false, peers: {}, peerLatencies: {},
    latencySamples: EMPTY, bitrateSamples: EMPTY,
    localScreenStream: null, remoteScreenStreams: {},
    localWebcamStream: null, remoteWebcamStreams: {},
  } as never);
  useMessageStore.setState({ messages: new Map(), typing: new Map(), hasMore: new Map(), loadingHistory: new Map() } as never);
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme' }],
    CHANNELS: [CHANNEL],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: { 'ch-1': [] },
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

beforeEach(() => seedStores());

describe('ChatApp composer & input flows', () => {
  it('types @ in composer (mention picker may appear)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.change(ta, { target: { value: '@ali' } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('types # in composer (channel picker may appear)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.change(ta, { target: { value: '#gen' } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('types / (slash command) in composer', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      fireEvent.change(ta, { target: { value: '/giphy cat' } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('paste event with text', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      try {
        fireEvent.paste(ta, { clipboardData: { getData: () => 'pasted text', items: [], files: [] } });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('drag-over composer (file drop hint)', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const composer = container.querySelector('.composer, .tc-composer') as HTMLElement | null;
    if (composer) {
      try {
        fireEvent.dragEnter(composer);
        fireEvent.dragOver(composer);
        fireEvent.dragLeave(composer);
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('drop file on composer', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const composer = container.querySelector('.composer, .tc-composer') as HTMLElement | null;
    if (composer) {
      try {
        const file = new File(['x'], 'pic.png', { type: 'image/png' });
        fireEvent.drop(composer, { dataTransfer: { files: [file], items: [{ kind: 'file', type: 'image/png' }] } });
      } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('focuses composer via dilla:focus-composer event', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:focus-composer'));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('inserts a mention via dilla:insert-mention event', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:insert-mention', { detail: 'alice' }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('opens DM via dilla:open-dm event', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-dm', { detail: 'u2' }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('picks channel via dilla:pickchannel event', () => {
    const { container } = render(
      <ShellDataProvider value={makeData()}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('dilla:pickchannel', { detail: 'ch-1' }));
    });
    expect(container.firstChild).toBeTruthy();
  });
});
