import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TopBar, BottomBar, CommandPalette, SearchPalette } from './Chrome';
import { ShellDataProvider } from './ShellDataContext';
import { useAuthStore } from '../stores/authStore';
import { useVoiceStore } from '../stores/voiceStore';

vi.mock('../hooks/useServerConfig', () => ({
  useServerConfig: () => ({ db_encrypted: true, tls_enabled: true, has_custom_theme: false, domain: 'd', rp_id: 'r' }),
}));

vi.mock('../services/crypto', () => ({
  isCryptoInitialized: () => true,
}));

vi.mock('../utils/randomId', () => ({
  randomInt: () => 0,
  shortId: (p: string) => `${p}-x`,
}));

function withShell(children: React.ReactElement, data: Record<string, unknown> = { SERVERS: [], CHANNELS: [], MEMBERS: [], byId: {} }) {
  return <ShellDataProvider data={data}>{children}</ShellDataProvider>;
}

describe('Chrome / TopBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders team + node + ⌘K/search/help buttons', () => {
    const onCmdK = vi.fn();
    const onSearch = vi.fn();
    const onHelp = vi.fn();
    const { getByText } = render(
      <TopBar
        onCmdK={onCmdK}
        onSearch={onSearch}
        onHelp={onHelp}
        teamName="Acme"
        nodeName="acme.example"
      />,
    );
    expect(getByText('Acme')).toBeTruthy();
    expect(getByText('acme.example')).toBeTruthy();
    expect(getByText('CMD')).toBeTruthy();
    expect(getByText('SEARCH')).toBeTruthy();
    expect(getByText('HELP')).toBeTruthy();
  });

  it('shows MESH OK badge when federated', () => {
    const { getByText } = render(<TopBar onCmdK={vi.fn()} onSearch={vi.fn()} onHelp={vi.fn()} federated />);
    expect(getByText('● MESH OK')).toBeTruthy();
  });

  it('shows READY badge when not federated', () => {
    const { getByText } = render(<TopBar onCmdK={vi.fn()} onSearch={vi.fn()} onHelp={vi.fn()} federated={false} />);
    expect(getByText('● READY')).toBeTruthy();
  });

  it('CMD/SEARCH/HELP buttons invoke the corresponding callbacks', () => {
    const onCmdK = vi.fn();
    const onSearch = vi.fn();
    const onHelp = vi.fn();
    const { getByText } = render(<TopBar onCmdK={onCmdK} onSearch={onSearch} onHelp={onHelp} />);
    fireEvent.click(getByText('CMD').closest('button')!);
    fireEvent.click(getByText('SEARCH').closest('button')!);
    fireEvent.click(getByText('HELP').closest('button')!);
    expect(onCmdK).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onHelp).toHaveBeenCalledTimes(1);
  });
});

describe('Chrome / BottomBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAuthStore.setState({ derivedKey: 'key' } as never);
    useVoiceStore.setState({ connected: false } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders SQLCIPHER + AES badge when db is encrypted', () => {
    const { container } = render(<BottomBar />);
    expect(container.textContent).toContain('SQLCIPHER');
  });

  it('renders SIGNAL · X3DH · AES-256-GCM when derivedKey is set + crypto initialized', () => {
    const { container } = render(<BottomBar />);
    expect(container.textContent).toContain('SIGNAL');
  });

  it('renders LOCKED when derivedKey is null', () => {
    useAuthStore.setState({ derivedKey: null } as never);
    const { container } = render(<BottomBar />);
    expect(container.textContent).toContain('LOCKED');
  });
});

describe('Chrome / CommandPalette', () => {
  it('returns null when not open', () => {
    const { container } = render(
      <CommandPalette open={false} onClose={vi.fn()} onPickChannel={vi.fn()} commands={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders sections grouped by `sec`', () => {
    const { container } = render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onPickChannel={vi.fn()}
        commands={[
          { sec: 'NAV', cmd: 'go to #foo', hint: '', shortcut: 'foo' },
          { sec: 'NAV', cmd: 'go to #bar', hint: '', shortcut: 'bar' },
          { sec: 'ACCOUNT', cmd: 'logout', hint: '' },
        ]}
      />,
    );
    const secs = [...container.querySelectorAll('.cmdk-sec')].map((s) => s.textContent);
    expect(secs).toEqual(['NAV', 'ACCOUNT']);
  });

  it('filters by query string (matches cmd + sec)', () => {
    const { container, getByPlaceholderText } = render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onPickChannel={vi.fn()}
        commands={[
          { sec: 'A', cmd: 'first', hint: '' },
          { sec: 'A', cmd: 'second', hint: '' },
        ]}
      />,
    );
    fireEvent.change(getByPlaceholderText('type a command…'), { target: { value: 'sec' } });
    const rows = [...container.querySelectorAll('.cmdk-row')].map((r) => r.textContent);
    expect(rows.some((t) => t?.includes('second'))).toBe(true);
    expect(rows.some((t) => t?.includes('first'))).toBe(false);
  });

  it('shows "no matches" when filter excludes everything', () => {
    const { getByText, getByPlaceholderText } = render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onPickChannel={vi.fn()}
        commands={[{ sec: 'A', cmd: 'first', hint: '' }]}
      />,
    );
    fireEvent.change(getByPlaceholderText('type a command…'), { target: { value: 'xyz' } });
    expect(getByText('no matches')).toBeTruthy();
  });

  it('Escape key closes the palette', () => {
    const onClose = vi.fn();
    const { getByPlaceholderText } = render(
      <CommandPalette open onClose={onClose} onPickChannel={vi.fn()} commands={[
        { sec: 'A', cmd: 'first', hint: '' },
      ]} />,
    );
    fireEvent.keyDown(getByPlaceholderText('type a command…'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter picks the selected command + dispatches its dispatch event', () => {
    const onPickChannel = vi.fn();
    const onClose = vi.fn();
    const listener = vi.fn();
    window.addEventListener('dilla:test', listener);
    const { getByPlaceholderText } = render(
      <CommandPalette
        open
        onClose={onClose}
        onPickChannel={onPickChannel}
        commands={[
          { sec: 'A', cmd: 'first', hint: '', dispatch: 'dilla:test', payload: { x: 1 } },
        ]}
      />,
    );
    fireEvent.keyDown(getByPlaceholderText('type a command…'), { key: 'Enter' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener('dilla:test', listener);
  });

  it('click on a row triggers onPickChannel via channelId', () => {
    const onPickChannel = vi.fn();
    const { getByText } = render(
      <CommandPalette
        open
        onClose={vi.fn()}
        onPickChannel={onPickChannel}
        commands={[
          { sec: 'NAV', cmd: 'go to #foo', hint: '', channelId: 'ch-foo' },
        ]}
      />,
    );
    fireEvent.click(getByText('go to #foo').closest('.cmdk-row')!);
    expect(onPickChannel).toHaveBeenCalledWith('ch-foo');
  });

  it('clicking the backdrop closes the palette; clicks inside the panel do not', () => {
    const onClose = vi.fn();
    const { container } = render(
      <CommandPalette open onClose={onClose} onPickChannel={vi.fn()} commands={[
        { sec: 'A', cmd: 'x', hint: '' },
      ]} />,
    );
    fireEvent.click(container.querySelector('.cmdk')!); // inside
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay-dismiss')!); // backdrop
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Chrome / SearchPalette', () => {
  it('returns null when not open', () => {
    const { container } = render(
      withShell(<SearchPalette open={false} onClose={vi.fn()} onPickChannel={vi.fn()} />),
    );
    expect(container.querySelector('.modal-overlay')).toBeNull();
  });

  it('renders search input when open', () => {
    const { container, getByPlaceholderText } = render(
      withShell(<SearchPalette open onClose={vi.fn()} onPickChannel={vi.fn()} />),
    );
    // The placeholder text varies — we just assert there's a search input.
    expect(container.querySelector('input')).toBeTruthy();
    expect(container.querySelector('.modal-overlay')).toBeTruthy();
  });

  it('Escape closes the search palette', () => {
    const onClose = vi.fn();
    const { container } = render(
      withShell(<SearchPalette open onClose={onClose} onPickChannel={vi.fn()} />),
    );
    fireEvent.keyDown(container.querySelector('input')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
