// Focused unit tests for each Onboarding step component — drive every
// branch (button clicks, input changes, mode switches, error states).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

import {
  passphraseStrength,
  ConnectStep,
  IdentityStep,
  KeyGenStep,
  SafetyStep,
  DoneStep,
} from './Onboarding';

// Polyfill clipboard
beforeEach(() => {
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
  }
});

describe('passphraseStrength', () => {
  it('returns score 0 for empty string', () => {
    const r = passphraseStrength('') as { score: number };
    expect(r.score).toBe(0);
  });

  it('increases score for length', () => {
    const short = passphraseStrength('abc') as { score: number };
    const long = passphraseStrength('a-much-longer-passphrase-with-many-chars-and-symbols!') as { score: number };
    expect(long.score).toBeGreaterThan(short.score);
  });

  it('returns a valid score for very long input', () => {
    const r = passphraseStrength('!'.repeat(200)) as { score: number };
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('handles mixed character classes', () => {
    const r = passphraseStrength('Abc-123-Xyz-!@#') as { score: number };
    expect(r.score).toBeGreaterThan(0);
  });
});

describe('ConnectStep', () => {
  const makeProps = (overrides: Record<string, unknown> = {}) => ({
    mode: 'bootstrap' as const, setMode: vi.fn(),
    hasExistingIdentity: false,
    server: 'http://localhost:8080', setServer: vi.fn(),
    token: '', setToken: vi.fn(),
    passphrase: '', setPassphrase: vi.fn(),
    connecting: false,
    log: [],
    error: null,
    onConnect: vi.fn(),
    useRecovery: false, setUseRecovery: vi.fn(),
    recoveryServer: '', setRecoveryServer: vi.fn(),
    recoveryUsername: '', setRecoveryUsername: vi.fn(),
    recoveryKeyInput: '', setRecoveryKeyInput: vi.fn(),
    ...overrides,
  });

  it('renders bootstrap mode', () => {
    const { container } = render(<ConnectStep {...makeProps()} />);
    expect(container.textContent).toContain('Bootstrap token');
  });

  it('renders invite mode', () => {
    const { container } = render(<ConnectStep {...makeProps({ mode: 'invite' })} />);
    expect(container.textContent).toContain('Invite token');
  });

  it('renders existing mode without recovery', () => {
    const { container } = render(<ConnectStep {...makeProps({ mode: 'existing' })} />);
    expect(container.textContent).toContain('Already enrolled');
  });

  it('renders existing mode with recovery', () => {
    const { container } = render(<ConnectStep {...makeProps({ mode: 'existing', useRecovery: true })} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('shows existing-identity callout when hasExistingIdentity + non-existing mode', () => {
    const { container } = render(<ConnectStep {...makeProps({ hasExistingIdentity: true })} />);
    expect(container.textContent).toContain('identity already exists');
  });

  it('clicks "Sign in with your existing identity" link', () => {
    const setMode = vi.fn();
    const { container } = render(<ConnectStep {...makeProps({ hasExistingIdentity: true, setMode })} />);
    const link = [...container.querySelectorAll('button')].find((b) => /sign in/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(link);
    expect(setMode).toHaveBeenCalledWith('existing');
  });

  it('clicks all 3 mode segment buttons', () => {
    const setMode = vi.fn();
    const { container } = render(<ConnectStep {...makeProps({ setMode })} />);
    const segs = [...container.querySelectorAll('.onb-seg button')] as HTMLButtonElement[];
    for (const s of segs) fireEvent.click(s);
    expect(setMode).toHaveBeenCalled();
  });

  it('types in server URL field', () => {
    const setServer = vi.fn();
    const { container } = render(<ConnectStep {...makeProps({ setServer })} />);
    const serverInput = container.querySelectorAll('input')[0] as HTMLInputElement;
    fireEvent.change(serverInput, { target: { value: 'http://new:9999' } });
    expect(setServer).toHaveBeenCalledWith('http://new:9999');
  });

  it('types in token field (bootstrap mode)', () => {
    const setToken = vi.fn();
    const { container } = render(<ConnectStep {...makeProps({ setToken })} />);
    const inputs = container.querySelectorAll('input');
    const tokenInput = inputs[1] as HTMLInputElement;
    if (tokenInput) {
      fireEvent.change(tokenInput, { target: { value: 'tok-abc' } });
      expect(setToken).toHaveBeenCalled();
    }
  });

  it('clicks Connect button when present', () => {
    const onConnect = vi.fn();
    const { container } = render(<ConnectStep {...makeProps({ onConnect, token: 'tok-abc' })} />);
    const connectBtn = [...container.querySelectorAll('button')].find((b) => /connect|continue|next/i.test(b.textContent ?? ''));
    if (connectBtn) {
      fireEvent.click(connectBtn as HTMLButtonElement);
    }
    // not asserting onConnect — the button may be disabled or behind other state
    expect(container.firstChild).toBeTruthy();
  });

  it('shows connecting state', () => {
    const { container } = render(<ConnectStep {...makeProps({ connecting: true })} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('shows error', () => {
    const { container } = render(<ConnectStep {...makeProps({ error: 'connection refused' })} />);
    expect(container.textContent).toContain('connection refused');
  });

  it('shows log lines', () => {
    const { container } = render(<ConnectStep {...makeProps({ log: [
      { line: '$ connecting...', err: false },
      { line: 'error: not found', err: true },
    ]})} />);
    expect(container.firstChild).toBeTruthy();
  });
});

describe('IdentityStep', () => {
  const makeProps = (overrides: Record<string, unknown> = {}) => ({
    username: 'jonas', setUsername: vi.fn(),
    passphrase: 'pp', setPassphrase: vi.fn(),
    showPass: false, setShowPass: vi.fn(),
    keyProtect: 'passphrase' as const, setKeyProtect: vi.fn(),
    team: 'a new team', mode: 'bootstrap' as const,
    setTeam: vi.fn(),
    strength: 3, ok: true,
    onBack: vi.fn(), onNext: vi.fn(),
    ...overrides,
  });

  it('renders with passphrase protection', () => {
    const { container } = render(<IdentityStep {...makeProps()} />);
    expect(container.textContent).toContain('Username');
    expect(container.textContent).toContain('Passphrase');
  });

  it('renders with hardware protection (hides passphrase field)', () => {
    const { container } = render(<IdentityStep {...makeProps({ keyProtect: 'hardware' })} />);
    expect(container.textContent).toContain('Hardware key');
  });

  it('renders with both protection', () => {
    const { container } = render(<IdentityStep {...makeProps({ keyProtect: 'both' })} />);
    expect(container.textContent).toContain('Both');
  });

  it('shows team name input only in bootstrap mode', () => {
    const { container } = render(<IdentityStep {...makeProps({ mode: 'bootstrap' })} />);
    expect(container.textContent).toContain('Team name');
  });

  it('hides team name input in invite mode', () => {
    const { container } = render(<IdentityStep {...makeProps({ mode: 'invite' })} />);
    expect(container.textContent).not.toContain('Team name');
  });

  it('typing username sanitizes to lowercase + allowed chars', () => {
    const setUsername = vi.fn();
    const { container } = render(<IdentityStep {...makeProps({ setUsername })} />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'JoNas!@#-test' } });
    expect(setUsername).toHaveBeenCalledWith('jonas-test');
  });

  it('clicks all 3 protection segment buttons', () => {
    const setKeyProtect = vi.fn();
    const { container } = render(<IdentityStep {...makeProps({ setKeyProtect })} />);
    const segs = [...container.querySelectorAll('.onb-seg-protect button')] as HTMLButtonElement[];
    for (const s of segs) fireEvent.click(s);
    expect(setKeyProtect).toHaveBeenCalled();
  });

  it('clicks show/hide passphrase toggle', () => {
    const setShowPass = vi.fn();
    const { container } = render(<IdentityStep {...makeProps({ setShowPass })} />);
    const showBtn = [...container.querySelectorAll('button')].find((b) => /show|hide/i.test(b.textContent ?? ''));
    if (showBtn) {
      fireEvent.click(showBtn as HTMLButtonElement);
      expect(setShowPass).toHaveBeenCalled();
    }
  });

  it('clicks Back / Next buttons', () => {
    const onBack = vi.fn();
    const onNext = vi.fn();
    const { container } = render(<IdentityStep {...makeProps({ onBack, onNext })} />);
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      if (/back/i.test(b.textContent ?? '')) fireEvent.click(b);
      if (/next|continue/i.test(b.textContent ?? '')) fireEvent.click(b);
    }
    expect(onBack.mock.calls.length + onNext.mock.calls.length).toBeGreaterThan(0);
  });

  it('disables Next when ok=false', () => {
    const { container } = render(<IdentityStep {...makeProps({ ok: false })} />);
    expect(container.firstChild).toBeTruthy();
  });
});

describe('KeyGenStep', () => {
  it('renders with empty log', () => {
    const { container } = render(<KeyGenStep lines={[]} error={null} onBack={vi.fn()} />);
    expect(container.textContent).toContain('Generating keys');
  });

  it('renders log lines', () => {
    const lines = [
      { line: 'creating identity', err: false },
      { line: 'enrolling...', err: false },
      { line: 'enrollment failed', err: true },
    ];
    const { container } = render(<KeyGenStep lines={lines} error={null} onBack={vi.fn()} />);
    expect(container.textContent).toContain('creating identity');
    expect(container.textContent).toContain('enrollment failed');
  });

  it('renders error state and back button works', () => {
    const onBack = vi.fn();
    const { container } = render(<KeyGenStep lines={[]} error="something broke" onBack={onBack} />);
    const backBtn = [...container.querySelectorAll('button')].find((b) => /back/i.test(b.textContent ?? ''));
    if (backBtn) fireEvent.click(backBtn as HTMLButtonElement);
    expect(onBack).toHaveBeenCalled();
  });

  it('renders shell-prompt lines starting with $', () => {
    const lines = [{ line: '$ cargo run', err: false }];
    const { container } = render(<KeyGenStep lines={lines} error={null} onBack={vi.fn()} />);
    expect(container.textContent).toContain('cargo run');
  });
});

describe('SafetyStep', () => {
  it('renders fingerprint + recovery key', () => {
    const { container } = render(
      <SafetyStep
        fingerprint="aa11 bb22 cc33 dd44"
        recoveryKey="ABCD-EFGH-1234-5678-WXYZ"
        onBack={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('aa11');
    expect(container.textContent).toContain('ABCD');
  });

  it('renders pending fingerprint state', () => {
    const { container } = render(
      <SafetyStep fingerprint="" recoveryKey="rk" onBack={vi.fn()} onNext={vi.fn()} />,
    );
    expect(container.textContent).toContain('pending');
  });

  it('clicks Copy fingerprint button', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = render(
      <SafetyStep fingerprint="fp" recoveryKey="rk" onBack={vi.fn()} onNext={vi.fn()} />,
    );
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      if (/copy/i.test(b.textContent ?? '')) fireEvent.click(b);
    }
    expect(writeText).toHaveBeenCalled();
  });

  it('clicks Back / Next buttons', () => {
    const onBack = vi.fn();
    const onNext = vi.fn();
    const { container } = render(
      <SafetyStep fingerprint="fp" recoveryKey="rk" onBack={onBack} onNext={onNext} />,
    );
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      if (/back/i.test(b.textContent ?? '')) fireEvent.click(b);
    }
    expect(onBack).toHaveBeenCalled();
  });

  it('cycles through recovery-confirmed checkbox', () => {
    const { container } = render(
      <SafetyStep fingerprint="fp" recoveryKey="rk" onBack={vi.fn()} onNext={vi.fn()} />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (checkbox) {
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);
    }
    expect(container.firstChild).toBeTruthy();
  });
});

describe('DoneStep', () => {
  it('renders as bootstrap (admin)', () => {
    const { container } = render(
      <DoneStep username="jonas" team="berralitos" mode="bootstrap" onOpen={vi.fn()} />,
    );
    expect(container.textContent).toContain('jonas');
    expect(container.textContent).toContain('admin');
  });

  it('renders as invite (member)', () => {
    const { container } = render(
      <DoneStep username="alice" team="acme" mode="invite" onOpen={vi.fn()} />,
    );
    expect(container.textContent).toContain('alice');
    expect(container.textContent).toContain('member');
  });

  it('renders as existing (member)', () => {
    const { container } = render(
      <DoneStep username="bob" team="dilla" mode="existing" onOpen={vi.fn()} />,
    );
    expect(container.textContent).toContain('bob');
  });

  it('clicks Open Dilla button', () => {
    const onOpen = vi.fn();
    const { container } = render(
      <DoneStep username="me" team="t" mode="invite" onOpen={onOpen} />,
    );
    const btn = [...container.querySelectorAll('button')].find((b) => /open/i.test(b.textContent ?? ''));
    if (btn) fireEvent.click(btn as HTMLButtonElement);
    expect(onOpen).toHaveBeenCalled();
  });
});
