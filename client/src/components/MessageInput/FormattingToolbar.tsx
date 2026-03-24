import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link as LinkIcon } from 'iconoir-react';
import { type FormatType, applyFormatting } from './formatting';
import {
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  CodeIcon,
  CodeBlockIcon,
  OrderedListIcon,
  UnorderedListIcon,
  BlockquoteIcon,
} from './Icons';

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
