import { useEffect } from 'react';
import { IconX } from '@tabler/icons-react';
import TitleBar from '../TitleBar/TitleBar';
import './SettingsLayout.css';

export interface NavSection {
  label?: string;
  items: { id: string; label: string; danger?: boolean }[];
}

interface Props {
  sections: NavSection[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  children: React.ReactNode;
}

export default function SettingsLayout({ sections, activeId, onSelect, onClose, children }: Readonly<Props>) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', handleKey);
    return () => globalThis.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="settings-overlay">
      <TitleBar />
      <div className="settings-nav-wrapper">
        <nav className="settings-nav">
          {sections.map((section, si) => (
            <div key={section.label ?? section.items.map(i => i.id).join(',')} className="settings-nav-section">
              {si > 0 && <div className="settings-nav-separator" />}
              {section.label && (
                <div className="settings-nav-header micro">{section.label}</div>
              )}
              {section.items.map((item) => (
                <button
                  key={item.id}
                  className={`settings-nav-item${activeId === item.id ? ' active' : ''}${item.danger ? ' danger' : ''}`}
                  onClick={() => onSelect(item.id)}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>

      <div className="settings-content-wrapper">
        <div className="settings-content">
          {children}
        </div>
        <div className="settings-close-col">
          <button className="settings-close-btn" onClick={onClose}>
            <IconX size={18} stroke={1.75} />
          </button>
          <span className="settings-close-esc">ESC</span>
        </div>
      </div>
    </div>
  );
}
