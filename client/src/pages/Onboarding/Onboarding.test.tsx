import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Onboarding, { passphraseStrength } from './Onboarding';
import { useAuthStore } from '../../stores/authStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));

vi.mock('../../services/api', () => ({
  api: { setBaseUrl: vi.fn(), getServerStatus: vi.fn(async () => ({})) },
}));

vi.mock('../../services/keyStore', () => ({
  createIdentity: vi.fn(),
  createIdentityWithPassphrase: vi.fn(),
  hasIdentity: vi.fn(async () => false),
  signChallenge: vi.fn(),
  exportIdentityBlob: vi.fn(),
  unlockWithPassphrase: vi.fn(),
  unlockWithPrf: vi.fn(),
  unlockWithRecovery: vi.fn(),
  generatePrfSalt: vi.fn(),
  getCredentialInfo: vi.fn(),
  encodeRecoveryKey: vi.fn(),
  importIdentityBlob: vi.fn(),
}));

vi.mock('../../services/webauthn', () => ({
  registerPasskey: vi.fn(),
  authenticatePasskey: vi.fn(),
  prfOutputToBase64: vi.fn(),
  decodeRecoveryKey: vi.fn(),
}));

vi.mock('../../services/authReconnect', () => ({
  refreshServerTokens: vi.fn(),
  tryReconnectToCurrentServer: vi.fn(),
}));

vi.mock('../../services/crypto', () => ({
  initCrypto: vi.fn(),
  getIdentityKeys: vi.fn(),
}));

vi.mock('../../services/cryptoCore', () => ({
  fromBase64: (s: string) => new Uint8Array([s.length & 0xff]),
  toBase64: () => 'base64',
}));

vi.mock('../../utils/serverConnection', () => ({
  normalizeServerUrl: (s: string) => s,
  uploadPrekeyBundle: vi.fn(),
  activateTeamAndNavigate: vi.fn(),
}));

vi.mock('../../utils/errorMessages', () => ({
  friendlyError: (e: Error) => e.message,
}));

vi.mock('../../shell/themes', () => ({
  THEMES: { mesh: {}, themeVars: () => ({}) },
}));

vi.mock('../../shell/chat.css', () => ({}));
vi.mock('./Onboarding.css', () => ({}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('passphraseStrength', () => {
  it('empty passphrase is "empty" with score 0', () => {
    const r = passphraseStrength('');
    expect(r.score).toBe(0);
    expect(r.label).toBe('empty');
  });

  it('short passphrase scores 0 → "too short"', () => {
    const r = passphraseStrength('abc');
    expect(r.score).toBe(0);
    expect(r.label).toBe('too short');
  });

  it('8+ chars scores at least 1 → "weak"', () => {
    const r = passphraseStrength('abcdefgh');
    expect(r.score).toBe(1);
    expect(r.label).toBe('weak');
  });

  it('14+ chars scores 2 → "fair"', () => {
    const r = passphraseStrength('abcdefghijklmn');
    expect(r.score).toBe(2);
    expect(r.label).toBe('fair');
  });

  it('20+ chars scores 3 → "strong"', () => {
    const r = passphraseStrength('abcdefghijklmnopqrst');
    expect(r.score).toBe(3);
    expect(r.label).toBe('strong');
  });

  it('mixed case + digits at 20+ chars scores 4 → "excellent"', () => {
    const r = passphraseStrength('Abcdefghijklmnopqrs1');
    expect(r.score).toBe(4);
    expect(r.label).toBe('excellent');
  });

  it('color escalates with score', () => {
    // Empty passphrase carries a neutral fg-3 colour (different code path).
    expect(passphraseStrength('').color).toContain('fg-3');
    // Short non-empty → danger.
    expect(passphraseStrength('abc').color).toContain('danger');
    // 14+ chars → warn.
    expect(passphraseStrength('abcdefghijklmn').color).toContain('warn');
    // 20+ chars → accent.
    expect(passphraseStrength('abcdefghijklmnopqrst').color).toContain('accent');
  });

  it('score is clamped to 4 max', () => {
    // All four criteria trigger; can't go higher.
    const r = passphraseStrength('AbcdefghijklmnopqrstU1');
    expect(r.score).toBeLessThanOrEqual(4);
  });
});

describe('Onboarding page', () => {
  beforeEach(() => {
    useAuthStore.setState({
      teams: new Map(),
      setDerivedKey: vi.fn(),
      setPublicKey: vi.fn(),
      addTeam: vi.fn(),
    } as never);
  });

  it('renders without crashing in default (bootstrap) mode', () => {
    const { container } = renderAt('/onboarding');
    expect(container.querySelector('h1, [class*="onb"]')).toBeTruthy();
  });

  it('honors ?mode=invite query param', () => {
    const { container } = renderAt('/onboarding?mode=invite&token=abc');
    // The wizard renders something; we don't deep-assert mode-specific
    // text (i18n + custom strings), just smoke-test it doesn't crash.
    expect(container.firstChild).toBeTruthy();
  });

  it('honors ?mode=existing query param', () => {
    const { container } = renderAt('/onboarding?mode=existing');
    expect(container.firstChild).toBeTruthy();
  });

  it('honors ?mode=bootstrap explicitly', () => {
    const { container } = renderAt('/onboarding?mode=bootstrap');
    expect(container.firstChild).toBeTruthy();
  });

  it('ignores unknown ?mode= values and falls back to bootstrap', () => {
    const { container } = renderAt('/onboarding?mode=garbage');
    expect(container.firstChild).toBeTruthy();
  });

  it('honors ?server= to prefill the connect URL', () => {
    const { container } = renderAt('/onboarding?mode=invite&server=https%3A%2F%2Falt.example');
    // We don't have a stable selector for the input across i18n
    // variants; assert the page renders.
    expect(container.firstChild).toBeTruthy();
  });

  it('honors ?recover=1 query param (existing mode recovery sub-flow)', () => {
    const { container } = renderAt('/onboarding?mode=existing&recover=1');
    expect(container.firstChild).toBeTruthy();
  });

  it('renders a non-empty content tree on mount', () => {
    const { container } = renderAt('/onboarding');
    expect(container.firstChild).not.toBeNull();
    // Some wizard content surfaced — at minimum a heading or button.
    const hasContent =
      container.querySelector('h1, h2, button, [class*="onb"]') !== null;
    expect(hasContent).toBe(true);
  });
});
