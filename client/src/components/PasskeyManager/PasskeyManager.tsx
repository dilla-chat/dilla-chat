import { useState, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import {
  registerPasskey,
  prfOutputToBase64,
  encodeRecoveryKey,
} from '../../services/webauthn';
import {
  getCredentialInfo,
  exportIdentityBlob,
  encodeRecoveryKey as encodeRecoveryKeyKS,
  generateRecoveryKey as generateRecoveryKeyBytes,
} from '../../services/keyStore';
import './PasskeyManager.css';

interface CredentialInfo {
  credentials: { id: string; name: string; created_at: string }[];
  prfSalt: Uint8Array;
}

export default function PasskeyManager() {
  const { derivedKey, setCredentialIds } = useAuthStore();
  const [credInfo, setCredInfo] = useState<CredentialInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [newRecoveryKey, setNewRecoveryKey] = useState('');

  const loadCredentials = async () => {
    try {
      const info = await getCredentialInfo();
      if (info) {
        setCredInfo(info);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadCredentials();
  }, []);

  const handleAddPasskey = async () => {
    if (!credInfo || !credInfo.prfSalt || !derivedKey) return;
    setError('');
    setLoading(true);

    try {
      const username = localStorage.getItem('slimcord_username') ?? 'user';
      const userId = new TextEncoder().encode(username.padEnd(32, '\0').slice(0, 32));

      const result = await registerPasskey(username, userId, credInfo.prfSalt);
      const newDerivedKey = prfOutputToBase64(result.prfOutput);
      void newDerivedKey;

      const updated = [
        ...credInfo.credentials,
        { id: result.credentialId, name: result.credentialName, created_at: String(Date.now()) },
      ];

      setCredInfo({ ...credInfo, credentials: updated });
      setCredentialIds(updated.map((c) => c.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerateRecovery = async () => {
    setError('');
    try {
      // Generate new recovery key and re-encode for display
      // Note: A full implementation would re-wrap the MEK with the new recovery key
      const newKey = generateRecoveryKeyBytes();
      setNewRecoveryKey(encodeRecoveryKeyKS(newKey));
      setShowRecoveryKey(true);

      // Re-upload identity blob to all known servers
      const blob = await exportIdentityBlob();
      if (!blob) return;
      const { teams } = useAuthStore.getState();
      const allServers: string[] = [];
      teams.forEach((entry) => {
        if (entry.baseUrl) allServers.push(entry.baseUrl);
      });
      for (const [, entry] of teams.entries()) {
        if (!entry.baseUrl || !entry.token) continue;
        try {
          await fetch(`${entry.baseUrl}/api/v1/identity/blob`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${entry.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ blob, servers: allServers }),
          });
        } catch (e) {
          console.warn(`Blob upload to ${entry.baseUrl} failed:`, e);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  if (!credInfo) return null;

  return (
    <div className="passkey-manager">
      <h3>Passkey Management</h3>

      <div className="passkey-manager-list">
        {credInfo.credentials.length === 0 ? (
          <p className="passkey-manager-empty">No passkeys registered</p>
        ) : (
          credInfo.credentials.map((cred, i) => (
            <div key={cred.id || i} className="passkey-manager-item">
              <span className="passkey-manager-item-name">{cred.name || 'Passkey'}</span>
              <span className="passkey-manager-item-id">
                {cred.id?.slice(0, 12)}...
              </span>
            </div>
          ))
        )}
      </div>

      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}

      <div className="passkey-manager-actions">
        <button onClick={handleAddPasskey} disabled={loading}>
          {loading ? 'Adding...' : 'Add Another Passkey'}
        </button>
        <button
          onClick={handleRegenerateRecovery}
          style={{ background: 'transparent', border: '1px solid var(--divider)' }}
        >
          Regenerate Recovery Key
        </button>
      </div>

      {showRecoveryKey && newRecoveryKey && (
        <div className="passkey-manager-recovery">
          <p><strong>New Recovery Key:</strong></p>
          <code>{newRecoveryKey}</code>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(newRecoveryKey);
            }}
            style={{ marginTop: 8 }}
          >
            Copy to Clipboard
          </button>
        </div>
      )}
    </div>
  );
}
