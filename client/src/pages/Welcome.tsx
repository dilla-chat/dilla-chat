import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

export default function Welcome() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="page welcome-page" data-tauri-drag-region>
      <img src="/logo.png" alt="Slimcord" style={{ width: 80, height: 80, marginBottom: 8 }} />
      <h1>{t('welcome.title')}</h1>
      <p>{t('welcome.subtitle')}</p>
      <div className="button-group">
        <button className="btn-primary" onClick={() => navigate('/create-identity')}>
          {t('welcome.createIdentity')}
        </button>
        <button className="btn-secondary" onClick={() => navigate('/login')}>
          {t('welcome.restoreBackup')}
        </button>
        <button className="btn-secondary" onClick={() => navigate('/recover')}>
          {t('welcome.recoverFromServer', 'Recover from Server')}
        </button>
      </div>
    </div>
  );
}
