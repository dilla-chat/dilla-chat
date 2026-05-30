import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import FormattingToolbar from './FormattingToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
}));

vi.mock('@tabler/icons-react', () => ({
  IconLink: () => <span data-testid="icon-link" />,
}));

const applyFormattingMock = vi.fn();
vi.mock('./formatting', () => ({
  applyFormatting: (...args: unknown[]) => applyFormattingMock(...args),
}));

describe('FormattingToolbar', () => {
  beforeEach(() => {
    applyFormattingMock.mockReset();
  });

  function setup() {
    const ref = createRef<HTMLTextAreaElement>();
    // We don't actually render the textarea — the toolbar component only
    // needs to read ref.current. Set it to a stub element.
    (ref as { current: HTMLTextAreaElement | null }).current = document.createElement('textarea');
    const setValue = vi.fn();
    const utils = render(<FormattingToolbar textareaRef={ref} setValue={setValue} />);
    return { ...utils, ref, setValue };
  }

  it('renders nine formatting buttons', () => {
    const { container } = setup();
    expect(container.querySelectorAll('button').length).toBe(9);
  });

  it.each([
    ['Bold (Ctrl+B)', 'bold'],
    ['Italic (Ctrl+I)', 'italic'],
    ['Strikethrough (Ctrl+Shift+X)', 'strikethrough'],
    ['Link', 'link'],
    ['Ordered List', 'ordered-list'],
    ['Bulleted List', 'unordered-list'],
    ['Blockquote', 'blockquote'],
    ['Code (Ctrl+E)', 'code'],
    ['Code Block', 'code-block'],
  ])('button title %s calls applyFormatting with %s', (title, expected) => {
    const { container, setValue } = setup();
    const btn = [...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === title)!;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(applyFormattingMock).toHaveBeenCalledTimes(1);
    expect(applyFormattingMock.mock.calls[0][1]).toBe(expected);
    expect(applyFormattingMock.mock.calls[0][2]).toBe(setValue);
  });

  it('skips applyFormatting when the textarea ref is null', () => {
    const setValue = vi.fn();
    const ref = { current: null } as React.RefObject<HTMLTextAreaElement | null>;
    const { container } = render(<FormattingToolbar textareaRef={ref} setValue={setValue} />);
    fireEvent.click(container.querySelector('button')!);
    expect(applyFormattingMock).not.toHaveBeenCalled();
  });
});
