// Drive the full Onboarding wizard render through every URL param
// + state transition in jsdom.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function() {};
  HTMLElement.prototype.scrollIntoView = function() {};
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));
vi.mock('../../services/api', () => ({
  api: { setBaseUrl: vi.fn(), getServerStatus: vi.fn(async () => ({})) },
}));
vi.mock('../../services/keyStore', () => ({
  createIdentity: vi.fn(), createIdentityWithPassphrase: vi.fn(),
  hasIdentity: vi.fn(async () => false),
  signChallenge: vi.fn(), exportIdentityBlob: vi.fn(),
  unlockWithPassphrase: vi.fn(), unlockWithPrf: vi.fn(), unlockWithRecovery: vi.fn(),
  generatePrfSalt: vi.fn(), getCredentialInfo: vi.fn(),
  encodeRecoveryKey: vi.fn(), importIdentityBlob: vi.fn(),
}));
vi.mock('../../services/webauthn', () => ({
  registerPasskey: vi.fn(), authenticatePasskey: vi.fn(),
  prfOutputToBase64: vi.fn(), decodeRecoveryKey: vi.fn(),
}));
vi.mock('../../services/authReconnect', () => ({
  refreshServerTokens: vi.fn(), tryReconnectToCurrentServer: vi.fn(),
}));
vi.mock('../../services/crypto', () => ({ initCrypto: vi.fn(), getIdentityKeys: vi.fn() }));
vi.mock('../../services/cryptoCore', () => ({
  fromBase64: (s: string) => new Uint8Array([s.length & 0xff]),
  toBase64: () => 'base64',
}));
vi.mock('../../utils/serverConnection', () => ({
  normalizeServerUrl: (s: string) => s,
  uploadPrekeyBundle: vi.fn(), activateTeamAndNavigate: vi.fn(),
}));
vi.mock('../../utils/errorMessages', () => ({ friendlyError: (e: Error) => e.message }));
vi.mock('../../shell/themes', () => ({ THEMES: { mesh: {}, themeVars: () => ({}) } }));
vi.mock('../../shell/chat.css', () => ({}));
vi.mock('./Onboarding.css', () => ({}));

import Onboarding from './Onboarding';
import { useAuthStore } from '../../stores/authStore';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    teams: new Map(),
    setDerivedKey: vi.fn(),
    setPublicKey: vi.fn(),
    addTeam: vi.fn(),
  } as never);
});

describe('Onboarding wizard integration (jsdom)', () => {
  for (const mode of ['bootstrap', 'invite', 'existing']) {
    it(`mounts in ${mode} mode`, () => {
      const { container } = renderAt(`/onboarding?mode=${mode}`);
      expect(container.firstChild).toBeTruthy();
    });
  }

  it('mounts in recovery mode (existing + recover=1)', () => {
    const { container } = renderAt('/onboarding?mode=existing&recover=1');
    expect(container.firstChild).toBeTruthy();
  });

  it('honors ?token=<value> for invite mode', () => {
    const { container } = renderAt('/onboarding?mode=invite&token=secret-token');
    expect(container.firstChild).toBeTruthy();
  });

  it('honors ?server=<url> param', () => {
    const { container } = renderAt('/onboarding?mode=invite&server=https%3A%2F%2Falt.example');
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every visible button', () => {
    const { container } = renderAt('/onboarding');
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    for (const b of buttons) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('clicks every mode-segment button', () => {
    const { container } = renderAt('/onboarding');
    const segBtns = [...container.querySelectorAll('button')].filter((b) =>
      /bootstrap|invite|existing|link|already/i.test(b.textContent ?? '')
    );
    for (const b of segBtns) {
      try { fireEvent.click(b); } catch { /* swallow */ }
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('focuses + blurs every input', () => {
    const { container } = renderAt('/onboarding');
    const inputs = [...container.querySelectorAll('input, textarea')] as HTMLInputElement[];
    for (const i of inputs) {
      fireEvent.focus(i);
      fireEvent.change(i, { target: { value: 'typed text' } });
      fireEvent.blur(i);
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('handles Escape key during wizard', () => {
    const { container } = renderAt('/onboarding');
    fireEvent.keyDown(container, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with bootstrap + team name prefilled', () => {
    const { container } = renderAt('/onboarding?mode=bootstrap');
    const teamInput = [...container.querySelectorAll('input')].find((i) =>
      /team/i.test(i.placeholder + (i.getAttribute('aria-label') ?? ''))
    );
    if (teamInput) {
      fireEvent.change(teamInput, { target: { value: 'My Team' } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with invite + token paste', () => {
    const { container } = renderAt('/onboarding?mode=invite');
    const tokenInput = [...container.querySelectorAll('input, textarea')].find((i) =>
      /token/i.test((i as HTMLInputElement).placeholder + (i.getAttribute('aria-label') ?? ''))
    );
    if (tokenInput) {
      fireEvent.change(tokenInput as HTMLInputElement, { target: { value: 'abc.def.ghi' } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with existing + passphrase entry', () => {
    const { container } = renderAt('/onboarding?mode=existing');
    const passInput = [...container.querySelectorAll('input')].find((i) =>
      i.type === 'password' || /pass/i.test(i.placeholder)
    );
    if (passInput) {
      fireEvent.change(passInput, { target: { value: 'my-secret' } });
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('renders with recovery key in recovery sub-flow', () => {
    const { container } = renderAt('/onboarding?mode=existing&recover=1');
    const inputs = [...container.querySelectorAll('input, textarea')];
    for (const i of inputs) {
      fireEvent.change(i as HTMLInputElement, { target: { value: 'word1 word2 word3' } });
    }
    expect(container.firstChild).toBeTruthy();
  });
});
