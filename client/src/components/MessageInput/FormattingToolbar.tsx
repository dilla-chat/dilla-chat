import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as LinkIcon } from 'iconoir-react';

export type FormatType =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'code-block'
  | 'ordered-list'
  | 'unordered-list'
  | 'blockquote'
  | 'link';

export const FORMAT_KEY_MAP: Record<string, FormatType> = {
  b: 'bold',
  i: 'italic',
  e: 'code',
};

export function getFormatTypeForKey(key: string, shiftKey: boolean): FormatType | null {
  if (shiftKey && key === 'x') return 'strikethrough';
  return FORMAT_KEY_MAP[key] ?? null;
}

export function applyFormatting(
  textarea: HTMLTextAreaElement,
  format: FormatType,
  setValue: (fn: (prev: string) => string) => void,
) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);

  let before = value.slice(0, start);
  const after = value.slice(end);
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
    let selStartOffset: number;
    if (format === 'link') selStartOffset = 1;
    else if (format === 'bold' || format === 'strikethrough') selStartOffset = 2;
    else selStartOffset = 1;

    let selEndOffset: number;
    if (format === 'link') selEndOffset = 5;
    else if (format === 'bold' || format === 'strikethrough') selEndOffset = 2;
    else selEndOffset = 1;

    textarea.selectionStart = selected ? pos : before.length + selStartOffset;
    textarea.selectionEnd = selected ? pos : before.length + replacement.length - selEndOffset;
    textarea.focus();
  });
}

// Toolbar formatting icons as inline SVGs
function BoldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 4h8a4 4 0 0 1 2.83 6.83A4 4 0 0 1 15 20H6V4zm3 7h5a1.5 1.5 0 0 0 0-3H9v3zm0 3v3h6a1.5 1.5 0 0 0 0-3H9z" />
    </svg>
  );
}
function ItalicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 4h8l-1 2h-2.6l-4 12H13l-1 2H4l1-2h2.6l4-12H9l1-2z" />
    </svg>
  );
}
function StrikethroughIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 12h18v2H3v-2zm5-6h8a3 3 0 0 1 .75 5.91A3 3 0 0 1 16 18H8a3 3 0 0 1-.75-5.91A3 3 0 0 1 8 6zm0 2a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2H8zm0 6a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2H8z" />
    </svg>
  );
}
function CodeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function CodeBlockIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <polyline points="14 8 18 12 14 16" />
      <polyline points="10 16 6 12 10 8" />
    </svg>
  );
}
function OrderedListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 4h2v5H4V5H3V4zm5 1h13v2H8V5zm0 6h13v2H8v-2zm0 6h13v2H8v-2zM3 11h2l-1.5 2H5v1H3v-1l1.5-2H3v-1zm0 6h2v.5H4v1h1V20H3v-3z" />
    </svg>
  );
}
function UnorderedListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="4" cy="6" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="4" cy="18" r="1.5" />
      <rect x="8" y="5" width="13" height="2" rx="1" />
      <rect x="8" y="11" width="13" height="2" rx="1" />
      <rect x="8" y="17" width="13" height="2" rx="1" />
    </svg>
  );
}
function BlockquoteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 5h5v5H6.5l-1 4H4l1-4H4V5zm10 0h5v5h-2.5l-1 4H14l1-4h-1V5z" />
    </svg>
  );
}
function PlusCircleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
    </svg>
  );
}

interface FormattingToolbarProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setValue: (fn: (prev: string) => string) => void;
}

export default function FormattingToolbar({ textareaRef, setValue }: Readonly<FormattingToolbarProps>) {
  const { t } = useTranslation();

  const handleFormat = (format: FormatType) => {
    if (textareaRef.current) {
      applyFormatting(textareaRef.current, format, setValue);
    }
  };

  return (
    <div className="message-input-format-bar">
      <button
        className="toolbar-btn"
        title={t('format.bold', 'Bold (Ctrl+B)')}
        onClick={() => handleFormat('bold')}
      >
        <BoldIcon />
      </button>
      <button
        className="toolbar-btn"
        title={t('format.italic', 'Italic (Ctrl+I)')}
        onClick={() => handleFormat('italic')}
      >
        <ItalicIcon />
      </button>
      <button
        className="toolbar-btn"
        title={t('format.strikethrough', 'Strikethrough (Ctrl+Shift+X)')}
        onClick={() => handleFormat('strikethrough')}
      >
        <StrikethroughIcon />
      </button>
      <div className="toolbar-divider" />
      <button
        className="toolbar-btn"
        title={t('format.link', 'Link')}
        onClick={() => handleFormat('link')}
      >
        <LinkIcon width={18} height={18} strokeWidth={2} />
      </button>
      <button
        className="toolbar-btn"
        title={t('format.orderedList', 'Ordered List')}
        onClick={() => handleFormat('ordered-list')}
      >
        <OrderedListIcon />
      </button>
      <button
        className="toolbar-btn"
        title={t('format.unorderedList', 'Bulleted List')}
        onClick={() => handleFormat('unordered-list')}
      >
        <UnorderedListIcon />
      </button>
      <div className="toolbar-divider" />
      <button
        className="toolbar-btn"
        title={t('format.blockquote', 'Blockquote')}
        onClick={() => handleFormat('blockquote')}
      >
        <BlockquoteIcon />
      </button>
      <button
        className="toolbar-btn"
        title={t('format.code', 'Code (Ctrl+E)')}
        onClick={() => handleFormat('code')}
      >
        <CodeIcon />
      </button>
      <button
        className="toolbar-btn"
        title={t('format.codeBlock', 'Code Block')}
        onClick={() => handleFormat('code-block')}
      >
        <CodeBlockIcon />
      </button>
    </div>
  );
}

export { PlusCircleIcon };
