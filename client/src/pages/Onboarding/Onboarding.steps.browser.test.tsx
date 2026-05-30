// Render each Onboarding step component in isolation in real
// Chromium. Each step is 60-200 LOC that was previously only
// reachable through the wizard's state machine — testing in isolation
// covers each step's render branches.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import {
  ConnectStep,
  IdentityStep,
  KeyGenStep,
  SafetyStep,
  DoneStep,
} from './Onboarding';
import { useAuthStore } from '../../stores/authStore';

function wrap(children: React.ReactNode) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

beforeEach(() => {
  useAuthStore.setState({
    teams: new Map(),
    setDerivedKey: vi.fn(),
    setPublicKey: vi.fn(),
    addTeam: vi.fn(),
  } as never);
});

describe('ConnectStep', () => {
  function baseProps(overrides: Record<string, unknown> = {}) {
    return {
      mode: 'bootstrap',
      setMode: vi.fn(),
      hasExistingIdentity: false,
      server: 'http://localhost:8080',
      setServer: vi.fn(),
      token: '',
      setToken: vi.fn(),
      passphrase: '',
      setPassphrase: vi.fn(),
      connecting: false,
      log: [],
      error: null,
      onConnect: vi.fn(),
      useRecovery: false,
      setUseRecovery: vi.fn(),
      recoveryServer: '',
      setRecoveryServer: vi.fn(),
      recoveryUsername: '',
      setRecoveryUsername: vi.fn(),
      recoveryKeyInput: '',
      setRecoveryKeyInput: vi.fn(),
      ...overrides,
    };
  }

  it('renders bootstrap mode by default', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps()} />));
    expect(container.textContent).toContain('Connect to a Dilla server');
  });

  it('renders invite mode', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps({ mode: 'invite' })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders existing mode', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps({ mode: 'existing' })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with connecting=true (log lines)', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps({
      connecting: true,
      log: [
        { line: 'connecting to localhost…' },
        { line: '  ✓ tls 1.3 ok' },
      ],
    })} />));
    expect(container.textContent).toContain('connecting');
  });

  it('renders with an error', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps({ error: 'Refused' })} />));
    expect(container.textContent).toContain('Refused');
  });

  it('renders recovery sub-flow', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps({
      mode: 'existing',
      useRecovery: true,
      recoveryServer: 'https://host.example',
      recoveryUsername: 'alice',
    })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with hasExistingIdentity=true (conflict banner)', async () => {
    const { container } = await render(wrap(<ConnectStep {...baseProps({ hasExistingIdentity: true })} />));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('IdentityStep', () => {
  function baseProps(overrides: Record<string, unknown> = {}) {
    return {
      username: '',
      setUsername: vi.fn(),
      passphrase: '',
      setPassphrase: vi.fn(),
      showPass: false,
      setShowPass: vi.fn(),
      keyProtect: 'passphrase',
      setKeyProtect: vi.fn(),
      team: '',
      mode: 'bootstrap',
      setTeam: vi.fn(),
      strength: { score: 0, label: 'empty', color: 'var(--fg-3)' },
      ok: false,
      onBack: vi.fn(),
      onNext: vi.fn(),
      ...overrides,
    };
  }

  it('renders the form', async () => {
    const { container } = await render(wrap(<IdentityStep {...baseProps()} />));
    expect(container.textContent).toContain('identity');
  });

  it('renders with bootstrap mode (team name field)', async () => {
    const { container } = await render(wrap(<IdentityStep {...baseProps({ mode: 'bootstrap', team: 'Acme' })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with invite mode (no team field)', async () => {
    const { container } = await render(wrap(<IdentityStep {...baseProps({ mode: 'invite' })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with passphrase visible', async () => {
    const { container } = await render(wrap(<IdentityStep {...baseProps({
      passphrase: 'secret',
      showPass: true,
      strength: { score: 1, label: 'weak', color: 'var(--danger)' },
    })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with strong passphrase strength', async () => {
    const { container } = await render(wrap(<IdentityStep {...baseProps({
      passphrase: 'StrongPassword123!',
      strength: { score: 4, label: 'excellent', color: 'var(--accent)' },
      ok: true,
    })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with passkey protection mode', async () => {
    const { container } = await render(wrap(<IdentityStep {...baseProps({ keyProtect: 'passkey' })} />));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking Back fires onBack', async () => {
    const onBack = vi.fn();
    const { container } = await render(wrap(<IdentityStep {...baseProps({ onBack })} />));
    const backBtn = [...container.querySelectorAll('button')].find((b) => /back|←/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (backBtn) backBtn.click();
    expect(onBack).toHaveBeenCalled();
  });
});

describe('KeyGenStep', () => {
  it('renders the keygen log', async () => {
    const { container } = await render(wrap(
      <KeyGenStep lines={[{ line: 'generating ed25519 keypair…' }]} error={null} onBack={vi.fn()} />,
    ));
    expect(container.textContent).toContain('generating');
  });

  it('renders an error + back button', async () => {
    const { container } = await render(wrap(
      <KeyGenStep lines={[{ line: 'failed' }]} error="something broke" onBack={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('renders without error (cursor visible)', async () => {
    const { container } = await render(wrap(
      <KeyGenStep lines={[]} error={null} onBack={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });
});

describe('SafetyStep', () => {
  it('renders the fingerprint + QR code', async () => {
    const { container } = await render(wrap(
      <SafetyStep fingerprint="abc123def456" recoveryKey="" onBack={vi.fn()} onNext={vi.fn()} />,
    ));
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders the recovery key section when provided', async () => {
    const { container } = await render(wrap(
      <SafetyStep
        fingerprint="abc123"
        recoveryKey="word1 word2 word3 word4 word5 word6"
        onBack={vi.fn()}
        onNext={vi.fn()}
      />,
    ));
    expect(container.textContent).toContain('Recovery key');
  });

  it('renders without recovery key (no section)', async () => {
    const { container } = await render(wrap(
      <SafetyStep fingerprint="abc" recoveryKey="" onBack={vi.fn()} onNext={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking Back fires onBack', async () => {
    const onBack = vi.fn();
    const { container } = await render(wrap(
      <SafetyStep fingerprint="abc" recoveryKey="" onBack={onBack} onNext={vi.fn()} />,
    ));
    const backBtn = [...container.querySelectorAll('button')].find((b) => /back/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (backBtn) backBtn.click();
    expect(onBack).toHaveBeenCalled();
  });
});

describe('DoneStep', () => {
  it('renders the success summary for bootstrap mode', async () => {
    const { container } = await render(wrap(
      <DoneStep username="alice" team="Acme" mode="bootstrap" onOpen={vi.fn()} />,
    ));
    expect(container.textContent).toContain('alice');
    expect(container.textContent).toContain('Acme');
    expect(container.textContent).toContain('admin');
  });

  it('renders the success summary for invite mode', async () => {
    const { container } = await render(wrap(
      <DoneStep username="bob" team="Beta" mode="invite" onOpen={vi.fn()} />,
    ));
    expect(container.textContent).toContain('member');
  });

  it('renders the success summary for existing mode', async () => {
    const { container } = await render(wrap(
      <DoneStep username="bob" team="Beta" mode="existing" onOpen={vi.fn()} />,
    ));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking Open Dilla fires onOpen', async () => {
    const onOpen = vi.fn();
    const { container } = await render(wrap(
      <DoneStep username="alice" team="Acme" mode="bootstrap" onOpen={onOpen} />,
    ));
    const openBtn = [...container.querySelectorAll('button')].find((b) => /open/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
    if (openBtn) openBtn.click();
    expect(onOpen).toHaveBeenCalled();
  });
});
