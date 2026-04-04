import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresenceStatus } from '../PresenceIndicator/PresenceIndicator';

interface Props {
  currentStatus: PresenceStatus;
  customStatus: string;
  onStatusChange: (status: PresenceStatus) => void;
  onCustomStatusChange: (text: string) => void;
  onClose: () => void;
}

const STATUS_OPTIONS: Array<{
  value: PresenceStatus;
  labelKey: string;
  descKey: string;
  color: string;
}> = [
  { value: 'online', labelKey: 'presence.online', descKey: '', color: '#4caf82' },
  { value: 'idle', labelKey: 'presence.idle', descKey: '', color: '#e8b84b' },
  { value: 'dnd', labelKey: 'presence.dnd', descKey: '', color: '#d05a4a' },
  { value: 'offline', labelKey: 'presence.invisible', descKey: '', color: '#4d6478' },
];

export default function StatusPicker({
  currentStatus,
  customStatus,
  onStatusChange,
  onCustomStatusChange,
  onClose,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const [customText, setCustomText] = useState(customStatus);

  const handleStatusSelect = (status: PresenceStatus) => {
    onStatusChange(status);
    onClose();
  };

  const handleSaveCustom = () => {
    onCustomStatusChange(customText);
    onClose();
  };

  const handleClearCustom = () => {
    setCustomText('');
    onCustomStatusChange('');
    onClose();
  };

  return (
    <dialog
      className="absolute bottom-[60px] left-2 bg-glass-floating backdrop-blur-glass-heavy border border-glass-border shadow-glass-elevated rounded-lg p-2 z-[1000] min-w-[220px] max-w-none max-h-none text-[inherit]"
      open
    >
      <div className="px-2.5 pt-2 pb-1 text-micro font-bold uppercase tracking-[0.02em] text-foreground-secondary">
        {t('presence.setStatus')}
      </div>

      <div className="flex flex-col gap-0.5">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`border-none w-full text-left font-[inherit] flex items-center gap-2.5 py-2 px-2.5 rounded-sm cursor-pointer text-sm text-foreground-primary bg-transparent hover:bg-surface-hover ${currentStatus === opt.value ? 'bg-accent' : ''}`}
            data-active={currentStatus === opt.value || undefined}
            onClick={() => handleStatusSelect(opt.value)}
            type="button"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: opt.color }}
            />
            <span className="flex-1">{t(opt.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="h-px bg-divider my-1.5" />

      <div className="px-2.5 pt-1 pb-2">
        <label className="block text-micro font-semibold text-foreground-secondary mb-1.5 uppercase tracking-[0.02em]">
          {t('presence.customStatus')}
        </label>
        <input
          type="text"
          className="w-full py-2 px-2.5 bg-input border-none rounded-sm text-foreground-primary text-sm outline-none box-border placeholder:text-foreground-muted"
          placeholder={t('presence.customStatusPlaceholder')}
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveCustom();
          }}
          maxLength={128}
        />
        <div className="flex gap-1.5 mt-2 justify-end">
          {customStatus && (
            <button
              className="py-1.5 px-3.5 border-none rounded-sm text-[13px] cursor-pointer font-medium bg-transparent text-foreground-secondary hover:text-foreground-primary"
              onClick={handleClearCustom}
            >
              {t('presence.clearStatus')}
            </button>
          )}
          <button
            className="py-1.5 px-3.5 border border-white-overlay-light rounded-sm text-[13px] cursor-pointer font-medium bg-accent text-white shadow-[0_2px_8px_var(--accent-alpha-20)] transition-[filter,box-shadow] duration-150 hover:brightness-110 hover:shadow-[0_4px_16px_var(--accent-alpha-30)]"
            onClick={handleSaveCustom}
          >
            {t('presence.saveStatus')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
