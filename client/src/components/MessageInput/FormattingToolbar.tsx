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

const toolbarBtnClass =
  'bg-transparent border-none text-interactive p-0 w-7 h-7 flex items-center justify-center shrink-0 text-sm font-semibold font-sans clickable hover:text-interactive-hover [&_svg]:w-[18px] [&_svg]:h-[18px]';

export default function FormattingToolbar({ textareaRef, setValue }: Readonly<FormattingToolbarProps>) {
  const { t } = useTranslation();

  const handleFormat = (format: FormatType) => {
    if (textareaRef.current) {
      applyFormatting(textareaRef.current, format, setValue);
    }
  };

  return (
    <div className="flex items-center px-2.5 py-1.5 gap-0.5 max-md:flex-nowrap max-md:overflow-x-auto">
      <button
        className={toolbarBtnClass}
        title={t('format.bold', 'Bold (Ctrl+B)')}
        onClick={() => handleFormat('bold')}
      >
        <BoldIcon />
      </button>
      <button
        className={toolbarBtnClass}
        title={t('format.italic', 'Italic (Ctrl+I)')}
        onClick={() => handleFormat('italic')}
      >
        <ItalicIcon />
      </button>
      <button
        className={toolbarBtnClass}
        title={t('format.strikethrough', 'Strikethrough (Ctrl+Shift+X)')}
        onClick={() => handleFormat('strikethrough')}
      >
        <StrikethroughIcon />
      </button>
      <div className="w-px h-5 bg-divider mx-1 shrink-0" />
      <button
        className={toolbarBtnClass}
        title={t('format.link', 'Link')}
        onClick={() => handleFormat('link')}
      >
        <LinkIcon width={18} height={18} strokeWidth={2} />
      </button>
      <button
        className={toolbarBtnClass}
        title={t('format.orderedList', 'Ordered List')}
        onClick={() => handleFormat('ordered-list')}
      >
        <OrderedListIcon />
      </button>
      <button
        className={toolbarBtnClass}
        title={t('format.unorderedList', 'Bulleted List')}
        onClick={() => handleFormat('unordered-list')}
      >
        <UnorderedListIcon />
      </button>
      <div className="w-px h-5 bg-divider mx-1 shrink-0" />
      <button
        className={toolbarBtnClass}
        title={t('format.blockquote', 'Blockquote')}
        onClick={() => handleFormat('blockquote')}
      >
        <BlockquoteIcon />
      </button>
      <button
        className={toolbarBtnClass}
        title={t('format.code', 'Code (Ctrl+E)')}
        onClick={() => handleFormat('code')}
      >
        <CodeIcon />
      </button>
      <button
        className={toolbarBtnClass}
        title={t('format.codeBlock', 'Code Block')}
        onClick={() => handleFormat('code-block')}
      >
        <CodeBlockIcon />
      </button>
    </div>
  );
}
