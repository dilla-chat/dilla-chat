import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconMusic, IconFile, IconDownload } from '@tabler/icons-react';
import type { Attachment } from '../../services/api';
import './FilePreview.css';

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
      <div className="file-preview-image-container">
        <button className="file-preview-image-btn" onClick={() => setExpanded(true)} type="button" title={t('upload.preview', 'Preview')}>
          <img
            src={attachment.url}
            alt={attachment.filename}
            className="file-preview-image"
          />
        </button>
      </div>
      {expanded && (
        <div className="file-preview-lightbox" aria-hidden="true" onClick={() => setExpanded(false)}>
          <img
            src={attachment.url}
            alt=""
            className="file-preview-lightbox-image"
          />
        </div>
      )}
    </>
  );
}

function VideoPreview({ attachment }: Readonly<{ attachment: Attachment }>) {
  return (
    <div className="file-preview-video-container">
      <video
        src={attachment.url}
        controls
        className="file-preview-video"
        preload="metadata"
      >
        <track kind="captions" />
      </video>
    </div>
  );
}

function AudioPreview({ attachment }: Readonly<{ attachment: Attachment }>) {
  return (
    <div className="file-preview-audio-container">
      <div className="file-preview-audio-info">
        <span className="file-preview-audio-icon"><IconMusic size={20} stroke={1.75} /></span>
        <span className="file-preview-audio-name">{attachment.filename}</span>
      </div>
      <audio src={attachment.url} controls className="file-preview-audio" preload="metadata">
        <track kind="captions" />
      </audio>
    </div>
  );
}

function FileCard({ attachment }: Readonly<{ attachment: Attachment }>) {
  const { t } = useTranslation();

  return (
    <div className="file-preview-card">
      <div className="file-preview-card-icon"><IconFile size={24} stroke={1.75} /></div>
      <div className="file-preview-card-info">
        <span className="file-preview-card-name truncate">{attachment.filename}</span>
        <span className="file-preview-card-size">{formatFileSize(attachment.size)}</span>
      </div>
      <a
        href={attachment.url}
        download={attachment.filename}
        className="file-preview-card-download clickable"
        title={t('upload.download', 'Download')}
      >
        <IconDownload size={16} stroke={1.75} />
      </a>
    </div>
  );
}

export default memo(function FilePreview({ attachments }: Readonly<Props>) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="file-preview-list">
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
