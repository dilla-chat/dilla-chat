import { useTranslation } from 'react-i18next';
import { Xmark } from 'iconoir-react';
import './ShortcutsModal.css';

interface Props {
  onClose: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';

const shortcuts = [
  { key: `${mod}+K`, action: 'shortcuts.search' },
  { key: 'Escape', action: 'shortcuts.closePanel' },
  { key: `${mod}+Shift+M`, action: 'shortcuts.toggleMute' },
  { key: `${mod}+Shift+D`, action: 'shortcuts.toggleDeafen' },
  { key: 'Alt+↑/↓', action: 'shortcuts.navigateChannels' },
  { key: `${mod}+/`, action: 'shortcuts.showShortcuts' },
];

export default function ShortcutsModal({ onClose }: Props) {
  const { t } = useTranslation();

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div className="shortcuts-header">
          <h2 id="shortcuts-title">{t('shortcuts.title', 'Keyboard Shortcuts')}</h2>
          <button className="shortcuts-close" onClick={onClose}><Xmark width={20} height={20} strokeWidth={2} /></button>
        </div>
        <div className="shortcuts-list">
          {shortcuts.map((s) => (
            <div className="shortcuts-row" key={s.key}>
              <span className="shortcuts-action">{t(s.action)}</span>
              <kbd className="shortcuts-key">{s.key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
