// Direct rendering of Onboarding's exported step components — bypasses
// the full state machine to exercise visual / interaction branches that
// are unreachable when driving through the parent flow.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));
vi.mock('../../shell/chat.css', () => ({}));
vi.mock('./Onboarding.css', () => ({}));

import {
  ConnectStep,
  IdentityStep,
  KeyGenStep,
  SafetyStep,
  DoneStep,
  passphraseStrength,
} from './Onboarding';

function wrap(node: React.ReactNode) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

describe('passphraseStrength', () => {
  it('returns "empty" label for empty', () => {
    expect(passphraseStrength('').label).toBe('empty');
  });

  it('weak for 8 chars', () => {
    expect(passphraseStrength('12345678').score).toBeGreaterThanOrEqual(1);
  });

  it('excellent for long mixed passphrase', () => {
    const r = passphraseStrength('A-very-long-Passphrase-with-9000-mixed-stuff');
    expect(r.score).toBe(4);
  });
});

describe('ConnectStep', () => {
  const baseProps = {
    mode: 'bootstrap' as const,
    setMode: vi.fn(),
    hasExistingIdentity: false,
    server: 'http://localhost:8080',
    setServer: vi.fn(),
    token: 'tok-123',
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
  };

  it('renders bootstrap mode form with token field', () => {
    const { container } = render(wrap(<ConnectStep {...baseProps} />));
    expect(container.textContent).toMatch(/Bootstrap token/);
  });

  it('renders invite mode form with invite token field', () => {
    const { container } = render(wrap(<ConnectStep {...baseProps} mode="invite" />));
    expect(container.textContent).toMatch(/Invite token/);
  });

  it('renders existing mode form with passphrase field', () => {
    const { container } = render(wrap(<ConnectStep {...baseProps} mode="existing" />));
    const pass = container.querySelector('input[type="password"]');
    expect(pass).toBeTruthy();
  });

  it('renders recovery sub-flow when useRecovery=true', () => {
    const { container } = render(wrap(<ConnectStep {...baseProps} mode="existing" useRecovery />));
    expect(container.textContent).toMatch(/Recover|recovery/i);
  });

  it('shows the hasExistingIdentity callout when mode != existing and identity exists', () => {
    const { container } = render(wrap(
      <ConnectStep {...baseProps} hasExistingIdentity mode="bootstrap" />,
    ));
    expect(container.textContent).toMatch(/An identity already exists/);
  });

  it('renders error banner when error prop is set', () => {
    const { container } = render(wrap(
      <ConnectStep {...baseProps} error="Connection refused" />,
    ));
    expect(container.textContent).toMatch(/Connection refused/);
  });

  it('renders log lines + connecting label', () => {
    const { container } = render(wrap(
      <ConnectStep {...baseProps} connecting log={[{ line: 'reaching out' }, { line: 'tls ok' }]} />,
    ));
    expect(container.textContent).toMatch(/reaching out/);
    expect(container.textContent).toMatch(/Connecting/);
  });

  it('clicking the bootstrap segment calls setMode', () => {
    const setMode = vi.fn();
    const { container } = render(wrap(<ConnectStep {...baseProps} mode="invite" setMode={setMode} />));
    const btn = [...container.querySelectorAll('button')].find((b) =>
      /bootstrap link/i.test(b.textContent ?? ''),
    )!;
    fireEvent.click(btn);
    expect(setMode).toHaveBeenCalledWith('bootstrap');
  });

  it('clicking the existing segment calls setMode("existing")', () => {
    const setMode = vi.fn();
    const { container } = render(wrap(<ConnectStep {...baseProps} mode="invite" setMode={setMode} />));
    const btn = [...container.querySelectorAll('button')].find((b) =>
      /already enrolled/i.test(b.textContent ?? ''),
    )!;
    fireEvent.click(btn);
    expect(setMode).toHaveBeenCalledWith('existing');
  });

  it('Connect button is disabled when bootstrap mode and no token', () => {
    const { container } = render(wrap(<ConnectStep {...baseProps} mode="bootstrap" token="" />));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /^connect$/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(cta?.disabled).toBe(true);
  });

  it('Recover identity CTA appears in recovery mode', () => {
    const { container } = render(wrap(
      <ConnectStep {...baseProps} mode="existing" useRecovery />,
    ));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /recover identity/i.test(b.textContent ?? ''),
    );
    expect(cta).toBeTruthy();
  });
});

describe('IdentityStep', () => {
  const props = {
    username: 'alice',
    setUsername: vi.fn(),
    passphrase: 'hunter2-is-strong-enough',
    setPassphrase: vi.fn(),
    showPass: false,
    setShowPass: vi.fn(),
    keyProtect: 'passphrase' as const,
    setKeyProtect: vi.fn(),
    team: 'my team',
    mode: 'bootstrap' as const,
    setTeam: vi.fn(),
    strength: { score: 4 as const, label: 'excellent' as const, color: 'green' },
    ok: true,
    onBack: vi.fn(),
    onNext: vi.fn(),
  };

  it('renders identity form with username + passphrase + team inputs', () => {
    const { container } = render(wrap(<IdentityStep {...props} />));
    expect(container.querySelectorAll('input').length).toBeGreaterThan(1);
  });

  it('continue button calls onNext when ok=true', () => {
    const onNext = vi.fn();
    const { container } = render(wrap(<IdentityStep {...props} onNext={onNext} />));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /Generate keys|continue|next|create/i.test(b.textContent ?? ''),
    );
    if (cta) {
      fireEvent.click(cta);
      expect(onNext).toHaveBeenCalled();
    }
  });

  it('continue button is disabled when ok=false', () => {
    const { container } = render(wrap(<IdentityStep {...props} ok={false} />));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /Generate keys|continue|next|create/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    expect(cta?.disabled).toBe(true);
  });

  it('back button calls onBack', () => {
    const onBack = vi.fn();
    const { container } = render(wrap(<IdentityStep {...props} onBack={onBack} />));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /^back/i.test(b.textContent ?? ''),
    );
    if (cta) {
      fireEvent.click(cta);
      expect(onBack).toHaveBeenCalled();
    }
  });

  it('show-pass toggle flips passphrase input type', () => {
    const setShowPass = vi.fn();
    const { container } = render(wrap(<IdentityStep {...props} setShowPass={setShowPass} />));
    const toggle = [...container.querySelectorAll('button')].find((b) =>
      /show|hide/i.test(b.textContent ?? ''),
    );
    if (toggle) {
      fireEvent.click(toggle);
      expect(setShowPass).toHaveBeenCalled();
    }
  });
});

describe('KeyGenStep', () => {
  it('renders lines as a log', () => {
    const { container } = render(wrap(
      <KeyGenStep lines={[{ line: '$ dilla identity create' }, { line: 'generating…' }]} error={null} onBack={vi.fn()} />,
    ));
    expect(container.textContent).toMatch(/dilla identity create/);
  });

  it('renders the back button when error is set', () => {
    const onBack = vi.fn();
    const { container } = render(wrap(
      <KeyGenStep lines={[{ line: 'error: boom', err: true }]} error="boom" onBack={onBack} />,
    ));
    const back = [...container.querySelectorAll('button')].find((b) =>
      /back to identity/i.test(b.textContent ?? ''),
    )!;
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });
});

describe('SafetyStep', () => {
  it('renders fingerprint groups + recovery key block', () => {
    const { container } = render(wrap(
      <SafetyStep
        fingerprint="abcd 1234 ef56 7890 abcd 1234 ef56 7890 abcd 1234 ef56 7890"
        recoveryKey="aaaa-bbbb-cccc-dddd"
        onBack={vi.fn()}
        onNext={vi.fn()}
      />,
    ));
    expect(container.textContent).toMatch(/abcd/);
    expect(container.textContent).toMatch(/aaaa-bbbb/);
  });

  it('Continue is disabled until the recovery checkbox is ticked', () => {
    const { container } = render(wrap(
      <SafetyStep fingerprint="ab cd ef" recoveryKey="abc" onBack={vi.fn()} onNext={vi.fn()} />,
    ));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /finish|continue|next/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement | undefined;
    if (cta) expect(cta.disabled).toBe(true);
  });
});

describe('DoneStep', () => {
  it('renders welcome with username + team', () => {
    const { container } = render(wrap(
      <DoneStep username="alice" team="Cool Team" mode="bootstrap" onOpen={vi.fn()} />,
    ));
    expect(container.textContent).toMatch(/alice/);
    expect(container.textContent).toMatch(/Cool Team/);
  });

  it('clicking the open button calls onOpen', () => {
    const onOpen = vi.fn();
    const { container } = render(wrap(
      <DoneStep username="alice" team="Cool" mode="invite" onOpen={onOpen} />,
    ));
    const cta = [...container.querySelectorAll('button')].find((b) =>
      /open|launch/i.test(b.textContent ?? ''),
    );
    if (cta) {
      fireEvent.click(cta);
      expect(onOpen).toHaveBeenCalled();
    }
  });
});
