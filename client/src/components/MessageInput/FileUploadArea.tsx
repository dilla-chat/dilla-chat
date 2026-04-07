import { useTranslation } from 'react-i18next';
import { IconX, IconFile } from '@tabler/icons-react';

export interface PendingFile {
  file: File;
  preview?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileUploadAreaProps {
  pendingFiles: PendingFile[];
  onRemoveFile: (index: number) => void;
  uploadError: string | null;
}

export default function FileUploadArea({
  pendingFiles,
  onRemoveFile,
  uploadError,
}: Readonly<FileUploadAreaProps>) {
  const { t: _t } = useTranslation();

  if (pendingFiles.length === 0 && !uploadError) return null;

  return (
    <>
      {pendingFiles.length > 0 && (
        <div className="message-input-file-previews">
          {pendingFiles.map((pf, idx) => (
            <div
              key={`${pf.file.name}-${pf.file.size}-${idx}`}
              className="message-input-file-preview"
            >
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="file-preview-thumb" />
              ) : (
                <span className="file-preview-icon">
                  <IconFile size={20} stroke={1.75} />
                </span>
              )}
              <div className="file-preview-details">
                <span className="file-preview-name truncate">{pf.file.name}</span>
                <span className="file-preview-size">{formatFileSize(pf.file.size)}</span>
              </div>
              <button
                className="file-preview-remove clickable"
                onClick={() => onRemoveFile(idx)}
                title="Remove"
              >
                <IconX size={16} stroke={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
      {uploadError && <div className="message-input-upload-error">{uploadError}</div>}
    </>
  );
}
