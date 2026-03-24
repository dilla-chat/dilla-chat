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
