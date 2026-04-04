import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ChangeEvent, type DragEvent, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Emoji, Hourglass } from 'iconoir-react';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import type { Attachment } from '../../services/api';
import TypingIndicator from './TypingIndicator';
import FormattingToolbar from './FormattingToolbar';
import { getFormatTypeForKey, applyFormatting } from './formatting';
import { PlusCircleIcon } from './Icons';
import FileUploadArea from './FileUploadArea';
import type { PendingFile } from './FileUploadArea';

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
      className={`shrink-0 relative p-0 px-lg pb-lg z-10 max-md:px-sm max-md:pb-sm ${dragging ? '[&_.composer]:outline-2 [&_.composer]:outline-dashed [&_.composer]:outline-brand [&_.composer]:-outline-offset-2' : ''}`}
      aria-label="Message composition"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <TypingIndicator channelId={channelId} currentUserId={currentUserId} />

      {dragging && (
        <div className="absolute inset-0 bg-brand-a12 flex items-center justify-center z-10 text-brand text-lg font-semibold pointer-events-none rounded-[12px]">
          <span>{t('upload.dragDrop', 'Drop files here to upload')}</span>
        </div>
      )}

      <div className="composer bg-glass backdrop-blur-glass-light border border-glass-border rounded-[12px] overflow-hidden transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-brand focus-within:shadow-[0_0_0_3px_var(--brand-alpha-12)]">
        {editingMessage && (
          <div className="flex items-center justify-between bg-bg-accent text-interactive-active px-3 py-1.5 text-sm font-medium">
            <span>{t('messages.editingBanner', 'Editing message')}</span>
            <button className="bg-transparent border-none text-interactive-active cursor-pointer text-xs opacity-90 p-0 transition-opacity duration-150 hover:opacity-100" onClick={() => { onCancelEdit(); setValue(''); }}>
              {t('common.cancel', 'Cancel')} (Esc)
            </button>
          </div>
        )}

        {/* Row 1: Formatting toolbar (top) */}
        <FormattingToolbar textareaRef={textareaRef} setValue={setValue} />

        {/* Row 2: Textarea (middle) */}
        <div className="px-md py-sm min-h-[22px]">
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent border-none box-border text-foreground text-md font-sans p-0 m-0 resize-none outline-none max-h-[300px] leading-[1.375rem] block placeholder:text-foreground-muted max-md:max-h-[150px]"
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

        {/* Row 3: Action bar (bottom) */}
        <div className="flex items-center justify-between px-sm py-xs min-h-[36px] box-border">
          <div className="flex items-center gap-0.5">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              className="bg-transparent border-none text-interactive p-0 w-7 h-7 flex items-center justify-center shrink-0 text-sm font-semibold font-sans clickable hover:text-interactive-hover [&_svg]:w-[18px] [&_svg]:h-[18px]"
              title={t('upload.attachFile', 'Attach File')}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? <Hourglass width={18} height={18} strokeWidth={2} /> : <PlusCircleIcon />}
            </button>
            <div className="relative">
              {showEmojiPicker && (
                <EmojiPicker
                  onSelect={handleEmojiSelect}
                  onClose={() => setShowEmojiPicker(false)}
                  anchorRef={emojiBtnRef}
                />
              )}
              <button ref={emojiBtnRef} className="bg-transparent border-none text-interactive p-0 w-7 h-7 flex items-center justify-center shrink-0 text-sm font-semibold font-sans clickable hover:text-interactive-hover [&_svg]:w-[18px] [&_svg]:h-[18px]" title={t('messages.emoji', 'Emoji')} onClick={() => setShowEmojiPicker(v => !v)} disabled={uploading}>
                <Emoji width={18} height={18} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-0">
            <div className="w-px h-5 bg-divider mx-1.5 ml-1" />
            <button
              className={`bg-transparent border-none p-0 w-7 h-7 flex items-center justify-center rounded-sm shrink-0 transition-colors duration-150 [&_svg]:w-[18px] [&_svg]:h-[18px] ${hasContent ? 'text-brand cursor-pointer hover:text-brand-light' : 'text-interactive-muted cursor-default'}`}
              title={t('messages.send', 'Send Message')}
              onClick={handleSend}
              disabled={!hasContent || uploading}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>

      {uploading && <div className="text-sm text-foreground-muted px-md py-xs font-medium">{t('upload.uploading', 'Uploading...')}</div>}
    </section>
  );
}
