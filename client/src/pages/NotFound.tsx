import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function NotFound() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-screen p-2xl bg-surface text-foreground-primary text-center">
      <h1 className="text-[4rem] font-display m-0">404</h1>
      <p className="text-foreground-muted mb-xl">{t('errors.notFound', 'This page doesn\'t exist.')}</p>
      <button className="btn-primary" onClick={() => navigate('/')}>
        {t('common.goHome', 'Go Home')}
      </button>
    </div>
  );
}
