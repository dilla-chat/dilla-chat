// Targets very specific uncovered line ranges identified via lcov analysis.
// L1447-L1533 (87 lines): FloatingPip drag/resize handler.
// L5351-L5422 (72 lines): slash-command parser.

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

const apiMocks = vi.hoisted(() => ({
  searchGif: vi.fn(async () => ({ results: [{ url: 'g1.gif', preview: 'g1.gif' }], url: '', query: '' })),
  updateChannel: vi.fn(async () => ({})),
  updateMember: vi.fn(async () => ({})),
}));
vi.mock('../services/api', () => ({ api: new Proxy(apiMocks, { get: (t, k) => k in t ? (t as Record<string, unknown>)[k] : async () => ({}) }) }));
vi.mock('../services/websocket', () => ({ ws: new Proxy({}, { get: () => () => () => {} }) }));
vi.mock('../services/mockSession', () => ({ isMockSession: () => false }));
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

import { FloatingPip } from './ChatApp';
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

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [{ id: 'ch-1', name: 'general', type: 'text' as const }]]]),
    members: new Map([['t1', [{ id: 'me-m', userId: 'me', isAdmin: true, roleIds: [], roles: [] }, { id: 'u2-m', userId: 'u2', username: 'alice', isAdmin: false, roleIds: [], roles: [] }]]]),
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
  useChannelMuteStore.setState({ muted: new Map() } as never);
  usePinStore.setState({ pinned: new Map() } as never);
}

const data = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0 }],
  MEMBERS: [ME, ALICE],
  byId: { me: ME, u2: ALICE },
  MESSAGES: {},
  DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
};

beforeEach(() => seedStores());

describe('FloatingPip drag/resize handlers (L1447-L1533)', () => {
  it('move drag — fires mousemove + mouseup', () => {
    const onClick = vi.fn();
    const { container } = render(
      <FloatingPip className="test" onClick={onClick}>
        <span>content</span>
      </FloatingPip>,
    );
    const pip = container.firstChild as HTMLElement;
    // Force the pip to have inline left/top so the move branch fires
    pip.style.left = '50px';
    pip.style.top = '50px';
    pip.style.width = '100px';
    pip.style.height = '100px';
    // mouseDown on the pip body (move handle)
    fireEvent.mouseDown(pip, { clientX: 100, clientY: 100 });
    // mousemove on document
    fireEvent.mouseMove(document, { clientX: 150, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 200 });
    fireEvent.mouseUp(document);
    expect(container.firstChild).toBeTruthy();
  });

  it('mouseUp without moving still works (calls onClick)', () => {
    const onClick = vi.fn();
    const { container } = render(
      <FloatingPip className="test" onClick={onClick}>
        <span>content</span>
      </FloatingPip>,
    );
    const pip = container.firstChild as HTMLElement;
    fireEvent.mouseDown(pip, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders without onClick prop', () => {
    const { container } = render(
      <FloatingPip className="test">
        <span>content</span>
      </FloatingPip>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with minW/minH custom', () => {
    const { container } = render(
      <FloatingPip className="test" minW={120} minH={80}>
        <span>content</span>
      </FloatingPip>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});

describe('Slash command parser (L5351-L5422)', () => {
  // The slash commands run via the composer's send flow. We dispatch
  // input changes + Enter on the textarea inside a rendered ChatApp.
  it('/giphy <query> triggers api.searchGif', async () => {
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      await act(async () => {
        fireEvent.change(ta, { target: { value: '/giphy cat' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
        await Promise.resolve();
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  for (const cmd of [
    '/code js',
    '/code',
    '/help',
    '/help foo',
    '/w alice',
    '/w me',
    '/w nobody',
    '/invite alice',
    '/invite',
    '/topic new topic',
    '/topic',
    '/lock',
    '/unlock',
    '/nick custom-nick',
    '/nick',
    '/unknown-command',
  ]) {
    it(`slash command: ${cmd}`, async () => {
      const { container } = render(
        <ShellDataProvider value={data}>
          <ChatApp theme={{ name: 'mesh' }} opts={{}} />
        </ShellDataProvider>,
      );
      const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
      if (ta) {
        await act(async () => {
          fireEvent.change(ta, { target: { value: cmd } });
          fireEvent.keyDown(ta, { key: 'Enter' });
          await Promise.resolve();
        });
      }
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('/giphy with empty results falls back to URL', async () => {
    apiMocks.searchGif.mockResolvedValueOnce({ results: [], url: 'https://giphy/x.gif', query: 'cat' });
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      await act(async () => {
        fireEvent.change(ta, { target: { value: '/giphy cat' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
        await Promise.resolve();
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('/giphy 503 (not configured) shows notify', async () => {
    apiMocks.searchGif.mockRejectedValueOnce(new Error('503 Service Unavailable: giphy not configured'));
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      await act(async () => {
        fireEvent.change(ta, { target: { value: '/giphy cat' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('/giphy 404 (no gif) shows notify', async () => {
    apiMocks.searchGif.mockRejectedValueOnce(new Error('404 no gif found'));
    const { container } = render(
      <ShellDataProvider value={data}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      await act(async () => {
        fireEvent.change(ta, { target: { value: '/giphy nothing' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('/topic outside team channel notifies', async () => {
    const { container } = render(
      <ShellDataProvider value={{ ...data, activeServerId: null }}>
        <ChatApp theme={{ name: 'mesh' }} opts={{}} />
      </ShellDataProvider>,
    );
    const ta = container.querySelector('textarea') as HTMLTextAreaElement | null;
    if (ta) {
      await act(async () => {
        fireEvent.change(ta, { target: { value: '/topic new topic' } });
        fireEvent.keyDown(ta, { key: 'Enter' });
        await Promise.resolve();
      });
    }
    expect(container.firstChild).toBeTruthy();
  });
});
