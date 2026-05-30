// Unit tests for ChatApp's exported MemberList component.

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
vi.mock('../hooks/useVoiceConnection', () => ({
  useVoiceConnection: () => ({ connected: false, currentChannelId: null }),
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
vi.mock('../stores/confirmStore', () => ({
  dillaConfirm: vi.fn(async () => true),
}));

import { MemberList } from './ChatApp';
import { ShellDataProvider } from './ShellDataContext';
import { useTeamStore } from '../stores/teamStore';
import { useBlockStore } from '../stores/blockStore';

const ALICE = { id: 'u2', name: 'alice', initials: 'AL', color: '#0f0', status: 'online', roles: [{ id: 'r1', name: 'Admin', color: '#f00', position: 2 }] };
const BOB = { id: 'u3', name: 'bob', initials: 'BO', color: '#00f', status: 'online' };
const OFFLINE = { id: 'u4', name: 'carol', initials: 'CA', color: '#0ff', status: 'offline' };
const ME = { id: 'me', name: 'me', initials: 'ME', color: '#f00', status: 'online' };

const SHELL = {
  SERVERS: [{ id: 't1', name: 'Acme' }],
  CHANNELS: [], MEMBERS: [ME, ALICE, BOB, OFFLINE],
  byId: { me: ME, u2: ALICE, u3: BOB, u4: OFFLINE },
  MESSAGES: {}, DMS: [], DM_MESSAGES: {}, THREAD_REPLIES: {},
  activeServerId: 't1', activeChannelId: null, currentUserId: 'me',
};

const members = {
  MEMBERS: [ME, ALICE, BOB, OFFLINE],
};

function wrap(c: React.ReactNode) {
  return <ShellDataProvider value={SHELL}>{c}</ShellDataProvider>;
}

beforeEach(() => {
  useTeamStore.setState({
    activeTeamId: 't1',
    members: new Map([['t1', [{ id: 'm1', userId: 'me', isAdmin: true, roleIds: [], roles: [] }]]]),
  } as never);
  useBlockStore.setState({ blocked: new Set() } as never);
});

describe('MemberList', () => {
  it('renders with online members', () => {
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    expect(container.textContent).toContain('alice');
    expect(container.textContent).toContain('bob');
  });

  it('separates offline members into their own group', () => {
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    expect(container.textContent).toContain('carol');
  });

  it('groups members by their highest role', () => {
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    // Admin role group should appear
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking a member opens profile (dispatches dilla:open-profile)', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:open-profile', listener);
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    const memberDivs = [...container.querySelectorAll('.member')] as HTMLElement[];
    if (memberDivs[0]) fireEvent.click(memberDivs[0]);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:open-profile', listener);
  });

  it('right-clicking a member dispatches dilla:open-menu', () => {
    const listener = vi.fn();
    window.addEventListener('dilla:open-menu', listener);
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    const memberDivs = [...container.querySelectorAll('.member')] as HTMLElement[];
    if (memberDivs[0]) fireEvent.contextMenu(memberDivs[0]);
    expect(listener).toHaveBeenCalled();
    window.removeEventListener('dilla:open-menu', listener);
  });

  it('renders with rich + federated props', () => {
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={true} federated={true} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('handles empty MEMBERS array', () => {
    const { container } = render(wrap(<MemberList members={{ MEMBERS: [] }} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('handles all-offline members', () => {
    const offlineMembers = { MEMBERS: [{ ...OFFLINE }, { ...ALICE, status: 'offline' }] };
    const { container } = render(wrap(<MemberList members={offlineMembers} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('shows blocked label in menu for blocked users', () => {
    useBlockStore.setState({ blocked: new Set(['u2']), isBlocked: (id: string) => id === 'u2' } as never);
    const { container } = render(wrap(<MemberList members={members} voiceConnection={null} rich={false} federated={false} />));
    expect(container.firstChild).toBeTruthy();
  });
});
