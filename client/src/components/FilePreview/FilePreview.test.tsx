import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilePreview from './FilePreview';
import type { Attachment } from '../../services/api';

vi.mock('@tabler/icons-react', () => ({
  IconMusic: () => <span data-testid="icon-music" />,
  IconFile: () => <span data-testid="icon-page" />,
  IconDownload: () => <span data-testid="icon-download" />,
}));

const imageAttachment: Attachment = {
  id: 'att-1',
  message_id: 'msg-1',
  filename: 'photo.png',
  content_type: 'image/png',
  size: 2048,
  url: 'https://example.com/photo.png',
};

const videoAttachment: Attachment = {
  id: 'att-2',
  message_id: 'msg-1',
  filename: 'clip.mp4',
  content_type: 'video/mp4',
  size: 5242880,
  url: 'https://example.com/clip.mp4',
};

const audioAttachment: Attachment = {
  id: 'att-3',
  message_id: 'msg-1',
  filename: 'song.mp3',
  content_type: 'audio/mpeg',
  size: 3145728,
  url: 'https://example.com/song.mp3',
};

const fileAttachment: Attachment = {
  id: 'att-4',
  message_id: 'msg-1',
  filename: 'document.pdf',
  content_type: 'application/pdf',
  size: 1048576,
  url: 'https://example.com/document.pdf',
};

describe('FilePreview', () => {
  it('returns null for empty attachments', () => {
    const { container } = render(<FilePreview attachments={[]} teamId="team-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when attachments is undefined/falsy', () => {
    const { container } = render(
      <FilePreview attachments={undefined as unknown as Attachment[]} teamId="team-1" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders image files with img tag', () => {
    render(<FilePreview attachments={[imageAttachment]} teamId="team-1" />);
    const img = screen.getByAltText('photo.png');
    expect(img).toBeInTheDocument();
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://example.com/photo.png');
  });

  it('opens lightbox when clicking an image', () => {
    render(<FilePreview attachments={[imageAttachment]} teamId="team-1" />);
    fireEvent.click(screen.getByAltText('photo.png'));
    // After click, lightbox should appear
    expect(document.querySelector('.file-preview-lightbox')).toBeInTheDocument();
  });

  it('renders video files with video tag', () => {
    const { container } = render(<FilePreview attachments={[videoAttachment]} teamId="team-1" />);
    const video = container.querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute('src', 'https://example.com/clip.mp4');
    expect(video).toHaveAttribute('controls');
  });

  it('renders audio files with audio tag and filename', () => {
    const { container } = render(<FilePreview attachments={[audioAttachment]} teamId="team-1" />);
    const audio = container.querySelector('audio');
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute('src', 'https://example.com/song.mp3');
    expect(screen.getByText('song.mp3')).toBeInTheDocument();
  });

  it('renders non-media files as card with filename and size', () => {
    render(<FilePreview attachments={[fileAttachment]} teamId="team-1" />);
    expect(screen.getByText('document.pdf')).toBeInTheDocument();
    expect(screen.getByText('1.0 MB')).toBeInTheDocument();
  });

  it('renders download link for file cards', () => {
    render(<FilePreview attachments={[fileAttachment]} teamId="team-1" />);
    const downloadLink = screen.getByTitle('Download');
    expect(downloadLink).toHaveAttribute('href', 'https://example.com/document.pdf');
    expect(downloadLink).toHaveAttribute('download', 'document.pdf');
  });

  it('renders multiple attachments of different types', () => {
    render(
      <FilePreview
        attachments={[imageAttachment, fileAttachment]}
        teamId="team-1"
      />,
    );
    expect(screen.getByAltText('photo.png')).toBeInTheDocument();
    expect(screen.getByText('document.pdf')).toBeInTheDocument();
  });

  it('closes lightbox when clicking on it', () => {
    render(<FilePreview attachments={[imageAttachment]} teamId="team-1" />);
    fireEvent.click(screen.getByAltText('photo.png'));
    // Lightbox should be open
    expect(document.querySelector('.file-preview-lightbox')).toBeInTheDocument();
    // Click the lightbox overlay to close
    const lightbox = document.querySelector('.file-preview-lightbox')!;
    fireEvent.click(lightbox);
    // Lightbox should be gone
    expect(document.querySelector('.file-preview-lightbox')).not.toBeInTheDocument();
  });

  it('formats file sizes correctly', () => {
    const smallFile: Attachment = { ...fileAttachment, id: 'small', size: 500 };
    const mediumFile: Attachment = { ...fileAttachment, id: 'medium', size: 1536, filename: 'medium.pdf' };

    render(<FilePreview attachments={[smallFile, mediumFile]} teamId="team-1" />);
    expect(screen.getByText('500 B')).toBeInTheDocument();
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
  });
});
