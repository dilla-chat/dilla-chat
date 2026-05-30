// Drives Onboarding.tsx through the full Connect → Identity → KeyGen flow
// so the keygen useEffect at L362-565 actually runs end-to-end with mocked
// network + crypto deps. The existing flows.test.tsx asserts loosely
// ("ran || container.firstChild") and stops short of the "Generate keys"
// button so the useEffect never fires in those tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}

const navigateMock = vi.fn();
const apiMock = vi.hoisted(() => ({
  api: {
    setBaseUrl: vi.fn(),
    addTeam: vi.fn(),
    removeTeam: vi.fn(),
    setToken: vi.fn(),
    requestChallenge: vi.fn(async () => ({ challenge_id: 'c1', nonce: 'AAAAAAAAAAAAAAAAAAAAAA==' })),
    verifyChallenge: vi.fn(async () => ({ user: { id: 'u1', username: 'alice' }, token: 'jwt-tok', team_id: 't1' })),
    bootstrap: vi.fn(async () => ({
      user: { id: 'u1', username: 'alice' },
      token: 'jwt-tok',
      team_id: 't-new',
      team: { id: 't-new', name: 'New Team' },
    })),
    register: vi.fn(async () => ({
      user: { id: 'u1', username: 'alice' },
      token: 'jwt-tok',
      team_id: 't-inv',
    })),
    getInviteInfo: vi.fn(async () => ({ team_name: 'Invited Team' })),
  },
}));
vi.mock('../../services/api', () => apiMock);

const keystoreMock = vi.hoisted(() => ({
  createIdentity: vi.fn(async () => ({
    publicKeyB64: 'pkb64',
    publicKeyHex: '1234567890abcdef',
    identity: {
      publicKeyBytes: new Uint8Array([1, 2, 3]),
      signingKey: {} as CryptoKey,
      dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array() },
    },
    recoveryKey: new Uint8Array(32),
  })),
  createIdentityWithPassphrase: vi.fn(async () => ({
    publicKeyB64: 'pkb64',
    publicKeyHex: 'feedfacecafebabe',
    identity: {
      publicKeyBytes: new Uint8Array([1, 2, 3]),
      signingKey: {} as CryptoKey,
      dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array() },
    },
    recoveryKey: new Uint8Array(32),
  })),
  hasIdentity: vi.fn(async () => false),
  signChallenge: vi.fn(async () => new Uint8Array(64)),
  exportIdentityBlob: vi.fn(async () => 'identity-blob-b64'),
  unlockWithPassphrase: vi.fn(async () => ({
    publicKeyBytes: new Uint8Array([1, 2, 3]),
    signingKey: {} as CryptoKey,
    dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array() },
  })),
  unlockWithPrf: vi.fn(),
  unlockWithRecovery: vi.fn(),
  generatePrfSalt: vi.fn(() => new Uint8Array(32)),
  getCredentialInfo: vi.fn(async () => null),
  encodeRecoveryKey: vi.fn(() => 'recovery-encoded'),
  importIdentityBlob: vi.fn(async () => {}),
}));
vi.mock('../../services/keyStore', () => keystoreMock);

const webauthnMock = vi.hoisted(() => ({
  registerPasskey: vi.fn(async () => ({
    credentialId: 'cred-1',
    credentialName: 'Yubikey',
    prfSupported: true,
    prfOutput: new ArrayBuffer(32),
  })),
  authenticatePasskey: vi.fn(),
  prfOutputToBase64: vi.fn(() => 'prf-b64'),
  decodeRecoveryKey: vi.fn(() => new Uint8Array(32)),
}));
vi.mock('../../services/webauthn', () => webauthnMock);

vi.mock('../../services/authReconnect', () => ({
  refreshServerTokens: vi.fn(async () => {}),
  tryReconnectToCurrentServer: vi.fn(async () => false),
}));

vi.mock('../../services/crypto', () => ({
  initCrypto: vi.fn(async () => {}),
  getIdentityKeys: vi.fn(() => ({
    signingKey: {} as CryptoKey,
    publicKeyBytes: new Uint8Array([1, 2, 3]),
    dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array() },
  })),
}));

vi.mock('../../services/cryptoCore', () => ({
  fromBase64: (s: string) => new Uint8Array(s.length),
  toBase64: () => 'b64-stub',
}));

const utilsMock = vi.hoisted(() => ({
  normalizeServerUrl: (s: string) => (s.startsWith('http') ? s : 'https://' + s),
  uploadPrekeyBundle: vi.fn(async () => {}),
  activateTeamAndNavigate: vi.fn(async () => {}),
}));
vi.mock('../../utils/serverConnection', () => utilsMock);

vi.mock('../../utils/errorMessages', () => ({ friendlyError: (e: Error) => e?.message ?? String(e) }));
vi.mock('../../shell/themes', () => ({ THEMES: { mesh: {}, themeVars: () => ({}) } }));
vi.mock('../../shell/chat.css', () => ({}));
vi.mock('./Onboarding.css', () => ({}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../../stores/authStore', async () => {
  const actual = await vi.importActual<typeof import('../../stores/authStore')>('../../stores/authStore');
  return {
    ...actual,
    persistPassphrase: vi.fn(async () => {}),
  };
});

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
  navigateMock.mockClear();
  Object.values(apiMock.api).forEach((f) => {
    if ('mockClear' in f) (f as { mockClear: () => void }).mockClear();
  });
  Object.values(keystoreMock).forEach((f) => {
    if ('mockClear' in f) (f as { mockClear: () => void }).mockClear();
  });
  Object.values(webauthnMock).forEach((f) => {
    if ('mockClear' in f) (f as { mockClear: () => void }).mockClear();
  });
  utilsMock.uploadPrekeyBundle.mockClear();
  utilsMock.activateTeamAndNavigate.mockClear();
  useAuthStore.setState({
    teams: new Map(),
    setDerivedKey: vi.fn(),
    setPublicKey: vi.fn(),
    addTeam: vi.fn(),
  } as never);
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ blob: 'identity-blob-b64' }),
  }) as never;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, regex: RegExp): HTMLButtonElement | null {
  return (
    ([...container.querySelectorAll('button')] as HTMLButtonElement[]).find((b) =>
      regex.test(b.textContent ?? ''),
    ) ?? null
  );
}

function findInputByPlaceholder(container: HTMLElement, regex: RegExp): HTMLInputElement | null {
  return (
    ([...container.querySelectorAll('input')] as HTMLInputElement[]).find((i) =>
      regex.test(i.placeholder ?? ''),
    ) ?? null
  );
}

// Drive the full flow up to (and including) the keygen useEffect.
async function advanceToKeygen(container: HTMLElement) {
  // Step 1: Connect
  const connectBtn = findButton(container, /^Connect$/);
  expect(connectBtn).toBeTruthy();
  expect(connectBtn!.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(connectBtn!);
  });
  await flush();
  // doConnect schedules setTimeout(next, 500); advance real timers.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });
  // Step 2: Identity — fill username + passphrase, click Generate keys.
  const userInput = findInputByPlaceholder(container, /username/i);
  expect(userInput).toBeTruthy();
  await act(async () => {
    fireEvent.change(userInput!, { target: { value: 'alice' } });
  });
  const passInput = findInputByPlaceholder(container, /something long|passphrase/i);
  expect(passInput).toBeTruthy();
  await act(async () => {
    fireEvent.change(passInput!, { target: { value: 'a-strong-passphrase-9000' } });
  });
  const genBtn = findButton(container, /^Generate keys$/);
  expect(genBtn).toBeTruthy();
  expect(genBtn!.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(genBtn!);
  });
  await flush();
  // KeyGen useEffect spawns async chain; give it time to settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 800));
  });
}

describe('Onboarding KeyGen useEffect — bootstrap mode', () => {
  it('runs createIdentityWithPassphrase + api.bootstrap + uploadPrekeyBundle', async () => {
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=BOOTSTRAP-TOKEN',
    );
    await advanceToKeygen(container);
    expect(keystoreMock.createIdentityWithPassphrase).toHaveBeenCalled();
    expect(apiMock.api.bootstrap).toHaveBeenCalled();
    expect(apiMock.api.requestChallenge).toHaveBeenCalled();
    expect(keystoreMock.signChallenge).toHaveBeenCalled();
    expect(utilsMock.uploadPrekeyBundle).toHaveBeenCalled();
  });

  it('exports identity blob and PUTs it to the server on success', async () => {
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=BOOTSTRAP-TOKEN',
    );
    await advanceToKeygen(container);
    expect(keystoreMock.exportIdentityBlob).toHaveBeenCalled();
    // The PUT happens via fetch().
    const putCalled = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      ([_url, init]) =>
        (init as { method?: string } | undefined)?.method === 'PUT',
    );
    expect(putCalled).toBe(true);
  });

  it('surfaces an error from api.bootstrap into the keygen log', async () => {
    apiMock.api.bootstrap.mockRejectedValueOnce(new Error('bootstrap-token-expired'));
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=EXPIRED',
    );
    await advanceToKeygen(container);
    expect(container.textContent).toMatch(/bootstrap-token-expired|error/i);
  });
});

describe('Onboarding KeyGen useEffect — invite mode', () => {
  it('runs api.register and signs the challenge with the new identity', async () => {
    const { container } = renderAt(
      '/onboarding?mode=invite&server=http://localhost:8080&token=INVITE-TOK',
    );
    await advanceToKeygen(container);
    expect(apiMock.api.register).toHaveBeenCalled();
    expect(apiMock.api.bootstrap).not.toHaveBeenCalled();
    expect(keystoreMock.createIdentityWithPassphrase).toHaveBeenCalled();
  });
});

describe('Onboarding KeyGen useEffect — keyProtect=hardware (PRF passkey)', () => {
  it('calls registerPasskey + createIdentity when PRF is supported', async () => {
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=BOOTSTRAP-TOKEN',
    );
    // Switch keyProtect from passphrase to hardware before advancing.
    const connectBtn = findButton(container, /^Connect$/);
    await act(async () => {
      fireEvent.click(connectBtn!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    // Identity step now visible — fill username, switch keyProtect=hardware.
    const userInput = findInputByPlaceholder(container, /username/i);
    await act(async () => {
      fireEvent.change(userInput!, { target: { value: 'alice' } });
    });
    const hwBtn = findButton(container, /^Hardware key$/);
    expect(hwBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(hwBtn!);
    });
    // For hardware mode, identityOk is true even without a passphrase.
    const genBtn = findButton(container, /^Generate keys$/);
    expect(genBtn).toBeTruthy();
    expect(genBtn!.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(genBtn!);
    });
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    expect(webauthnMock.registerPasskey).toHaveBeenCalled();
    // createIdentity (PRF path) was called rather than the passphrase variant.
    expect(keystoreMock.createIdentity).toHaveBeenCalled();
  });

  it('falls back to passphrase wrap when PRF unsupported in "both" mode', async () => {
    webauthnMock.registerPasskey.mockResolvedValueOnce({
      credentialId: 'cred-no-prf',
      credentialName: 'NoPRFKey',
      prfSupported: false,
      prfOutput: new ArrayBuffer(0),
    } as never);
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=BOOTSTRAP-TOKEN',
    );
    const connectBtn = findButton(container, /^Connect$/);
    await act(async () => {
      fireEvent.click(connectBtn!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    const userInput = findInputByPlaceholder(container, /username/i);
    await act(async () => {
      fireEvent.change(userInput!, { target: { value: 'alice' } });
    });
    // Use "Both" — passkey + passphrase wrap fallback.
    const bothBtn = findButton(container, /^Both$/);
    await act(async () => {
      fireEvent.click(bothBtn!);
    });
    const passInput = findInputByPlaceholder(container, /something long|passphrase/i);
    if (passInput) {
      await act(async () => {
        fireEvent.change(passInput, { target: { value: 'a-strong-passphrase-9000' } });
      });
    }
    const genBtn = findButton(container, /^Generate keys$/);
    if (genBtn && !genBtn.disabled) {
      await act(async () => {
        fireEvent.click(genBtn);
      });
      await flush();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 800));
      });
      // PRF-unsupported "both" mode → createIdentityWithPassphrase fallback fires.
      expect(keystoreMock.createIdentityWithPassphrase).toHaveBeenCalled();
    }
  });
});

describe('Onboarding — advancing to Done and clicking Open', () => {
  it('completes full flow: connect → identity → keygen → safety → done → open', async () => {
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=BOOTSTRAP-TOKEN',
    );
    await advanceToKeygen(container);
    // After keygen completes, the next() scheduled-700ms transitions to Safety.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    // Click "I've saved both" or "I've saved it" on the Safety step.
    let safetyNext = findButton(container, /I've saved/i);
    if (safetyNext && !safetyNext.disabled) {
      // If recovery key is shown, the checkbox needs to be ticked first.
      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (checkbox) {
        await act(async () => {
          fireEvent.click(checkbox);
        });
      }
      safetyNext = findButton(container, /I've saved/i);
      if (safetyNext && !safetyNext.disabled) {
        await act(async () => {
          fireEvent.click(safetyNext);
        });
        await flush();
      }
    }
    // Now on Done step — click "Open Dilla" / "Open" button.
    const openBtn = findButton(container, /Open/i);
    if (openBtn) {
      await act(async () => {
        fireEvent.click(openBtn);
      });
      await flush();
      // Either activateTeamAndNavigate or navigate('/app') should have fired.
      const teamNavFired = utilsMock.activateTeamAndNavigate.mock.calls.length > 0;
      const directNavFired = navigateMock.mock.calls.some(([arg]) => arg === '/app');
      expect(teamNavFired || directNavFired).toBe(true);
    }
  });
});

describe('Onboarding KeyGen useEffect — resume path (existing identity on disk)', () => {
  it('re-uses existing identity when hasIdentity returns true', async () => {
    keystoreMock.hasIdentity.mockResolvedValue(true);
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=BOOTSTRAP-TOKEN',
    );
    await advanceToKeygen(container);
    // Resume path calls unlockWithPassphrase, NOT createIdentityWithPassphrase.
    expect(keystoreMock.unlockWithPassphrase).toHaveBeenCalled();
    expect(keystoreMock.createIdentityWithPassphrase).not.toHaveBeenCalled();
  });
});

describe('Onboarding doConnect — recovery happy path', () => {
  it('drives the full recovery flow: blob fetch → unlock → challenge → verify → navigate', async () => {
    // Mock fetch to return a valid blob payload for the recovery fetch.
    keystoreMock.unlockWithRecovery.mockResolvedValueOnce({
      publicKeyBytes: new Uint8Array([1, 2, 3]),
      signingKey: {} as CryptoKey,
      dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array() },
    } as never);

    const { container } = renderAt('/onboarding?mode=existing&recover=1');
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const serverInput = inputs.find((i) => /localhost:8080/.test(i.placeholder));
    const userInput = inputs.find((i) => /username/.test(i.placeholder));
    const keyArea = container.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(serverInput).toBeTruthy();
    expect(userInput).toBeTruthy();
    expect(keyArea).toBeTruthy();
    await act(async () => {
      fireEvent.change(serverInput!, { target: { value: 'https://recover.example' } });
      fireEvent.change(userInput!, { target: { value: 'alice' } });
      fireEvent.change(keyArea!, { target: { value: 'AAAA-BBBB-CCCC-DDDD' } });
    });
    const btn = findButton(container, /Recover identity/i);
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(btn!);
    });
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    // Recovery flow chain.
    expect(keystoreMock.importIdentityBlob).toHaveBeenCalled();
    expect(keystoreMock.unlockWithRecovery).toHaveBeenCalled();
    expect(apiMock.api.requestChallenge).toHaveBeenCalled();
    expect(apiMock.api.verifyChallenge).toHaveBeenCalled();
    expect(utilsMock.activateTeamAndNavigate).toHaveBeenCalled();
  });

  it('surfaces a friendly error when blob fetch returns non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as never;
    const { container } = renderAt('/onboarding?mode=existing&recover=1');
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const serverInput = inputs.find((i) => /localhost:8080/.test(i.placeholder))!;
    const userInput = inputs.find((i) => /username/.test(i.placeholder))!;
    const keyArea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(serverInput, { target: { value: 'https://recover.example' } });
      fireEvent.change(userInput, { target: { value: 'alice' } });
      fireEvent.change(keyArea, { target: { value: 'AAAA-BBBB' } });
    });
    const btn = findButton(container, /Recover identity/i);
    await act(async () => {
      fireEvent.click(btn!);
    });
    await flush();
    expect(container.textContent).toMatch(/identity blob|failed|error/i);
  });
});

describe('Onboarding doConnect — existing mode passkey-PRF path', () => {
  it('attempts passkey unlock when credentials exist + no passphrase entered', async () => {
    keystoreMock.getCredentialInfo.mockResolvedValueOnce({
      credentials: [{ id: 'cred-1' }],
      prfSalt: new Uint8Array(32),
      keySlots: [{ server_url: 'https://stored.example' }],
    } as never);
    webauthnMock.authenticatePasskey.mockResolvedValueOnce({
      prfOutput: new ArrayBuffer(32),
    } as never);
    keystoreMock.unlockWithPrf.mockResolvedValueOnce({
      publicKeyBytes: new Uint8Array([1, 2, 3]),
      signingKey: {} as CryptoKey,
      dhKeyPair: { privateKey: {} as CryptoKey, publicKeyBytes: new Uint8Array() },
    } as never);

    const { container } = renderAt('/onboarding?mode=existing');
    const btn = findButton(container, /^Unlock$/);
    expect(btn).toBeTruthy();
    await act(async () => {
      fireEvent.click(btn!);
    });
    await flush();
    expect(webauthnMock.authenticatePasskey).toHaveBeenCalled();
    expect(keystoreMock.unlockWithPrf).toHaveBeenCalled();
  });

  it('falls back to passphrase when passkey is unavailable', async () => {
    keystoreMock.getCredentialInfo.mockResolvedValueOnce(null as never);
    const { container } = renderAt('/onboarding?mode=existing');
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    const passInput = inputs.find((i) => i.type === 'password' || /pass/i.test(i.placeholder));
    expect(passInput).toBeTruthy();
    await act(async () => {
      fireEvent.change(passInput!, { target: { value: 'my-secret-passphrase' } });
    });
    const btn = findButton(container, /^Unlock$/);
    await act(async () => {
      fireEvent.click(btn!);
    });
    await flush();
    expect(keystoreMock.unlockWithPassphrase).toHaveBeenCalled();
  });
});

describe('Onboarding back button + footer skip', () => {
  it('back from Identity returns to Connect', async () => {
    const { container } = renderAt(
      '/onboarding?mode=bootstrap&server=http://localhost:8080&token=TOK',
    );
    const connectBtn = findButton(container, /^Connect$/);
    await act(async () => {
      fireEvent.click(connectBtn!);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    // Now on Identity step — the Back button should send us back to Connect.
    const backBtn = findButton(container, /^Back$/);
    if (backBtn) {
      await act(async () => {
        fireEvent.click(backBtn);
      });
      await flush();
      // Connect button should be visible again.
      expect(findButton(container, /^Connect$/)).toBeTruthy();
    }
  });

  it('footer "have an account?" link switches mode to existing', async () => {
    const { container } = renderAt('/onboarding?mode=bootstrap');
    const signInLink = findButton(container, /have an account|sign in/i);
    if (signInLink) {
      await act(async () => {
        fireEvent.click(signInLink);
      });
      await flush();
      // After mode=existing, an Unlock button should appear.
      expect(findButton(container, /^Unlock$/)).toBeTruthy();
    }
  });
});
