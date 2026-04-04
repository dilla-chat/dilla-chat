import { useTranslation } from 'react-i18next';
import { Xmark, Page } from 'iconoir-react';

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
        <div className="flex flex-wrap gap-sm px-md py-sm border-t border-divider">
          {pendingFiles.map((pf, idx) => (
            <div
              key={`${pf.file.name}-${pf.file.size}-${idx}`}
              className="flex items-center gap-sm bg-surface-secondary border border-divider rounded-md px-2.5 py-1.5 max-w-[220px]"
            >
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="w-10 h-10 rounded-sm object-cover shrink-0" />
              ) : (
                <span className="text-2xl shrink-0 flex">
                  <Page width={20} height={20} strokeWidth={2} />
                </span>
              )}
              <div className="flex-1 min-w-0 flex flex-col gap-px">
                <span className="text-sm text-foreground font-medium truncate">{pf.file.name}</span>
                <span className="text-xs text-foreground-muted">{formatFileSize(pf.file.size)}</span>
              </div>
              <button
                className="bg-transparent border-none text-interactive p-0 w-6 h-6 flex items-center justify-center shrink-0 clickable hover:text-foreground-danger"
                onClick={() => onRemoveFile(idx)}
                title="Remove"
              >
                <Xmark width={16} height={16} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
      {uploadError && <div className="text-sm text-foreground-danger px-md py-xs font-medium">{uploadError}</div>}
    </>
  );
}
