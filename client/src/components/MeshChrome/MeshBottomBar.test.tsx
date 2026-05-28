import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MeshBottomBar from './MeshBottomBar';
import { useMeshStore } from '../../stores/meshStore';

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (s: { connected: boolean }) => unknown) =>
    selector({ connected: false }),
}));

vi.mock('../../hooks/useServerConfig', () => ({
  useServerConfig: () => ({
    domain: 'test.local',
    rp_id: 'test.local',
    has_custom_theme: false,
    db_encrypted: true,
    tls_enabled: false,
  }),
}));

beforeEach(() => {
  useMeshStore.setState({
    nodeName: '',
    peersConnected: 0,
    peersTotal: 0,
    lamport: 0,
    latencyMs: 0,
    status: 'ready',
    connectionBanner: null,
  });
});

describe('MeshBottomBar', () => {
  it('renders a contentinfo landmark with the mesh-bottom class', () => {
    const { container } = render(<MeshBottomBar />);
    expect(screen.getByRole('contentinfo', { name: /mesh bottom bar/i })).toBeInTheDocument();
    expect(container.querySelector('.mesh-bottom')).toBeInTheDocument();
  });

  it('shows node name', () => {
    useMeshStore.setState({ nodeName: 'gbg-1.dilla.local' });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/gbg-1\.dilla\.local/i);
  });

  it('shows peers + lamport + latency when federated and not degraded', () => {
    useMeshStore.setState({
      status: 'ok',
      peersConnected: 2,
      peersTotal: 2,
      lamport: 12944,
      latencyMs: 14,
    });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/peers/i);
    expect(container.textContent).toMatch(/2\/2/);
    expect(container.textContent).toMatch(/lamport 12,944/i);
    expect(container.textContent).toMatch(/latency 14ms p50/i);
  });

  it('shows warning indicator and dashes latency when degraded', () => {
    useMeshStore.setState({
      status: 'degraded',
      peersConnected: 1,
      peersTotal: 2,
    });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/1\/2 ⚠/);
    expect(container.textContent).toMatch(/latency —/i);
  });

  it('hides federation chunks (peers/lamport/latency) when status is ready', () => {
    useMeshStore.setState({ status: 'ready' });
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).not.toMatch(/peers/i);
    expect(container.textContent).not.toMatch(/lamport/i);
  });

  it('clicking the e2e chunk dispatches mesh:open-privacy', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<MeshBottomBar />);
    // Click the e2e chunk by its label-prefix span — the title copy
    // depends on e2eState (active/initializing/locked), but the
    // button itself always renders the "e2e" label-prefix.
    fireEvent.click(screen.getByText('e2e').closest('button')!);
    expect(
      spy.mock.calls.some(
        (call) =>
          call[0] instanceof CustomEvent && call[0].type === 'mesh:open-privacy',
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it('shows the db chunk when voice is not connected', () => {
    const { container } = render(<MeshBottomBar />);
    expect(container.textContent).toMatch(/db SQLCIPHER/i);
  });

  it('clicking the node chunk dispatches mesh:open-federation', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<MeshBottomBar />);
    fireEvent.click(screen.getByText('node').closest('button')!);
    expect(spy.mock.calls.some((c) => c[0] instanceof CustomEvent && c[0].type === 'mesh:open-federation')).toBe(true);
    spy.mockRestore();
  });

  it('clicking the peers chunk dispatches mesh:open-federation', () => {
    useMeshStore.setState({ status: 'ok', peersConnected: 1, peersTotal: 2 });
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<MeshBottomBar />);
    fireEvent.click(screen.getByText('peers').closest('button')!);
    expect(spy.mock.calls.some((c) => c[0] instanceof CustomEvent && c[0].type === 'mesh:open-federation')).toBe(true);
    spy.mockRestore();
  });

  it('shows db CHECKING… when server config is null', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useServerConfig', () => ({ useServerConfig: () => null }));
    const { default: Bar } = await import('./MeshBottomBar');
    const { container } = render(<Bar />);
    expect(container.textContent).toMatch(/CHECKING…/);
    vi.doUnmock('../../hooks/useServerConfig');
  });

  it('shows version + build in the rightmost chunk', () => {
    const { container } = render(<MeshBottomBar />);
    // Pulled from Vite-injected build constants — the exact values
    // vary per build, so just assert the labels and that something
    // semver-ish appears, not specific literals.
    expect(container.textContent).toMatch(/v \d+\.\d+\.\d+/i);
    expect(container.textContent).toMatch(/build [\w-]+/i);
  });

  it('shows PLAIN SQLITE warning when db is not encrypted', async () => {
    vi.resetModules();
    vi.doMock('../../hooks/useServerConfig', () => ({
      useServerConfig: () => ({
        domain: 'test.local',
        rp_id: 'test.local',
        has_custom_theme: false,
        db_encrypted: false,
        tls_enabled: false,
      }),
    }));
    const { default: Bar } = await import('./MeshBottomBar');
    const { container } = render(<Bar />);
    expect(container.textContent).toMatch(/PLAIN SQLITE · UNENCRYPTED/);
    // mb-warn class on the db chunk reflects the unencrypted state.
    expect(container.querySelector('.mb-chunk.mb-warn')).toBeTruthy();
    vi.doUnmock('../../hooks/useServerConfig');
  });

  it('shows LOCKED e2e state when derivedKey is null', async () => {
    vi.resetModules();
    vi.doMock('../../stores/authStore', () => ({
      useAuthStore: (selector: (s: { derivedKey: string | null }) => unknown) =>
        selector({ derivedKey: null }),
    }));
    vi.doMock('../../services/crypto', () => ({ isCryptoInitialized: () => false }));
    const { default: Bar } = await import('./MeshBottomBar');
    const { container } = render(<Bar />);
    expect(container.textContent).toMatch(/LOCKED/);
    expect(container.querySelector('button.mb-warn')).toBeTruthy();
    vi.doUnmock('../../stores/authStore');
    vi.doUnmock('../../services/crypto');
  });

  it('shows INITIALIZING e2e state when derivedKey is set but crypto not initialized', async () => {
    vi.resetModules();
    vi.doMock('../../stores/authStore', () => ({
      useAuthStore: (selector: (s: { derivedKey: string | null }) => unknown) =>
        selector({ derivedKey: 'xx' }),
    }));
    vi.doMock('../../services/crypto', () => ({ isCryptoInitialized: () => false }));
    const { default: Bar } = await import('./MeshBottomBar');
    const { container } = render(<Bar />);
    expect(container.textContent).toMatch(/INITIALIZING…/);
    vi.doUnmock('../../stores/authStore');
    vi.doUnmock('../../services/crypto');
  });

  it('shows active SIGNAL e2e label when crypto initialized', async () => {
    vi.resetModules();
    vi.doMock('../../stores/authStore', () => ({
      useAuthStore: (selector: (s: { derivedKey: string | null }) => unknown) =>
        selector({ derivedKey: 'xx' }),
    }));
    vi.doMock('../../services/crypto', () => ({ isCryptoInitialized: () => true }));
    const { default: Bar } = await import('./MeshBottomBar');
    const { container } = render(<Bar />);
    expect(container.textContent).toMatch(/SIGNAL · X3DH · AES-256-GCM/);
    vi.doUnmock('../../stores/authStore');
    vi.doUnmock('../../services/crypto');
  });

  it('clicking the voice chunk dispatches mesh:open-voice-settings (L115)', async () => {
    vi.resetModules();
    vi.doMock('../../stores/voiceStore', () => ({
      useVoiceStore: (selector: (s: { connected: boolean }) => unknown) =>
        selector({ connected: true }),
    }));
    const { default: Bar } = await import('./MeshBottomBar');
    const spy = vi.spyOn(window, 'dispatchEvent');
    render(<Bar />);
    const voiceBtn = screen.getByText('voice').closest('button')!;
    fireEvent.click(voiceBtn);
    expect(
      spy.mock.calls.some(
        (c) => c[0] instanceof CustomEvent && c[0].type === 'mesh:open-voice-settings',
      ),
    ).toBe(true);
    spy.mockRestore();
    vi.doUnmock('../../stores/voiceStore');
  });
});
