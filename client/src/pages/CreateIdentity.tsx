import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import {
  registerPasskey,
  prfOutputToBase64,
  encodeRecoveryKey,
} from '../services/webauthn';
import { initCrypto } from '../services/crypto';
import {
  createIdentity,
  generatePrfSalt,
  encodeRecoveryKey as encodeRecoveryKeyKS,
} from '../services/keyStore';
import { fromBase64 } from '../services/cryptoCore';

export default function CreateIdentity() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setDerivedKey, setPublicKey } = useAuthStore();

  const hasPendingInvite = !!sessionStorage.getItem('pendingInviteToken');
  const [serverAddress, setServerAddress] = useState(
    hasPendingInvite ? window.location.origin : '',
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'form' | 'recovery' | 'done'>('form');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [publicKeyFingerprint, setPublicKeyFingerprint] = useState('');

  const handleCreateWithPasskey = async () => {
    setError('');
    if (!serverAddress) return;

    setLoading(true);
    try {
      // Construct server URL
      const serverUrl = serverAddress.startsWith('http')
        ? serverAddress.replace(/\/$/, '')
        : `https://${serverAddress}`;
      localStorage.setItem('slimcord_auth_server', serverUrl);

      // Generate PRF salt for this identity
      const prfSalt = generatePrfSalt();

      // Register passkey with WebAuthn + PRF
      const username = 'user'; // Will be set during JoinTeam
      const userId = new TextEncoder().encode(username.padEnd(32, '\0').slice(0, 32));
      const passkeyResult = await registerPasskey(username, userId, prfSalt, serverUrl);
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

  const handleContinue = () => {
    setStep('done');
  };

  if (step === 'done') {
    const pendingToken = sessionStorage.getItem('pendingInviteToken');
    const joinPath = pendingToken ? `/join/${pendingToken}` : '/join';
    if (pendingToken) {
      sessionStorage.removeItem('pendingInviteToken');
    }
    return (
      <div className="page create-identity-page" data-tauri-drag-region>
        <img src="/logo.png" alt="Slimcord" style={{ width: 64, height: 64, marginBottom: 8 }} />
        <h1>✓ {t('identity.create')}</h1>
        <p>{t('identity.publicKeyLabel')}:</p>
        <code>{publicKeyFingerprint}</code>
        <div className="form">
          <button className="btn-primary" onClick={() => navigate(joinPath)}>{t('auth.joinTeam')}</button>
          <button className="btn-secondary" onClick={() => navigate('/setup')}>{t('setup.title')}</button>
          <button className="btn-link" onClick={() => navigate('/app')}>
            {t('common.skipForNow', 'Skip for now')}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'recovery') {
    return (
      <div className="page create-identity-page" data-tauri-drag-region>
        <img src="/logo.png" alt="Slimcord" style={{ width: 64, height: 64, marginBottom: 8 }} />
        <h1>🔑 {t('identity.recoveryKeyTitle')}</h1>
        <p style={{ opacity: 0.8, maxWidth: 400 }}>{t('identity.recoveryKeyDesc')}</p>
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
            maxWidth: 400,
            margin: '16px 0',
            userSelect: 'all',
          }}
        >
          {recoveryKey}
        </div>
        <button className="btn-secondary" onClick={handleCopyRecovery} style={{ marginBottom: 12 }}>
          {copied ? t('identity.recoveryKeyCopied') : t('identity.recoveryKeyCopy')}
        </button>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 16,
            cursor: 'pointer',
          }}
        >
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
      </div>
    );
  }

  return (
    <div className="page create-identity-page" data-tauri-drag-region>
      <img src="/logo.png" alt="Slimcord" style={{ width: 64, height: 64, marginBottom: 8 }} />
      <h1>{t('welcome.createIdentity')}</h1>
      <p style={{ opacity: 0.7, maxWidth: 400 }}>{t('identity.passkeyPrompt')}</p>
      {error && <p className="error">{error}</p>}
      <div className="form">
        {!hasPendingInvite && (
          <input
            type="text"
            placeholder={t('identity.serverAddress', 'Server address (e.g. slimcord.example.com)')}
            value={serverAddress}
            onChange={(e) => setServerAddress(e.target.value)}
          />
        )}
        <button className="btn-primary" onClick={handleCreateWithPasskey} disabled={loading || !serverAddress.trim()}>
          {loading
            ? t('identity.openingBrowser', 'Opening browser for passkey setup...')
            : t('identity.createWithPasskey')}
        </button>
        <button className="btn-link" onClick={() => navigate('/welcome')} disabled={loading}>
          ← {t('common.back', 'Back')}
        </button>
      </div>
    </div>
  );
}
