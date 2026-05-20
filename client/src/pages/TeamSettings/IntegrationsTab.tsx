// Team Settings → Integrations. Currently just the Giphy API key, which
// is stored server-side under team:<tid>:giphy_api_key and used by
// /api/v1/teams/<tid>/gif (the proxy the /giphy slash command hits).
//
// The GET endpoint never returns the key — it returns {configured: bool}
// so we can show a status pill without leaking the secret to any team
// member that hits the integrations page. Writes require admin perms;
// the server enforces this, and we let the 403 bubble up.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

export default function IntegrationsTab({ teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getGiphyIntegration(teamId)
      .then((res) => { if (!cancelled) setConfigured(res.configured); })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [teamId]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.setGiphyApiKey(teamId, apiKey);
      setConfigured(res.configured);
      setApiKey('');
      setMsg({ kind: 'ok', text: res.configured ? t('integrations.giphy.saved', 'Saved.') : t('integrations.giphy.cleared', 'Cleared.') });
    } catch (e) {
      const text = (e as Error).message || t('integrations.giphy.failed', 'Save failed — admin permission required.');
      setMsg({ kind: 'err', text });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setMsg(null);
    try {
      await api.setGiphyApiKey(teamId, '');
      setConfigured(false);
      setApiKey('');
      setMsg({ kind: 'ok', text: t('integrations.giphy.cleared', 'Cleared.') });
    } catch (e) {
      const text = (e as Error).message || t('integrations.giphy.failed', 'Save failed — admin permission required.');
      setMsg({ kind: 'err', text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="heading-3">{t('settings.integrations', 'Integrations')}</h2>

      <div className="settings-field">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label className="micro" style={{ margin: 0 }}>{t('integrations.giphy', 'Giphy API key')}</label>
          {configured !== null && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.625rem',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                padding: '0.125rem 0.5rem',
                borderRadius: '999px',
                background: configured ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: configured ? 'var(--accent)' : 'var(--fg-3)',
                border: '1px solid ' + (configured ? 'color-mix(in oklab, var(--accent) 40%, transparent)' : 'var(--hairline)'),
              }}
            >
              {configured ? t('integrations.configured', 'configured') : t('integrations.notConfigured', 'not configured')}
            </span>
          )}
        </div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={configured ? t('integrations.giphy.placeholderUpdate', 'paste a new key to replace') : t('integrations.giphy.placeholderSet', 'paste your Giphy API key')}
          autoComplete="off"
        />
        <p className="micro" style={{ color: 'var(--fg-3)', marginTop: '0.375rem' }}>
          {t(
            'integrations.giphy.help',
            'Used by the /giphy slash command. Create a key at developers.giphy.com. The key is stored server-side and never sent to clients.',
          )}
        </p>
      </div>

      {msg && (
        <p className="micro" style={{ color: msg.kind === 'ok' ? 'var(--ok)' : 'var(--danger)' }}>{msg.text}</p>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button className="btn-primary" disabled={busy || !apiKey.trim()} onClick={save}>
          {busy ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
        </button>
        {configured && (
          <button className="btn-secondary" disabled={busy} onClick={clear}>
            {t('integrations.giphy.clear', 'Clear key')}
          </button>
        )}
      </div>
    </div>
  );
}
