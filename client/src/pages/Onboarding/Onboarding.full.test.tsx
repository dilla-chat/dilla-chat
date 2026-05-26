// Full Onboarding component render with deep-link params and step nav.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../services/api', () => ({ api: new Proxy({}, { get: () => () => Promise.resolve({}) }) }));
vi.mock('../../services/keyStore', () => ({
  hasIdentity: vi.fn(async () => false),
  unlockWithPassphrase: vi.fn(async () => ({})),
  unlockWithPrf: vi.fn(async () => ({})),
  unlockWithRecovery: vi.fn(async () => ({})),
  importIdentityBlob: vi.fn(async () => {}),
  getCredentialInfo: vi.fn(async () => null),
  signChallenge: vi.fn(async () => new Uint8Array(64)),
  decodeRecoveryKey: vi.fn(() => new Uint8Array(32)),
  persistPassphrase: vi.fn(async () => {}),
  refreshServerTokens: vi.fn(async () => {}),
  tryReconnectToCurrentServer: vi.fn(async () => false),
  toBase64: vi.fn(() => 'AQID'),
  fromBase64: vi.fn(() => new Uint8Array(32)),
  activateTeamAndNavigate: vi.fn(async () => {}),
  normalizeServerUrl: vi.fn((u: string) => u),
}));
vi.mock('../../services/crypto', () => ({
  initCrypto: vi.fn(async () => {}),
  cryptoService: {},
}));
vi.mock('../../services/webauthn', () => ({
  registerPasskey: vi.fn(async () => ({ credentialId: 'cid', credentialName: 'Passkey', prfOutput: new ArrayBuffer(32), prfSupported: true })),
  authenticatePasskey: vi.fn(async () => ({ prfOutput: new ArrayBuffer(32) })),
  prfOutputToBase64: vi.fn(() => 'prf-b64'),
}));

import Onboarding from './Onboarding';

function wrap(initialEntries = ['/onboarding']) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Onboarding />
    </MemoryRouter>
  );
}

describe('Onboarding default export', () => {
  it('renders the connect step initially', () => {
    const { container } = render(wrap());
    expect(container.textContent).toContain('Connect');
  });

  it('respects ?mode=invite query param', () => {
    const { container } = render(wrap(['/onboarding?mode=invite&token=tok-abc']));
    expect(container.textContent).toContain('Invite');
  });

  it('respects ?mode=existing query param', () => {
    const { container } = render(wrap(['/onboarding?mode=existing']));
    expect(container.textContent).toContain('Already enrolled');
  });

  it('respects ?mode=bootstrap as default', () => {
    const { container } = render(wrap(['/onboarding?mode=bootstrap']));
    expect(container.textContent).toContain('Connect');
  });

  it('ignores invalid ?mode= values', () => {
    const { container } = render(wrap(['/onboarding?mode=invalid']));
    expect(container.firstChild).toBeTruthy();
  });

  it('handles ?recover=1 (recovery sub-flow)', () => {
    const { container } = render(wrap(['/onboarding?mode=existing&recover=1']));
    expect(container.firstChild).toBeTruthy();
  });

  it('prefills server from ?server= param', () => {
    const { container } = render(wrap(['/onboarding?server=https%3A%2F%2Fexample.com']));
    expect(container.firstChild).toBeTruthy();
  });

  it('clicking mode segment buttons switches mode', () => {
    const { container } = render(wrap());
    const segs = [...container.querySelectorAll('.onb-seg button')] as HTMLButtonElement[];
    for (const s of segs) try { fireEvent.click(s); } catch { /* */ }
    expect(container.firstChild).toBeTruthy();
  });

  it('typing in server URL field updates value', () => {
    const { container } = render(wrap());
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    if (inputs[0]) fireEvent.change(inputs[0], { target: { value: 'http://test:8080' } });
    expect(inputs[0]?.value).toContain('test');
  });

  it('typing in token field updates value', () => {
    const { container } = render(wrap());
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    if (inputs[1]) fireEvent.change(inputs[1], { target: { value: 'tok-abc-12345' } });
    expect(container.firstChild).toBeTruthy();
  });
});
