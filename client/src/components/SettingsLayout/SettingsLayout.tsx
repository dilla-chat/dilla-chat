import { useEffect } from 'react';
import { Xmark } from 'iconoir-react';
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

export default function SettingsLayout({ sections, activeId, onSelect, onClose, children }: Props) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="settings-overlay">
      <TitleBar />
      <div className="settings-nav-wrapper">
        <nav className="settings-nav">
          {sections.map((section, si) => (
            <div key={si} className="settings-nav-section">
              {si > 0 && <div className="settings-nav-separator" />}
              {section.label && (
                <div className="settings-nav-header">{section.label}</div>
              )}
              {section.items.map((item) => (
                <div
                  key={item.id}
                  className={`settings-nav-item${activeId === item.id ? ' active' : ''}${item.danger ? ' danger' : ''}`}
                  onClick={() => onSelect(item.id)}
                >
                  {item.label}
                </div>
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
            <Xmark width={18} height={18} strokeWidth={2} />
          </button>
          <span className="settings-close-esc">ESC</span>
        </div>
      </div>
    </div>
  );
}
