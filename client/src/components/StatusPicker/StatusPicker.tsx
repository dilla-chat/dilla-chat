import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresenceStatus } from '../PresenceIndicator/PresenceIndicator';
import './StatusPicker.css';

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
}: Props) {
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
    <div className="status-picker" onClick={(e) => e.stopPropagation()}>
      <div className="status-picker-header">{t('presence.setStatus')}</div>

      <div className="status-picker-options">
        {STATUS_OPTIONS.map((opt) => (
          <div
            key={opt.value}
            className={`status-picker-option ${currentStatus === opt.value ? 'active' : ''}`}
            onClick={() => handleStatusSelect(opt.value)}
          >
            <span className="status-picker-dot" style={{ backgroundColor: opt.color }} />
            <span className="status-picker-label">{t(opt.labelKey)}</span>
          </div>
        ))}
      </div>

      <div className="status-picker-divider" />

      <div className="status-picker-custom">
        <label className="status-picker-custom-label">{t('presence.customStatus')}</label>
        <input
          type="text"
          className="status-picker-custom-input"
          placeholder={t('presence.customStatusPlaceholder')}
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSaveCustom();
          }}
          maxLength={128}
        />
        <div className="status-picker-custom-actions">
          {customStatus && (
            <button className="status-picker-btn clear" onClick={handleClearCustom}>
              {t('presence.clearStatus')}
            </button>
          )}
          <button className="status-picker-btn save" onClick={handleSaveCustom}>
            {t('presence.saveStatus')}
          </button>
        </div>
      </div>
    </div>
  );
}
