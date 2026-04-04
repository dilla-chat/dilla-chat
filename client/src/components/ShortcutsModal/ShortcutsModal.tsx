import { useTranslation } from 'react-i18next';
import { Xmark } from 'iconoir-react';
import { shortcuts } from '../../utils/keyboardShortcuts';

interface Props {
  onClose: () => void;
}

export default function ShortcutsModal({ onClose }: Readonly<Props>) {
  const { t } = useTranslation();

  return (
    <dialog
      className="fixed inset-0 border-none p-0 bg-overlay-dark backdrop-blur-[4px] flex items-center justify-center z-[2000] max-w-none max-h-none"
      open
      aria-labelledby="shortcuts-title"
    >
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div className="bg-glass-modal backdrop-blur-glass-heavy border border-glass-border shadow-glass-elevated rounded-lg p-xl w-[480px] max-w-[90vw] text-foreground-primary" data-testid="shortcuts-modal">
        <div className="flex items-center justify-between mb-5">
          <h2 id="shortcuts-title" className="m-0 text-xl font-semibold">
            {t('shortcuts.title', 'Keyboard Shortcuts')}
          </h2>
          <button
            className="bg-transparent border-none text-foreground-muted cursor-pointer text-lg px-sm py-xs rounded-sm hover:text-foreground-primary hover:bg-surface-hover"
            onClick={onClose}
          >
            <Xmark width={20} height={20} strokeWidth={2} />
          </button>
        </div>
        <div className="flex flex-col gap-sm">
          {shortcuts.map((s) => (
            <div
              className="flex items-center justify-between px-md py-sm rounded-sm bg-surface-secondary"
              key={s.key}
              data-testid="shortcut-row"
            >
              <span className="text-base text-foreground-primary">{t(s.action)}</span>
              <kbd className="bg-surface-tertiary text-foreground-secondary py-1 px-2.5 rounded-sm border border-border font-mono">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
