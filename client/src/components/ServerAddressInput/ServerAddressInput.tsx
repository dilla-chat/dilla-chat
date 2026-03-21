import { CloudCheck, CloudXmark, CloudSync } from 'iconoir-react';

export type ServerStatus = 'unknown' | 'checking' | 'online' | 'offline';

interface ServerAddressInputProps {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  serverStatus: ServerStatus;
}

const statusIconStyle = {
  position: 'absolute' as const,
  right: 12,
  top: '50%',
  transform: 'translateY(-50%)',
  width: 18,
  height: 18,
};

export default function ServerAddressInput({
  placeholder,
  value,
  onChange,
  serverStatus,
}: Readonly<ServerAddressInputProps>) {
  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ paddingRight: '2.5rem' }}
      />
      {serverStatus === 'online' && (
        <CloudCheck style={{ ...statusIconStyle, color: 'var(--text-positive)' }} />
      )}
      {serverStatus === 'offline' && (
        <CloudXmark style={{ ...statusIconStyle, color: 'var(--text-danger)' }} />
      )}
      {serverStatus === 'checking' && (
        <CloudSync
          style={{
            ...statusIconStyle,
            color: 'var(--text-warning)',
            animation: 'spin 1s linear infinite',
          }}
        />
      )}
    </div>
  );
}
