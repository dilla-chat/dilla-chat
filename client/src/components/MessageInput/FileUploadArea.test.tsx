import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import FileUploadArea from './FileUploadArea';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));

vi.mock('@tabler/icons-react', () => ({
  IconX: () => <span data-testid="icon-x" />,
  IconFile: () => <span data-testid="icon-file" />,
}));

function pendingFile(name: string, size: number, preview?: string) {
  return {
    file: new File([new Uint8Array(size)], name, { type: 'application/octet-stream' }),
    preview,
  };
}

describe('FileUploadArea', () => {
  it('renders null when no pending files and no error', () => {
    const { container } = render(
      <FileUploadArea pendingFiles={[]} onRemoveFile={vi.fn()} uploadError={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the upload-error banner when only an error is set', () => {
    const { container, getByText } = render(
      <FileUploadArea pendingFiles={[]} onRemoveFile={vi.fn()} uploadError="too big" />,
    );
    expect(getByText('too big')).toBeTruthy();
    expect(container.querySelector('.message-input-file-previews')).toBeNull();
  });

  it('renders the image preview when a data URL is provided', () => {
    const { container } = render(
      <FileUploadArea
        pendingFiles={[pendingFile('a.png', 500, 'data:image/png;base64,xxx')]}
        onRemoveFile={vi.fn()}
        uploadError={null}
      />,
    );
    const img = container.querySelector('img.file-preview-thumb') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toContain('data:image/png');
    expect(img.alt).toBe('a.png');
  });

  it('falls back to a file icon when no preview is provided', () => {
    const { getByTestId, queryByRole } = render(
      <FileUploadArea
        pendingFiles={[pendingFile('doc.pdf', 1000)]}
        onRemoveFile={vi.fn()}
        uploadError={null}
      />,
    );
    expect(getByTestId('icon-file')).toBeTruthy();
    expect(queryByRole('img')).toBeNull();
  });

  it('formats file size: bytes / KB / MB', () => {
    const { container } = render(
      <FileUploadArea
        pendingFiles={[
          pendingFile('tiny.txt', 500),
          pendingFile('medium.txt', 5 * 1024),
          pendingFile('big.bin', 3 * 1024 * 1024),
        ]}
        onRemoveFile={vi.fn()}
        uploadError={null}
      />,
    );
    const sizes = [...container.querySelectorAll('.file-preview-size')].map((s) => s.textContent);
    expect(sizes).toEqual(['500 B', '5.0 KB', '3.0 MB']);
  });

  it('fires onRemoveFile with the correct index when × is clicked', () => {
    const onRemove = vi.fn();
    const { container } = render(
      <FileUploadArea
        pendingFiles={[pendingFile('a.txt', 1), pendingFile('b.txt', 1)]}
        onRemoveFile={onRemove}
        uploadError={null}
      />,
    );
    const removeBtns = container.querySelectorAll('button.file-preview-remove');
    fireEvent.click(removeBtns[1]);
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('shows both file previews AND the error banner together', () => {
    const { container, getByText } = render(
      <FileUploadArea
        pendingFiles={[pendingFile('a.txt', 1)]}
        onRemoveFile={vi.fn()}
        uploadError="partial failure"
      />,
    );
    expect(container.querySelector('.message-input-file-previews')).toBeTruthy();
    expect(getByText('partial failure')).toBeTruthy();
  });
});
