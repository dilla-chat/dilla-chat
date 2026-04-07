import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ChangeEvent, type DragEvent, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconMoodSmile, IconHourglass } from '@tabler/icons-react';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import type { Attachment } from '../../services/api';
import TypingIndicator from './TypingIndicator';
import FormattingToolbar from './FormattingToolbar';
import { getFormatTypeForKey, applyFormatting } from './formatting';
import { PlusCircleIcon } from './Icons';
import FileUploadArea from './FileUploadArea';
import type { PendingFile } from './FileUploadArea';
import './MessageInput.css';

interface Props {
  channelId: string;
  channelName: string;
  currentUserId: string;
  editingMessage: { id: string; content: string } | null;
  onSend: (content: string, attachments?: Attachment[]) => void;
  onEdit: (messageId: string, content: string) => void;
  onCancelEdit: () => void;
  onTyping: () => void;
  onUploadFile?: (file: File) => Promise<Attachment>;
  placeholder?: string;
}

function SendIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>;
}

export default function MessageInput({
  channelId,
  channelName,
  currentUserId,
  editingMessage,
  onSend,
  onEdit,
  onCancelEdit,
  onTyping,
  onUploadFile,
  placeholder: customPlaceholder,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const lastTypingRef = useRef(0);

  const hasContent = value.trim().length > 0 || pendingFiles.length > 0;

  const editContent = editingMessage?.content ?? null;
  const prevEditContentRef = useRef<string | null>(null);
  if (editContent !== prevEditContentRef.current) {
    prevEditContentRef.current = editContent;
    if (editContent !== null) {
      setValue(editContent);
    }
  }

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (editContent !== null) {
      textareaRef.current?.focus();
    }
  }, [editContent]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = '0';
      el.style.height = `${Math.min(el.scrollHeight, 300)}px`;
    }
  }, [value]);

  useEffect(() => {
    return () => {
      for (const pf of pendingFiles) {
        if (pf.preview) URL.revokeObjectURL(pf.preview);
      }
    };
  }, [pendingFiles]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newPending: PendingFile[] = [];
    for (const file of Array.from(files)) {
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      newPending.push({ file, preview });
    }
    setPendingFiles((prev) => [...prev, ...newPending]);
    setUploadError(null);
  }, []);

  const removeFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const next = [...prev];
      const removed = next.splice(index, 1)[0];
      if (removed.preview) URL.revokeObjectURL(removed.preview);
      return next;
    });
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    if (editingMessage) {
      onEdit(editingMessage.id, trimmed);
      setValue('');
      return;
    }

    if (pendingFiles.length > 0 && onUploadFile) {
      setUploading(true);
      setUploadError(null);
      try {
        const uploaded: Attachment[] = [];
        for (const pf of pendingFiles) {
          const att = await onUploadFile(pf.file);
          uploaded.push(att);
        }
        onSend(trimmed, uploaded);
        setPendingFiles([]);
      } catch {
        setUploadError(t('upload.uploadFailed', 'Upload failed'));
        setUploading(false);
        return;
      }
      setUploading(false);
    } else {
      onSend(trimmed);
    }
    setValue('');
  }, [value, pendingFiles, editingMessage, onSend, onEdit, onUploadFile, t]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }

      if (e.key === 'Escape' && editingMessage) {
        onCancelEdit();
        setValue('');
        return;
      }

      // Formatting keyboard shortcuts
      const mod = e.metaKey || e.ctrlKey;
      if (mod && textareaRef.current) {
        const formatKey = getFormatTypeForKey(e.key, e.shiftKey);
        if (formatKey) {
          e.preventDefault();
          applyFormatting(textareaRef.current, formatKey, setValue);
          return;
        }
      }

      // Throttled typing indicator
      const now = Date.now();
      if (now - lastTypingRef.current > 3000) {
        lastTypingRef.current = now;
        onTyping();
      }
    },
    [handleSend, editingMessage, onCancelEdit, onTyping],
  );

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  };

  const handleEmojiSelect = (emoji: string) => {
    setValue(prev => prev + emoji);
    setShowEmojiPicker(false);
    textareaRef.current?.focus();
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  };

  return (
    <section
      className={`message-input-wrapper ${dragging ? 'message-input-dragging' : ''}`}
      aria-label="Message composition"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <TypingIndicator channelId={channelId} currentUserId={currentUserId} />

      {dragging && (
        <div className="message-input-drag-overlay">
          <span>{t('upload.dragDrop', 'Drop files here to upload')}</span>
        </div>
      )}

      <div className="message-input-composer">
        {editingMessage && (
          <div className="message-input-editing-banner">
            <span>{t('messages.editingBanner', 'Editing message')}</span>
            <button className="editing-cancel-btn" onClick={() => { onCancelEdit(); setValue(''); }}>
              {t('common.cancel', 'Cancel')} (Esc)
            </button>
          </div>
        )}

        {/* Textarea (top) */}
        <div className="message-input-textarea-area">
          <textarea
            ref={textareaRef}
            className="message-input-textarea"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={customPlaceholder ?? t('messages.placeholder', 'Message ~{{channel}}', {
              channel: channelName,
            })}
            rows={1}
            disabled={uploading}
          />
        </div>

        <FileUploadArea
          pendingFiles={pendingFiles}
          onRemoveFile={removeFile}
          uploadError={uploadError}
        />

        {/* Bottom bar: attach + separator + formatting + separator + emoji + send */}
        <div className="message-input-bottom-bar">
          <input
            ref={fileInputRef}
            type="file"
            className="message-input-file-hidden"
            multiple
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            className="toolbar-btn clickable"
            title={t('upload.attachFile', 'Attach File')}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <IconHourglass size={18} stroke={1.75} /> : <PlusCircleIcon />}
          </button>

          <div className="toolbar-separator" />

          <FormattingToolbar textareaRef={textareaRef} setValue={setValue} />

          <div className="toolbar-separator" />

          <div style={{ position: 'relative' }}>
            {showEmojiPicker && (
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmojiPicker(false)}
                anchorRef={emojiBtnRef}
              />
            )}
            <button ref={emojiBtnRef} className="toolbar-btn clickable" title={t('messages.emoji', 'Emoji')} onClick={() => setShowEmojiPicker(v => !v)} disabled={uploading}>
              <IconMoodSmile size={18} stroke={1.75} />
            </button>
          </div>

          <button
            className={`toolbar-send-btn ${hasContent ? 'has-content' : ''}`}
            title={t('messages.send', 'Send Message')}
            onClick={handleSend}
            disabled={!hasContent || uploading}
            style={{ marginLeft: 'auto' }}
          >
            <SendIcon />
          </button>
        </div>
      </div>

      {uploading && <div className="message-input-uploading">{t('upload.uploading', 'Uploading...')}</div>}
    </section>
  );
}
