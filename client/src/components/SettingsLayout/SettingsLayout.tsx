import { useEffect } from 'react';
import { Xmark } from 'iconoir-react';
import TitleBar from '../TitleBar/TitleBar';

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
    <div className="fixed inset-0 z-100 flex bg-surface">
      <TitleBar />
      <div className="w-[232px] flex justify-end bg-glass-secondary backdrop-blur-glass overflow-y-auto shrink-0">
        <nav className="w-[218px] pt-15 pr-1.5 pb-5 pl-5 flex flex-col shrink-0 box-border">
          {sections.map((section, si) => (
            <div key={section.label ?? section.items.map(i => i.id).join(',')} className="flex flex-col gap-0.5">
              {si > 0 && <div className="h-px bg-border mx-2.5 my-2" />}
              {section.label && (
                <div className="text-foreground-secondary px-2.5 pt-2 pb-1 text-micro font-medium uppercase tracking-wide text-foreground-muted">{section.label}</div>
              )}
              {section.items.map((item) => (
                <button
                  key={item.id}
                  className={`bg-transparent border-none w-full text-left font-[inherit] px-2.5 py-1.5 rounded-sm cursor-pointer text-base select-none ${
                    activeId === item.id
                      ? 'bg-surface-selected text-interactive-active'
                      : item.danger
                        ? 'text-foreground-danger hover:bg-danger hover:text-white'
                        : 'text-foreground-secondary hover:bg-surface-hover hover:text-foreground-primary'
                  }`}
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

      <div className="flex-1 flex overflow-y-auto bg-surface min-w-0">
        <div className="w-[740px] max-w-[740px] min-w-0 pt-15 px-10 pb-20 box-border shrink-0">
          {children}
        </div>
        <div className="flex flex-col items-center pt-15 shrink-0 w-15 sticky top-0 self-start">
          <button
            className="w-10 h-10 rounded-full border-2 border-foreground-muted bg-transparent text-foreground-muted cursor-pointer flex items-center justify-center p-0 transition-[background,border-color,color] duration-150 hover:border-interactive-hover hover:text-interactive-hover hover:bg-surface-hover"
            onClick={onClose}
          >
            <Xmark width={18} height={18} strokeWidth={2} />
          </button>
          <span className="text-sm font-semibold text-foreground-muted mt-1.5 select-none">ESC</span>
        </div>
      </div>
    </div>
  );
}
