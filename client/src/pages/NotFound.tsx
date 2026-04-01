import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './NotFound.css';

export default function NotFound() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="not-found">
      <h1>404</h1>
      <p>{t('errors.notFound', 'This page doesn\'t exist.')}</p>
      <button className="btn-primary" onClick={() => navigate('/')}>
        {t('common.goHome', 'Go Home')}
      </button>
    </div>
  );
}
