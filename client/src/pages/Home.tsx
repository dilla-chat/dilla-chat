import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Lock, Server, NetworkRight, Phone, Fingerprint, ChatBubble } from 'iconoir-react';
import './Home.css';

const GITHUB_URL = 'https://github.com/dilla-io/dilla';

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="landing">
      {/* Hero */}
      <section className="landing-hero">
        <img src="/brand/logo.svg" alt="Dilla" className="landing-hero-logo" />
        <h1 className="landing-hero-headline">{t('landing.hero.headline')}</h1>
        <p className="landing-hero-pronunciation">{t('landing.hero.pronunciation')}</p>
        <p className="landing-hero-explanation">{t('landing.hero.explanation')}</p>
        <div className="landing-hero-ctas">
          <button className="btn-primary" onClick={() => navigate('/create-identity')}>
            {t('landing.hero.getStarted')}
          </button>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            {t('landing.hero.viewGithub')}
          </a>
        </div>
        <div className="landing-scroll-indicator" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </section>

      {/* Problem/Solution Strip */}
      <section className="landing-problems">
        <div className="landing-problems-grid">
          <div className="landing-problem-item">
            <Lock className="landing-problem-icon" />
            <h3 className="landing-problem-title">{t('landing.features.encryption.title')}</h3>
            <p className="landing-problem-desc">{t('landing.features.encryption.desc')}</p>
          </div>
          <div className="landing-problem-item">
            <Server className="landing-problem-icon" />
            <h3 className="landing-problem-title">{t('landing.features.selfHosted.title')}</h3>
            <p className="landing-problem-desc">{t('landing.features.selfHosted.desc')}</p>
          </div>
          <div className="landing-problem-item">
            <NetworkRight className="landing-problem-icon" />
            <h3 className="landing-problem-title">{t('landing.features.federation.title')}</h3>
            <p className="landing-problem-desc">{t('landing.features.federation.desc')}</p>
          </div>
        </div>
      </section>

      {/* Feature Showcase */}
      <section className="landing-features">
        <div className="landing-feature-row">
          <div className="landing-feature-text">
            <h2 className="landing-feature-title">{t('landing.voice.title')}</h2>
            <p className="landing-feature-desc">{t('landing.voice.desc')}</p>
          </div>
          <div className="landing-feature-visual">
            <Phone className="landing-feature-visual-icon" />
          </div>
        </div>

        <div className="landing-feature-row reverse">
          <div className="landing-feature-text">
            <h2 className="landing-feature-title">{t('landing.auth.title')}</h2>
            <p className="landing-feature-desc">{t('landing.auth.desc')}</p>
          </div>
          <div className="landing-feature-visual">
            <Fingerprint className="landing-feature-visual-icon" />
          </div>
        </div>

        <div className="landing-feature-row">
          <div className="landing-feature-text">
            <h2 className="landing-feature-title">{t('landing.channels.title')}</h2>
            <p className="landing-feature-desc">{t('landing.channels.desc')}</p>
          </div>
          <div className="landing-feature-visual">
            <ChatBubble className="landing-feature-visual-icon" />
          </div>
        </div>
      </section>

      {/* Technical Highlights */}
      <section className="landing-tech">
        <h2 className="landing-tech-title">Built for the paranoid</h2>
        <div className="landing-tech-grid">
          {[
            { label: 'Signal Protocol', text: t('landing.tech.signal') },
            { label: 'Single Binary', text: t('landing.tech.binary') },
            { label: 'Desktop App', text: t('landing.tech.desktop') },
            { label: 'Permissions', text: t('landing.tech.permissions') },
            { label: 'Observability', text: t('landing.tech.otel') },
            { label: 'License', text: t('landing.tech.license') },
          ].map((card) => (
            <div className="landing-tech-card" key={card.label}>
              <div className="landing-tech-card-label">{card.label}</div>
              <p className="landing-tech-card-text">{card.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="landing-cta">
        <h2 className="landing-cta-headline">{t('landing.cta.headline')}</h2>
        <p className="landing-cta-subline">{t('landing.cta.subline')}</p>
        <div className="landing-cta-code">
          docker run -p 8080:8080 ghcr.io/dilla-io/dilla:latest
        </div>
        <div className="landing-cta-buttons">
          <button className="btn-primary" onClick={() => navigate('/create-identity')}>
            {t('landing.cta.createIdentity')}
          </button>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            {t('landing.cta.readDocs')}
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <img src="/brand/wordmark.svg" alt="Dilla" className="landing-footer-wordmark" />
        <div className="landing-footer-links">
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">Documentation</a>
          <a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">AGPLv3</a>
        </div>
        <p className="landing-footer-tagline">{t('landing.footer.madeIn')}</p>
      </footer>
    </div>
  );
}
