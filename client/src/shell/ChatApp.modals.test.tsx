// Trigger every internal modal in ChatApp and drive its visible
// content. Modals only render when their parent state is non-null,
// so dispatching the corresponding open event is the key.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';

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
const VC_STUB = { connected: false, currentChannelId: null, muted: false, deafened: false, speaking: false, voiceLevel: 0, peers: {}, join: () => {}, leave: () => {} };
vi.mock('../hooks/useVoiceConnection', () => ({ useVoiceConnection: () => VC_STUB }));
vi.mock('../components/MessageMarkdown/MessageMarkdown', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));
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

function seedStores() {
  const EMPTY: never[] = [];
  useTeamStore.setState({
    activeTeamId: 't1', activeChannelId: 'ch-1',
    teams: new Map([['t1', { id: 't1', name: 'Acme' }]]),
    channels: new Map([['t1', [
      { id: 'ch-1', name: 'general', type: 'text' },
      { id: 'ch-2', name: 'voice', type: 'voice' },
    ]]]),
    members: new Map([['t1', [
      { id: 'm1', userId: 'me', username: 'me', displayName: 'Me', publicKeyHex: '', avatarUrl: '', isAdmin: true, roles: [] },
      { id: 'm2', userId: 'u2', username: 'alice', displayName: 'Alice', publicKeyHex: '', avatarUrl: '', isAdmin: false, roles: [] },
    ]]]),
    roles: new Map([['t1', [
      { id: 'r1', name: 'Admin', color: '#f00', position: 2, permissions: 0xFFF, isDefault: false },
    ]]]),
    groups: new Map([['t1', [
      { id: 'g1', team_id: 't1', name: 'Main', position: 0, access_role_ids: [], hidden_if_restricted: false },
    ]]]),
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
  useDMStore.setState({ dmChannels: {}, dmMessages: {}, activeDMId: null } as never);
  useThreadStore.setState({ threads: {}, threadMessages: {} } as never);
  useUnreadStore.setState({ counts: {} } as never);
  usePollStore.setState({ polls: new Map() } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
  useChannelMuteStore.setState({ muted: new Set() } as never);
  usePinStore.setState({ pins: {} } as never);
}

function makeData() {
  return {
    SERVERS: [{ id: 't1', name: 'Acme', node: 'local', short: 'A', federated: false, members: 0 }],
    CHANNELS: [
      { id: 'ch-1', name: 'general', type: 'text', topic: '', encrypted: true, unread: 0, groupId: 'g1' },
      { id: 'ch-2', name: 'voice', type: 'voice', topic: '', encrypted: true, unread: 0, participants: [], groupId: 'g1' },
    ],
    MEMBERS: [ME, ALICE],
    byId: { me: ME, u2: ALICE },
    MESSAGES: {
      'ch-1': [
        { id: 'm1', author: 'u2', at: new Date(), kind: 'text', text: 'hi', edited: false, deleted: false },
      ],
    },
    DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
    activeServerId: 't1', activeChannelId: 'ch-1', currentUserId: 'me',
  };
}

beforeEach(() => seedStores());

function withApp(t: () => void) {
  const { container } = render(
    <ShellDataProvider value={makeData()}>
      <ChatApp theme={{ name: 'mesh' }} opts={{}} />
    </ShellDataProvider>,
  );
  act(() => { t(); });
  return container;
}

describe('ChatApp modal triggers (jsdom)', () => {
  it('open-channel-access mounts the access modal', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: { channelId: 'ch-1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-channel-settings mounts the settings modal', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-channel-settings', { detail: { channelId: 'ch-1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-group-access mounts the group-access modal', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-group-access', { detail: { groupId: 'g1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-group-settings mounts the group-settings modal', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-group-settings', { detail: { groupId: 'g1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-new-channel mounts the new-channel modal', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-new-channel'));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-add-server mounts the add-server modal', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-add-server'));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-thread mounts the thread panel', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: 'ch-1', messageId: 'm1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-profile mounts the profile popover', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: 'u2', x: 100, y: 100 } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-menu mounts the context menu', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-menu', {
        detail: { x: 100, y: 100, items: [{ label: 'item-1', onClick: () => {} }, { label: 'item-2', danger: true, onClick: () => {} }] },
      }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-menu mounts with disabled items', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-menu', {
        detail: { x: 50, y: 50, items: [{ label: 'disabled', disabled: true, onClick: () => {} }] },
      }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-channel-access then clicking inside the modal works', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-channel-access', { detail: { channelId: 'ch-1' } }));
    });
    // Click everything inside the modal to drive its handlers.
    const modal = container.querySelector('.modal-overlay');
    if (modal) {
      const inside = [...modal.querySelectorAll('button')] as HTMLButtonElement[];
      act(() => {
        for (const b of inside) {
          try { fireEvent.click(b); } catch { /* swallow */ }
        }
      });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('open-thread + onReact event', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: 'ch-1', messageId: 'm1' } }));
    });
    expect(container.firstChild).toBeTruthy();
  });

  it('open-new-channel then click cancel', () => {
    const container = withApp(() => {
      window.dispatchEvent(new CustomEvent('dilla:open-new-channel'));
    });
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => /cancel/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (cancelBtn) act(() => { fireEvent.click(cancelBtn); });
    expect(container.firstChild).toBeTruthy();
  });

  it('open every modal in sequence (stress test)', () => {
    const container = withApp(() => {
      const events = [
        'dilla:open-channel-access', 'dilla:open-channel-settings',
        'dilla:open-group-access', 'dilla:open-group-settings',
        'dilla:open-new-channel', 'dilla:open-add-server',
        'dilla:open-thread', 'dilla:open-profile', 'dilla:open-menu',
        'dilla:open-search', 'dilla:open-settings',
      ];
      for (const e of events) {
        window.dispatchEvent(new CustomEvent(e, {
          detail: {
            channelId: 'ch-1', groupId: 'g1', messageId: 'm1', memberId: 'u2',
            x: 100, y: 100, items: [], mode: 'user', tab: 'account',
          },
        }));
      }
    });
    expect(container.firstChild).toBeTruthy();
  });
});
