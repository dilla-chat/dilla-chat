import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface PublicShellProps {
  children: ReactNode;
  /** Optional step indicator: [current, total] */
  steps?: [number, number];
}

export default function PublicShell({ children, steps }: Readonly<PublicShellProps>) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full h-screen overflow-hidden max-md:flex-col">
      <div
        className="w-[45%] h-full relative flex flex-col items-center justify-center p-12 overflow-hidden bg-surface-secondary max-md:hidden"
        data-tauri-drag-region
      >
        <div className="public-brand-gradient absolute inset-0 pointer-events-none opacity-30" />
        <img
          src="/brand/logo.svg"
          alt="Dilla"
          className="relative z-1 w-[72px] h-[72px] mb-5 drop-shadow-[0_0_20px_var(--brand-alpha-25)]"
        />
        <h2 className="relative z-1 font-display text-[1.3rem] text-foreground-primary m-0 mb-2 text-center">
          Dilla
        </h2>
        <p className="relative z-1 text-[0.9rem] text-foreground-muted m-0 text-center">
          {t('welcome.subtitle', 'A federated, end-to-end encrypted team chat')}
        </p>
        <div className="relative z-1 flex gap-3 flex-wrap justify-center mt-auto pt-8">
          <span className="text-[0.78rem] font-medium text-foreground-secondary bg-glass border border-glass-border rounded-full px-4 py-1.5 backdrop-blur-sm whitespace-nowrap">
            {t('brand.featureE2E')}
          </span>
          <span className="text-[0.78rem] font-medium text-foreground-secondary bg-glass border border-glass-border rounded-full px-4 py-1.5 backdrop-blur-sm whitespace-nowrap">
            {t('brand.featureSelfHosted')}
          </span>
          <span className="text-[0.78rem] font-medium text-foreground-secondary bg-glass border border-glass-border rounded-full px-4 py-1.5 backdrop-blur-sm whitespace-nowrap">
            {t('brand.featureFederated')}
          </span>
        </div>
      </div>

      <div className="w-[55%] flex items-center justify-center p-8 bg-surface overflow-y-auto max-md:w-full max-md:min-h-screen max-md:p-6">
        <div
          className={[
            'w-full max-w-[420px] bg-glass border border-glass-border rounded-2xl px-8 py-10 backdrop-blur-md shadow-glass overflow-hidden',
            'max-md:max-w-none max-md:bg-transparent max-md:border-none max-md:shadow-none max-md:backdrop-blur-none max-md:px-0 max-md:py-6',
            '[&>*]:max-w-full [&>*]:box-border',
            '[&_h1]:text-2xl [&_h1]:font-display [&_h1]:text-foreground-primary [&_h1]:m-0 [&_h1]:mb-1 [&_h1]:text-center',
            '[&_.form]:max-w-none',
            '[&_.form_input]:rounded-[10px] [&_.form_input]:transition-[border-color,box-shadow] [&_.form_input]:duration-200',
            '[&_.form_textarea]:rounded-[10px] [&_.form_textarea]:transition-[border-color,box-shadow] [&_.form_textarea]:duration-200',
            '[&_.form_input:focus]:border-[var(--brand-500)] [&_.form_input:focus]:shadow-[0_0_0_3px_var(--brand-alpha-15)] [&_.form_input:focus]:outline-none',
            '[&_.form_textarea:focus]:border-[var(--brand-500)] [&_.form_textarea:focus]:shadow-[0_0_0_3px_var(--brand-alpha-15)] [&_.form_textarea:focus]:outline-none',
            '[&_.btn-primary:hover:not(:disabled)]:-translate-y-px [&_.btn-primary:active:not(:disabled)]:translate-y-0',
            'motion-reduce:[&_.btn-primary:hover:not(:disabled)]:translate-y-0',
            '[&_.error]:text-center',
          ].join(' ')}
        >
          <div className="hidden max-md:flex items-center justify-center gap-3 mb-6">
            <img src="/brand/icon.svg" alt="Dilla" className="w-8 h-8" />
            <span className="font-display text-[1.1rem] text-foreground-primary">Dilla</span>
          </div>

          {steps && (
            <div className="flex justify-center gap-2 mb-6">
              {Array.from({ length: steps[1] }, (_, i) => (
                <div
                  key={i}
                  className={[
                    'w-2 h-2 rounded-full bg-[var(--interactive-muted)] transition-[background,transform] duration-200',
                    i + 1 === steps[0] ? 'bg-brand scale-125' : '',
                    i + 1 < steps[0] ? 'bg-success' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
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
