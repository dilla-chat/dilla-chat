import { useTranslation } from 'react-i18next';
import { IconX } from '@tabler/icons-react';
import { groupedShortcuts } from '../../utils/keyboardShortcuts';
import './ShortcutsModal.css';

interface Props {
  onClose: () => void;
}

export default function ShortcutsModal({ onClose }: Readonly<Props>) {
  const { t } = useTranslation();
  const groups = groupedShortcuts();

  return (
    <dialog className="shortcuts-overlay" open aria-labelledby="shortcuts-title">
      <button type="button" className="dialog-backdrop" onClick={onClose} aria-label="Close" />
      <div className="shortcuts-modal">
        <div className="shortcuts-header">
          <h2 id="shortcuts-title" className="shortcuts-title">{t('shortcuts.title', 'Keyboard Shortcuts')}</h2>
          <button className="shortcuts-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
            <IconX size={20} stroke={1.75} />
          </button>
        </div>
        <div className="shortcuts-list">
          {groups.map((group) => (
            <div className="shortcuts-group" key={group.group}>
              <p className="shortcuts-group-title">{t(group.group, group.group)}</p>
              {group.shortcuts.map((s) => (
                <div className="shortcuts-row" key={s.key}>
                  <span className="shortcuts-action">{t(s.action)}</span>
                  <kbd className="shortcuts-key shortcut-key">{s.key}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
