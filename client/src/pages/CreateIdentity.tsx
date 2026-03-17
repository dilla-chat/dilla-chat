import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import {
  registerPasskey,
  prfOutputToBase64,
} from '../services/webauthn';
import { initCrypto } from '../services/crypto';
import {
  createIdentity,
  createIdentityWithPassphrase,
  generatePrfSalt,
  encodeRecoveryKey as encodeRecoveryKeyKS,
} from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';
import type { PasskeyRegistrationResult } from '../services/webauthn';
import PublicShell from './PublicShell';

export default function CreateIdentity() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setDerivedKey, setPublicKey } = useAuthStore();

  const hasPendingInvite = !!sessionStorage.getItem('pendingInviteToken');
  const isBrowser = !(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  const [serverAddress, setServerAddress] = useState(
    hasPendingInvite || isBrowser ? window.location.origin : '',
  );
  const [username, setUsername] = useState(localStorage.getItem('dilla_username') ?? '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'form' | 'passphrase' | 'recovery' | 'done'>('form');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [publicKeyFingerprint, setPublicKeyFingerprint] = useState('');
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [pendingPasskeyResult, setPendingPasskeyResult] = useState<PasskeyRegistrationResult | null>(null);

  const handleCreateWithPasskey = async () => {
    setError('');
    if (!serverAddress || !username.trim()) return;

    setLoading(true);
    try {
      // Construct server URL
      const serverUrl = serverAddress.startsWith('http')
        ? serverAddress.replace(/\/$/, '')
        : `https://${serverAddress}`;
      localStorage.setItem('dilla_auth_server', serverUrl);

      // Generate PRF salt for this identity
      const prfSalt = generatePrfSalt();

      // Register passkey with WebAuthn + PRF
      const displayName = username.trim();
      localStorage.setItem('dilla_username', displayName);
      const userId = new TextEncoder().encode(displayName.padEnd(32, '\0').slice(0, 32));
      const passkeyResult = await registerPasskey(displayName, userId, prfSalt, serverUrl);

      if (!passkeyResult.prfSupported) {
        // PRF not available — need passphrase to protect encryption keys
        setPendingPasskeyResult(passkeyResult);
        setNeedsPassphrase(true);
        setStep('passphrase');
        return;
      }

      const derivedKeyB64 = prfOutputToBase64(passkeyResult.prfOutput);
      const prfKey = fromBase64(derivedKeyB64);

      // Create identity in IndexedDB
      const credentials = [{
        id: passkeyResult.credentialId,
        name: passkeyResult.credentialName,
        created_at: new Date().toISOString(),
      }];
      const { publicKeyB64, publicKeyHex, recoveryKey: recoveryKeyBytes, identity } = await createIdentity(
        serverUrl,
        prfKey,
        prfSalt,
        credentials,
      );

      // Initialize crypto service
      await initCrypto(identity, derivedKeyB64);

      setPublicKey(publicKeyB64);
      setPublicKeyFingerprint(publicKeyHex.slice(0, 16) + '...');
      setDerivedKey(derivedKeyB64);

      // Format recovery key for display
      setRecoveryKey(encodeRecoveryKeyKS(recoveryKeyBytes));
      setStep('recovery');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRecovery = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handlePassphraseSubmit = async () => {
    if (!pendingPasskeyResult || passphrase.length < 12 || passphrase !== passphraseConfirm) return;
    setError('');
    setLoading(true);
    try {
      const serverUrl = localStorage.getItem('dilla_auth_server') || '';
      const credentials = [{
        id: pendingPasskeyResult.credentialId,
        name: pendingPasskeyResult.credentialName,
        created_at: new Date().toISOString(),
      }];
      const { publicKeyB64, publicKeyHex, recoveryKey: recoveryKeyBytes, identity } =
        await createIdentityWithPassphrase(serverUrl, passphrase, credentials);

      await initCrypto(identity, publicKeyB64);

      setPublicKey(publicKeyB64);
      setPublicKeyFingerprint(publicKeyHex.slice(0, 16) + '...');
      setDerivedKey(publicKeyB64);

      setRecoveryKey(encodeRecoveryKeyKS(recoveryKeyBytes));
      setStep('recovery');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    setStep('done');
  };

  const passphraseValid = passphrase.length >= 12 && passphrase === passphraseConfirm;
  const totalSteps = needsPassphrase ? 4 : 3;
  const stepNumber =
    step === 'form' ? 1 : step === 'passphrase' ? 2 : step === 'recovery' ? (needsPassphrase ? 3 : 2) : totalSteps;

  if (step === 'done') {
    const pendingToken = sessionStorage.getItem('pendingInviteToken');
    const joinPath = pendingToken ? `/join/${pendingToken}` : '/join';
    if (pendingToken) {
      sessionStorage.removeItem('pendingInviteToken');
    }
    return (
      <PublicShell steps={[totalSteps, totalSteps]}>
        <h1>{t('identity.create')}</h1>
        <p>{t('identity.publicKeyLabel')}:</p>
        <code>{publicKeyFingerprint}</code>
        <div className="form">
          <button className="btn-primary" onClick={() => navigate(joinPath)}>{t('auth.joinTeam')}</button>
          <button className="btn-secondary" onClick={() => navigate('/setup')}>{t('setup.title')}</button>
          <button className="btn-link" onClick={() => navigate('/app')}>
            {t('common.skipForNow', 'Skip for now')}
          </button>
        </div>
      </PublicShell>
    );
  }

  if (step === 'passphrase') {
    return (
      <PublicShell steps={[stepNumber, totalSteps]}>
        <h1>{t('identity.passphraseTitle', 'Set a Passphrase')}</h1>
        <p style={{ opacity: 0.8 }}>
          {t(
            'identity.passphraseExplain',
            "Your passkey provider doesn't support key derivation (PRF). Choose a passphrase to protect your encryption keys.",
          )}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="form">
          <input
            type="password"
            placeholder={t('identity.passphrase', 'Passphrase')}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            placeholder={t('identity.confirm', 'Confirm Passphrase')}
            value={passphraseConfirm}
            onChange={(e) => setPassphraseConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && passphraseValid && handlePassphraseSubmit()}
          />
          {passphrase.length > 0 && passphrase.length < 12 && (
            <p style={{ color: 'var(--text-danger)', fontSize: '0.85rem', margin: '4px 0' }}>
              {t('identity.passphraseTooShort', 'Minimum 12 characters')}
            </p>
          )}
          {passphrase.length >= 12 && passphraseConfirm.length > 0 && passphrase !== passphraseConfirm && (
            <p style={{ color: 'var(--text-danger)', fontSize: '0.85rem', margin: '4px 0' }}>
              {t('identity.passphraseNoMatch')}
            </p>
          )}
          <button
            className="btn-primary"
            onClick={handlePassphraseSubmit}
            disabled={loading || !passphraseValid}
          >
            {loading ? t('identity.creating') : t('identity.continue')}
          </button>
        </div>
      </PublicShell>
    );
  }

  if (step === 'recovery') {
    return (
      <PublicShell steps={[stepNumber, totalSteps]}>
        <h1>{t('identity.recoveryKeyTitle')}</h1>
        <p style={{ opacity: 0.8 }}>{t('identity.recoveryKeyDesc')}</p>
        <div
          style={{
            background: 'var(--input-bg)',
            border: '1px solid var(--divider)',
            borderRadius: 8,
            padding: '16px 20px',
            fontFamily: 'monospace',
            fontSize: '0.95rem',
            letterSpacing: '0.05em',
            wordBreak: 'break-all',
            margin: '16px 0',
            userSelect: 'all',
          }}
        >
          {recoveryKey}
        </div>
        <button className="btn-secondary" onClick={handleCopyRecovery} style={{ marginBottom: 12 }}>
          {copied ? t('identity.recoveryKeyCopied') : t('identity.recoveryKeyCopy')}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={recoveryConfirmed}
            onChange={(e) => setRecoveryConfirmed(e.target.checked)}
          />
          {t('identity.recoveryKeyConfirm')}
        </label>
        <button className="btn-primary" onClick={handleContinue} disabled={!recoveryConfirmed}>
          {t('identity.continue')}
        </button>
      </PublicShell>
    );
  }

  return (
    <PublicShell steps={[stepNumber, totalSteps]}>
      <h1>{t('welcome.createIdentity')}</h1>
      <p style={{ opacity: 0.7 }}>{t('identity.passkeyPrompt')}</p>
      {error && <p className="error">{error}</p>}
      <div className="form">
        <input
          type="text"
          placeholder={t('identity.username', 'Username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreateWithPasskey()}
          autoFocus
        />
        {!hasPendingInvite && !isBrowser && (
          <input
            type="text"
            placeholder={t('identity.serverAddress', 'Server address (e.g. dilla.example.com)')}
            value={serverAddress}
            onChange={(e) => setServerAddress(e.target.value)}
          />
        )}
        <button className="btn-primary" onClick={handleCreateWithPasskey} disabled={loading || !serverAddress.trim() || !username.trim()}>
          {loading
            ? t('identity.openingBrowser', 'Opening browser for passkey setup...')
            : t('identity.createWithPasskey')}
        </button>
        <button className="btn-link" onClick={() => navigate('/')} disabled={loading}>
          ← {t('common.back', 'Back')}
        </button>
      </div>
    </PublicShell>
  );
}
