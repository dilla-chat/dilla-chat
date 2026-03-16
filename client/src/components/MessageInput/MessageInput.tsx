import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type ChangeEvent, type DragEvent, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Xmark, Emoji, Hourglass, Page, Link as LinkIcon } from 'iconoir-react';
import { useMessageStore } from '../../stores/messageStore';
import EmojiPicker from '../EmojiPicker/EmojiPicker';
import type { Attachment } from '../../services/api';
import './MessageInput.css';

interface PendingFile {
  file: File;
  preview?: string;
}

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

const TYPING_EXPIRY_MS = 5_000;

type FormatType = 'bold' | 'italic' | 'strikethrough' | 'code' | 'code-block' | 'ordered-list' | 'unordered-list' | 'blockquote' | 'link';

function applyFormatting(textarea: HTMLTextAreaElement, format: FormatType, setValue: (fn: (prev: string) => string) => void) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);

  let before = value.slice(0, start);
  let after = value.slice(end);
  let replacement: string;
  let cursorOffset: number;

  switch (format) {
    case 'bold':
      replacement = `**${selected || 'bold text'}**`;
      cursorOffset = selected ? replacement.length : 2;
      break;
    case 'italic':
      replacement = `_${selected || 'italic text'}_`;
      cursorOffset = selected ? replacement.length : 1;
      break;
    case 'strikethrough':
      replacement = `~~${selected || 'strikethrough'}~~`;
      cursorOffset = selected ? replacement.length : 2;
      break;
    case 'code':
      replacement = `\`${selected || 'code'}\``;
      cursorOffset = selected ? replacement.length : 1;
      break;
    case 'ordered-list': {
      const lineStart = before.lastIndexOf('\n') + 1;
      const linePrefix = before.slice(lineStart);
      before = before.slice(0, lineStart);
      replacement = `1. ${linePrefix}${selected}`;
      cursorOffset = replacement.length;
      break;
    }
    case 'unordered-list': {
      const lineStart2 = before.lastIndexOf('\n') + 1;
      const linePrefix2 = before.slice(lineStart2);
      before = before.slice(0, lineStart2);
      replacement = `- ${linePrefix2}${selected}`;
      cursorOffset = replacement.length;
      break;
    }
    case 'blockquote': {
      const lineStart3 = before.lastIndexOf('\n') + 1;
      const linePrefix3 = before.slice(lineStart3);
      before = before.slice(0, lineStart3);
      replacement = `> ${linePrefix3}${selected}`;
      cursorOffset = replacement.length;
      break;
    }
    case 'link':
      if (selected) {
        replacement = `[${selected}](url)`;
        cursorOffset = replacement.length - 1;
      } else {
        replacement = '[link text](url)';
        cursorOffset = 1;
      }
      break;
    case 'code-block':
      replacement = `\`\`\`\n${selected || 'code'}\n\`\`\``;
      cursorOffset = selected ? replacement.length : 4;
      break;
    default:
      return;
  }

  const newValue = before + replacement + after;
  setValue(() => newValue);

  // Restore cursor position after React re-render
  requestAnimationFrame(() => {
    const pos = before.length + cursorOffset;
    textarea.selectionStart = selected ? pos : before.length + (format === 'link' ? 1 : (format === 'bold' || format === 'strikethrough' ? 2 : 1));
    textarea.selectionEnd = selected ? pos : before.length + replacement.length - (format === 'link' ? 5 : (format === 'bold' || format === 'strikethrough' ? 2 : 1));
    textarea.focus();
  });
}

// Toolbar formatting icons as inline SVGs
function BoldIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h8a4 4 0 0 1 2.83 6.83A4 4 0 0 1 15 20H6V4zm3 7h5a1.5 1.5 0 0 0 0-3H9v3zm0 3v3h6a1.5 1.5 0 0 0 0-3H9z"/></svg>;
}
function ItalicIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4h8l-1 2h-2.6l-4 12H13l-1 2H4l1-2h2.6l4-12H9l1-2z"/></svg>;
}
function StrikethroughIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 12h18v2H3v-2zm5-6h8a3 3 0 0 1 .75 5.91A3 3 0 0 1 16 18H8a3 3 0 0 1-.75-5.91A3 3 0 0 1 8 6zm0 2a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2H8zm0 6a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2H8z"/></svg>;
}
function CodeIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
}
function CodeBlockIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="14 8 18 12 14 16"/><polyline points="10 16 6 12 10 8"/></svg>;
}
function OrderedListIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 4h2v5H4V5H3V4zm5 1h13v2H8V5zm0 6h13v2H8v-2zm0 6h13v2H8v-2zM3 11h2l-1.5 2H5v1H3v-1l1.5-2H3v-1zm0 6h2v.5H4v1h1V20H3v-3z"/></svg>;
}
function UnorderedListIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="4" cy="6" r="1.5"/><circle cx="4" cy="12" r="1.5"/><circle cx="4" cy="18" r="1.5"/><rect x="8" y="5" width="13" height="2" rx="1"/><rect x="8" y="11" width="13" height="2" rx="1"/><rect x="8" y="17" width="13" height="2" rx="1"/></svg>;
}
function BlockquoteIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h5v5H6.5l-1 4H4l1-4H4V5zm10 0h5v5h-2.5l-1 4H14l1-4h-1V5z"/></svg>;
}
function SendIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>;
}
function PlusCircleIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>;
}

function TypingIndicator({ channelId, currentUserId }: { channelId: string; currentUserId: string }) {
  const { t } = useTranslation();
  const typing = useMessageStore((s) => s.typing);
  const clearTyping = useMessageStore((s) => s.clearTyping);

  const typingUsers = (typing.get(channelId) ?? []).filter(
    (u) => u.userId !== currentUserId,
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const user of typingUsers) {
        if (now - user.timestamp > TYPING_EXPIRY_MS) {
          clearTyping(channelId, user.userId);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [channelId, typingUsers, clearTyping]);

  if (typingUsers.length === 0) return null;

  let text: string;
  if (typingUsers.length === 1) {
    text = t('messages.typingOne', '{{name}} is typing...', { name: typingUsers[0].username });
  } else if (typingUsers.length === 2) {
    text = t('messages.typingTwo', '{{name1}} and {{name2}} are typing...', {
      name1: typingUsers[0].username,
      name2: typingUsers[1].username,
    });
  } else {
    text = t('messages.typingSeveral', 'Several people are typing...');
  }

  return <div className="typing-indicator">{text}</div>;
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
}: Props) {
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

  useEffect(() => {
    if (editingMessage) {
      setValue(editingMessage.content);
      textareaRef.current?.focus();
    }
  }, [editingMessage]);

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
        if (e.key === 'b') {
          e.preventDefault();
          applyFormatting(textareaRef.current, 'bold', setValue);
          return;
        }
        if (e.key === 'i') {
          e.preventDefault();
          applyFormatting(textareaRef.current, 'italic', setValue);
          return;
        }
        if (e.key === 'e') {
          e.preventDefault();
          applyFormatting(textareaRef.current, 'code', setValue);
          return;
        }
        if (e.shiftKey && e.key === 'x') {
          e.preventDefault();
          applyFormatting(textareaRef.current, 'strikethrough', setValue);
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

  const handleFormat = (format: FormatType) => {
    if (textareaRef.current) {
      applyFormatting(textareaRef.current, format, setValue);
    }
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

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      className={`message-input-wrapper ${dragging ? 'message-input-dragging' : ''}`}
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

        {/* Row 1: Formatting toolbar (top) */}
        <div className="message-input-format-bar">
          <button className="toolbar-btn" title={t('format.bold', 'Bold (Ctrl+B)')} onClick={() => handleFormat('bold')}>
            <BoldIcon />
          </button>
          <button className="toolbar-btn" title={t('format.italic', 'Italic (Ctrl+I)')} onClick={() => handleFormat('italic')}>
            <ItalicIcon />
          </button>
          <button className="toolbar-btn" title={t('format.strikethrough', 'Strikethrough (Ctrl+Shift+X)')} onClick={() => handleFormat('strikethrough')}>
            <StrikethroughIcon />
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" title={t('format.link', 'Link')} onClick={() => handleFormat('link')}>
            <LinkIcon width={18} height={18} strokeWidth={2} />
          </button>
          <button className="toolbar-btn" title={t('format.orderedList', 'Ordered List')} onClick={() => handleFormat('ordered-list')}>
            <OrderedListIcon />
          </button>
          <button className="toolbar-btn" title={t('format.unorderedList', 'Bulleted List')} onClick={() => handleFormat('unordered-list')}>
            <UnorderedListIcon />
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" title={t('format.blockquote', 'Blockquote')} onClick={() => handleFormat('blockquote')}>
            <BlockquoteIcon />
          </button>
          <button className="toolbar-btn" title={t('format.code', 'Code (Ctrl+E)')} onClick={() => handleFormat('code')}>
            <CodeIcon />
          </button>
          <button className="toolbar-btn" title={t('format.codeBlock', 'Code Block')} onClick={() => handleFormat('code-block')}>
            <CodeBlockIcon />
          </button>
        </div>

        {/* Row 2: Textarea (middle) */}
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

        {pendingFiles.length > 0 && (
          <div className="message-input-file-previews">
            {pendingFiles.map((pf, idx) => (
              <div key={idx} className="message-input-file-preview">
                {pf.preview ? (
                  <img src={pf.preview} alt={pf.file.name} className="file-preview-thumb" />
                ) : (
                  <span className="file-preview-icon"><Page width={20} height={20} strokeWidth={2} /></span>
                )}
                <div className="file-preview-details">
                  <span className="file-preview-name">{pf.file.name}</span>
                  <span className="file-preview-size">{formatFileSize(pf.file.size)}</span>
                </div>
                <button className="file-preview-remove" onClick={() => removeFile(idx)} title="Remove">
                  <Xmark width={16} height={16} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        )}

        {uploadError && <div className="message-input-upload-error">{uploadError}</div>}

        {/* Row 3: Action bar (bottom) */}
        <div className="message-input-action-bar">
          <div className="toolbar-group">
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
              className="toolbar-btn"
              title={t('upload.attachFile', 'Attach File')}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? <Hourglass width={18} height={18} strokeWidth={2} /> : <PlusCircleIcon />}
            </button>
            <div style={{ position: 'relative' }}>
              {showEmojiPicker && (
                <EmojiPicker
                  onSelect={handleEmojiSelect}
                  onClose={() => setShowEmojiPicker(false)}
                  anchorRef={emojiBtnRef}
                />
              )}
              <button ref={emojiBtnRef} className="toolbar-btn" title={t('messages.emoji', 'Emoji')} onClick={() => setShowEmojiPicker(v => !v)} disabled={uploading}>
                <Emoji width={18} height={18} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          <div className="send-area">
            <div className="send-divider" />
            <button
              className={`toolbar-send-btn ${hasContent ? 'has-content' : ''}`}
              title={t('messages.send', 'Send Message')}
              onClick={handleSend}
              disabled={!hasContent || uploading}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>

      {uploading && <div className="message-input-uploading">{t('upload.uploading', 'Uploading...')}</div>}
    </div>
  );
}
