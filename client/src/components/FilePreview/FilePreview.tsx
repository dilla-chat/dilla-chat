import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MusicNote, Page, Download } from 'iconoir-react';
import type { Attachment } from '../../services/api';

interface Props {
  attachments: Attachment[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}

function isVideo(contentType: string): boolean {
  return contentType.startsWith('video/');
}

function isAudio(contentType: string): boolean {
  return contentType.startsWith('audio/');
}

function ImagePreview({ attachment }: Readonly<{ attachment: Attachment }>) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div className="max-w-[400px] max-h-[300px] rounded-lg overflow-hidden">
        <button
          className="bg-transparent border-none p-0 rounded-none cursor-pointer block"
          onClick={() => setExpanded(true)}
          type="button"
          title={t('upload.preview', 'Preview')}
        >
          <img
            src={attachment.url}
            alt={attachment.filename}
            className="max-w-[400px] max-h-[300px] rounded-lg object-contain block hover:opacity-90"
          />
        </button>
      </div>
      {expanded && (
        <div
          className="fixed inset-0 bg-overlay-heavy flex items-center justify-center z-modal cursor-pointer"
          data-testid="file-preview-lightbox"
          aria-hidden="true"
          onClick={() => setExpanded(false)}
        >
          <img
            src={attachment.url}
            alt=""
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-sm"
          />
        </div>
      )}
    </>
  );
}

function VideoPreview({ attachment }: Readonly<{ attachment: Attachment }>) {
  return (
    <div className="max-w-[400px] rounded-lg overflow-hidden">
      <video
        src={attachment.url}
        controls
        className="max-w-[400px] max-h-[300px] rounded-lg block"
        preload="metadata"
      >
        <track kind="captions" />
      </video>
    </div>
  );
}

function AudioPreview({ attachment }: Readonly<{ attachment: Attachment }>) {
  return (
    <div className="bg-surface-secondary border border-border rounded-lg p-md max-w-[400px]">
      <div className="flex items-center gap-sm mb-sm">
        <span className="text-xl"><MusicNote width={20} height={20} /></span>
        <span className="text-base text-foreground-primary font-medium">{attachment.filename}</span>
      </div>
      <audio src={attachment.url} controls className="w-full h-8" preload="metadata">
        <track kind="captions" />
      </audio>
    </div>
  );
}

function FileCard({ attachment }: Readonly<{ attachment: Attachment }>) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2.5 bg-surface-secondary border border-border rounded-lg py-2.5 px-3.5 max-w-[400px]">
      <div className="text-[28px] shrink-0"><Page width={24} height={24} /></div>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-base text-foreground-link font-medium truncate">{attachment.filename}</span>
        <span className="text-xs text-foreground-muted">{formatFileSize(attachment.size)}</span>
      </div>
      <a
        href={attachment.url}
        download={attachment.filename}
        className="bg-transparent border-none text-xl text-interactive no-underline p-xs shrink-0 hover:text-interactive-hover"
        title={t('upload.download', 'Download')}
      >
        <Download width={16} height={16} />
      </a>
    </div>
  );
}

export default memo(function FilePreview({ attachments }: Readonly<Props>) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="flex flex-col gap-xs mt-xs">
      {attachments.map((att) => {
        if (isImage(att.content_type)) {
          return <ImagePreview key={att.id} attachment={att} />;
        }
        if (isVideo(att.content_type)) {
          return <VideoPreview key={att.id} attachment={att} />;
        }
        if (isAudio(att.content_type)) {
          return <AudioPreview key={att.id} attachment={att} />;
        }
        return <FileCard key={att.id} attachment={att} />;
      })}
    </div>
  );
});
