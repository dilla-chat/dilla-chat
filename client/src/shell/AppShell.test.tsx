import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import AppShell from './AppShell';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { useMeshStore } from '../stores/meshStore';
import { useVoiceStore } from '../stores/voiceStore';

vi.mock('./ChatApp', () => ({ default: () => <div data-testid="chat-app" /> }));
vi.mock('./Settings', () => ({ default: () => <div data-testid="settings" /> }));
vi.mock('./Chrome', () => ({
  TopBar: ({ teamName, nodeName, federated, onCmdK, onSearch, onHelp }: {
    teamName: string; nodeName: string; federated: boolean;
    onCmdK: () => void; onSearch: () => void; onHelp: () => void;
  }) => (
    <div data-testid="top-bar">
      <span data-testid="team">{teamName}</span>
      <span data-testid="node">{nodeName}</span>
      <span data-testid="federated">{String(federated)}</span>
      <button data-testid="cmdk-btn" onClick={onCmdK}>cmd</button>
      <button data-testid="search-btn" onClick={onSearch}>srch</button>
      <button data-testid="help-btn" onClick={onHelp}>help</button>
    </div>
  ),
  BottomBar: () => <div data-testid="bot-bar" />,
  CommandPalette: ({ open, commands, onClose, onPickChannel }: {
    open: boolean; commands: Array<{ cmd: string }>; onClose: () => void; onPickChannel: (id: string) => void;
  }) =>
    open ? (
      <div data-testid="cmd-palette" data-count={commands.length}>
        <button data-testid="cmd-close" onClick={onClose}>x</button>
        <button data-testid="cmd-pick" onClick={() => onPickChannel('c-test')}>pick</button>
      </div>
    ) : null,
  SearchPalette: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="search-palette" onClick={onClose} /> : null,
}));
vi.mock('../components/ConfirmDialog/ConfirmDialog', () => ({ default: () => <div data-testid="confirm" /> }));
vi.mock('./Extras', () => ({
  NotificationStack: () => <div data-testid="notify" />,
  IncomingCall: ({ onAccept }: { onAccept: () => void }) => (
    <div data-testid="incoming-call" onClick={onAccept} />
  ),
  SafetyCompare: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="safety" onClick={onClose} />
  ),
  AddPeerWizard: ({ open }: { open: boolean }) => open ? <div data-testid="add-peer" /> : null,
  ConnectionBanner: () => <div data-testid="banner" />,
}));

vi.mock('../hooks/useVoiceConnection', () => ({
  useVoiceConnection: () => ({ connected: false, currentChannelId: null, muted: false, deafened: false }),
}));

vi.mock('./useShellData', () => ({
  useShellData: () => ({ SERVERS: [], CHANNELS: [], MEMBERS: [], byId: {} }),
}));

vi.mock('./themes', () => ({
  THEMES: {
    mesh: {},
    themeVars: () => ({}),
  },
}));

function seedTeam(name: string, baseUrl?: string, channels: Array<{ id: string; name: string; type: string }> = []) {
  useTeamStore.setState({
    activeTeamId: 't1',
    teams: new Map([['t1', { id: 't1', name }]]),
    channels: new Map([['t1', channels]]),
    members: new Map([['t1', []]]),
  } as never);
  useAuthStore.setState({
    teams: new Map(baseUrl ? [['t1', { baseUrl }]] : []),
  } as never);
}

describe('AppShell', () => {
  beforeEach(() => {
    useTeamStore.setState({ activeTeamId: null, teams: new Map(), channels: new Map(), members: new Map() } as never);
    useAuthStore.setState({ teams: new Map() } as never);
    useMeshStore.setState({ peersTotal: 0, status: 'ok' } as never);
    useVoiceStore.setState({ connected: false } as never);
  });

  it('renders TopBar + BottomBar + extras when ready=false (ChatApp not yet mounted)', () => {
    seedTeam('Acme');
    const { getByTestId, queryByTestId } = render(<AppShell ready={false} />);
    expect(getByTestId('top-bar')).toBeTruthy();
    expect(getByTestId('bot-bar')).toBeTruthy();
    expect(queryByTestId('chat-app')).toBeNull();
  });

  it('mounts ChatApp when ready=true', () => {
    seedTeam('Acme');
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('chat-app')).toBeTruthy();
  });

  it('passes uppercased team name to TopBar', () => {
    seedTeam('acme');
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('team').textContent).toBe('ACME');
  });

  it('defaults team name to DILLA when no active team', () => {
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('team').textContent).toBe('DILLA');
  });

  it('derives node name from authStore baseUrl (short = host first segment)', () => {
    seedTeam('Acme', 'https://acme.example.com');
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('node').textContent).toBe('acme');
  });

  it('node falls back to "local" when no baseUrl', () => {
    seedTeam('Acme');
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('node').textContent).toBe('local');
  });

  it('node falls back to "local" when baseUrl is malformed (L141 catch)', () => {
    // A bare string that isn't a valid URL throws inside `new URL(base)`.
    seedTeam('Acme', 'not a valid url');
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('node').textContent).toBe('local');
  });

  it('federated flag flips to true when meshStore has peers', () => {
    seedTeam('A');
    useMeshStore.setState({ peersTotal: 3 } as never);
    const { getByTestId } = render(<AppShell ready />);
    expect(getByTestId('federated').textContent).toBe('true');
  });

  it('Cmd/Ctrl+K toggles the command palette', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    expect(queryByTestId('cmd-palette')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(queryByTestId('cmd-palette')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(queryByTestId('cmd-palette')).toBeNull();
  });

  it('/ opens the search palette when no input is focused', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    fireEvent.keyDown(window, { key: '/' });
    expect(queryByTestId('search-palette')).toBeTruthy();
  });

  it('/ inside an input is ignored', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: '/' });
    expect(queryByTestId('search-palette')).toBeNull();
  });

  it('Escape closes any open palette', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(queryByTestId('cmd-palette')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(queryByTestId('cmd-palette')).toBeNull();
  });

  it('the dilla:open-search custom event opens the search palette', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    fireEvent(window, new CustomEvent('dilla:open-search', { detail: 'channels' }));
    expect(queryByTestId('search-palette')).toBeTruthy();
  });

  it('CommandPalette receives dynamic commands from team channels', () => {
    seedTeam('A', undefined, [
      { id: 'c1', name: 'general', type: 'text' },
      { id: 'c2', name: 'random', type: 'text' },
    ]);
    const { getByTestId } = render(<AppShell ready />);
    fireEvent.click(getByTestId('cmdk-btn'));
    const palette = getByTestId('cmd-palette');
    // 2 channel entries + 7 fixed (voice ×3, encryption ×2, account ×2)
    expect(palette.getAttribute('data-count')).toBe('9');
  });

  it('the dilla:incoming-call event mounts the IncomingCall overlay', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    fireEvent(window, new CustomEvent('dilla:incoming-call', { detail: { from: 'ada', kind: 'voice' } }));
    expect(queryByTestId('incoming-call')).toBeTruthy();
  });

  it('the dilla:add-peer event opens the AddPeerWizard', () => {
    seedTeam('A');
    const { queryByTestId } = render(<AppShell ready />);
    fireEvent(window, new CustomEvent('dilla:add-peer'));
    expect(queryByTestId('add-peer')).toBeTruthy();
  });

  it('clicking the search button opens the search palette (covers L198)', () => {
    seedTeam('A');
    const { getByTestId, queryByTestId } = render(<AppShell ready />);
    fireEvent.click(getByTestId('search-btn'));
    expect(queryByTestId('search-palette')).toBeTruthy();
  });

  it('CommandPalette onClose closes the palette (covers L211)', () => {
    seedTeam('A');
    const { getByTestId, queryByTestId } = render(<AppShell ready />);
    fireEvent.click(getByTestId('cmdk-btn'));
    expect(queryByTestId('cmd-palette')).toBeTruthy();
    fireEvent.click(getByTestId('cmd-close'));
    expect(queryByTestId('cmd-palette')).toBeNull();
  });

  it('CommandPalette onPickChannel forwards to controllerRef (covers L212)', () => {
    // Just confirm the inline arrow doesn't throw when there's no
    // pickChannel impl on the controllerRef.
    seedTeam('A', undefined, [{ id: 'c1', name: 'general', type: 'text' }]);
    const { getByTestId } = render(<AppShell ready />);
    fireEvent.click(getByTestId('cmdk-btn'));
    fireEvent.click(getByTestId('cmd-pick'));
  });

  it('SearchPalette onClose closes the palette (covers L217)', () => {
    seedTeam('A');
    const { getByTestId, queryByTestId } = render(<AppShell ready />);
    fireEvent(window, new CustomEvent('dilla:open-search', { detail: 'channels' }));
    expect(queryByTestId('search-palette')).toBeTruthy();
    fireEvent.click(getByTestId('search-palette'));
    expect(queryByTestId('search-palette')).toBeNull();
  });

  it('IncomingCall onAccept clears the call overlay (covers L226-227)', () => {
    seedTeam('A');
    const { queryByTestId, getByTestId } = render(<AppShell ready />);
    fireEvent(window, new CustomEvent('dilla:incoming-call', { detail: { from: 'ada', kind: 'voice' } }));
    expect(queryByTestId('incoming-call')).toBeTruthy();
    fireEvent.click(getByTestId('incoming-call'));
    expect(queryByTestId('incoming-call')).toBeNull();
  });

  it('SafetyCompare onClose closes the compare modal (covers L231)', () => {
    seedTeam('A');
    const { queryByTestId, getByTestId } = render(<AppShell ready />);
    fireEvent(window, new CustomEvent('dilla:verify-safety', { detail: 'peer-1' }));
    expect(queryByTestId('safety')).toBeTruthy();
    fireEvent.click(getByTestId('safety'));
    expect(queryByTestId('safety')).toBeNull();
  });

  it('writes shellData onto window.SHELL_DATA for legacy readers', () => {
    seedTeam('A');
    render(<AppShell ready />);
    expect((window as unknown as { SHELL_DATA?: Record<string, unknown> }).SHELL_DATA).toBeDefined();
  });
});
