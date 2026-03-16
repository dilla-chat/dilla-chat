import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './PublicShell.css';

interface PublicShellProps {
  children: ReactNode;
  /** Optional step indicator: [current, total] */
  steps?: [number, number];
}

export default function PublicShell({ children, steps }: PublicShellProps) {
  const { t } = useTranslation();

  return (
    <div className="public-shell">
      <div className="public-brand" data-tauri-drag-region>
        <img src="/brand/logo.svg" alt="Dilla" className="public-brand-logo" />
        <h2 className="public-brand-tagline">Dilla</h2>
        <p className="public-brand-subtitle">
          {t('welcome.subtitle', 'A federated, end-to-end encrypted team chat')}
        </p>
        <div className="public-brand-pills">
          <span className="public-brand-pill">{t('brand.featureE2E')}</span>
          <span className="public-brand-pill">{t('brand.featureSelfHosted')}</span>
          <span className="public-brand-pill">{t('brand.featureFederated')}</span>
        </div>
      </div>

      <div className="public-content">
        <div className="public-card">
          <div className="public-mobile-header">
            <img src="/brand/icon.svg" alt="Dilla" />
            <span>Dilla</span>
          </div>

          {steps && (
            <div className="public-steps">
              {Array.from({ length: steps[1] }, (_, i) => (
                <div
                  key={i}
                  className={`public-step-dot${i + 1 === steps[0] ? ' active' : ''}${i + 1 < steps[0] ? ' completed' : ''}`}
                />
              ))}
            </div>
          )}

          {children}
        </div>
      </div>
    </div>
  );
}
