import { describe, it, expect, vi } from 'vitest';
import { FORMAT_KEY_MAP, getFormatTypeForKey, applyFormatting, FormatType } from './formatting';

function createMockTextarea(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): HTMLTextAreaElement {
  return {
    value,
    selectionStart,
    selectionEnd,
    focus: vi.fn(),
  } as unknown as HTMLTextAreaElement;
}

describe('FORMAT_KEY_MAP', () => {
  it('maps b to bold', () => {
    expect(FORMAT_KEY_MAP.b).toBe('bold');
  });

  it('maps i to italic', () => {
    expect(FORMAT_KEY_MAP.i).toBe('italic');
  });

  it('maps e to code', () => {
    expect(FORMAT_KEY_MAP.e).toBe('code');
  });

  it('has exactly 3 entries', () => {
    expect(Object.keys(FORMAT_KEY_MAP)).toHaveLength(3);
  });
});

describe('getFormatTypeForKey', () => {
  it('returns bold for key b', () => {
    expect(getFormatTypeForKey('b', false)).toBe('bold');
  });

  it('returns italic for key i', () => {
    expect(getFormatTypeForKey('i', false)).toBe('italic');
  });

  it('returns code for key e', () => {
    expect(getFormatTypeForKey('e', false)).toBe('code');
  });

  it('returns strikethrough for shift+x', () => {
    expect(getFormatTypeForKey('x', true)).toBe('strikethrough');
  });

  it('returns null for unknown key', () => {
    expect(getFormatTypeForKey('z', false)).toBeNull();
  });

  it('returns null for x without shift', () => {
    expect(getFormatTypeForKey('x', false)).toBeNull();
  });

  it('returns bold even when shift is pressed', () => {
    expect(getFormatTypeForKey('b', true)).toBe('bold');
  });
});

describe('applyFormatting', () => {
  function apply(
    value: string,
    selStart: number,
    selEnd: number,
    format: FormatType,
  ): { result: string; setValueCalled: boolean } {
    const textarea = createMockTextarea(value, selStart, selEnd);
    let result = '';
    let setValueCalled = false;
    const setValue = vi.fn((fn: (prev: string) => string) => {
      result = fn('');
      setValueCalled = true;
    });
    applyFormatting(textarea, format, setValue);
    return { result, setValueCalled };
  }

  describe('bold', () => {
    it('wraps selected text in **', () => {
      const { result } = apply('hello world', 6, 11, 'bold');
      expect(result).toBe('hello **world**');
    });

    it('inserts placeholder when no selection', () => {
      const { result } = apply('hello ', 6, 6, 'bold');
      expect(result).toBe('hello **bold text**');
    });

    it('works at start of empty string', () => {
      const { result } = apply('', 0, 0, 'bold');
      expect(result).toBe('**bold text**');
    });
  });

  describe('italic', () => {
    it('wraps selected text in _', () => {
      const { result } = apply('hello world', 6, 11, 'italic');
      expect(result).toBe('hello _world_');
    });

    it('inserts placeholder when no selection', () => {
      const { result } = apply('', 0, 0, 'italic');
      expect(result).toBe('_italic text_');
    });
  });

  describe('strikethrough', () => {
    it('wraps selected text in ~~', () => {
      const { result } = apply('hello world', 6, 11, 'strikethrough');
      expect(result).toBe('hello ~~world~~');
    });

    it('inserts placeholder when no selection', () => {
      const { result } = apply('', 0, 0, 'strikethrough');
      expect(result).toBe('~~strikethrough~~');
    });
  });

  describe('code', () => {
    it('wraps selected text in backticks', () => {
      const { result } = apply('hello world', 6, 11, 'code');
      expect(result).toBe('hello `world`');
    });

    it('inserts placeholder when no selection', () => {
      const { result } = apply('', 0, 0, 'code');
      expect(result).toBe('`code`');
    });
  });

  describe('code-block', () => {
    it('wraps selected text in triple backticks', () => {
      const { result } = apply('hello world', 6, 11, 'code-block');
      expect(result).toBe('hello ```\nworld\n```');
    });

    it('inserts placeholder when no selection', () => {
      const { result } = apply('', 0, 0, 'code-block');
      expect(result).toBe('```\ncode\n```');
    });
  });

  describe('link', () => {
    it('wraps selected text as link label', () => {
      const { result } = apply('hello world', 6, 11, 'link');
      expect(result).toBe('hello [world](url)');
    });

    it('inserts placeholder when no selection', () => {
      const { result } = apply('', 0, 0, 'link');
      expect(result).toBe('[link text](url)');
    });
  });

  describe('ordered-list', () => {
    it('prepends 1. to current line', () => {
      const { result } = apply('hello', 0, 0, 'ordered-list');
      expect(result).toBe('1. hello');
    });

    it('prepends 1. with selected text', () => {
      const { result } = apply('hello world', 6, 11, 'ordered-list');
      expect(result).toBe('1. hello world');
    });

    it('handles multiline - prepends to current line only', () => {
      const { result } = apply('first\nsecond', 6, 12, 'ordered-list');
      expect(result).toBe('first\n1. second');
    });
  });

  describe('unordered-list', () => {
    it('prepends - to current line', () => {
      const { result } = apply('hello', 0, 0, 'unordered-list');
      expect(result).toBe('- hello');
    });

    it('handles multiline - prepends to current line only', () => {
      const { result } = apply('first\nsecond', 6, 12, 'unordered-list');
      expect(result).toBe('first\n- second');
    });
  });

  describe('blockquote', () => {
    it('prepends > to current line', () => {
      const { result } = apply('hello', 0, 0, 'blockquote');
      expect(result).toBe('> hello');
    });

    it('handles multiline - prepends to current line only', () => {
      const { result } = apply('first\nsecond', 6, 12, 'blockquote');
      expect(result).toBe('first\n> second');
    });
  });

  describe('setValue callback', () => {
    it('calls setValue with a function', () => {
      const textarea = createMockTextarea('', 0, 0);
      const setValue = vi.fn();
      applyFormatting(textarea, 'bold', setValue);
      expect(setValue).toHaveBeenCalledTimes(1);
      expect(typeof setValue.mock.calls[0][0]).toBe('function');
    });
  });

  describe('cursor positioning via requestAnimationFrame', () => {
    it('schedules cursor restore and focus via requestAnimationFrame', () => {
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
      const textarea = createMockTextarea('hello', 0, 5, );
      const setValue = vi.fn();
      applyFormatting(textarea, 'bold', setValue);

      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(typeof rafSpy.mock.calls[0][0]).toBe('function');

      // Execute the rAF callback
      const callback = rafSpy.mock.calls[0][0] as FrameRequestCallback;
      callback(0);

      expect(textarea.focus).toHaveBeenCalled();
      // With selected text "hello", cursor should be at end of replacement
      expect(textarea.selectionStart).toBe('**hello**'.length);
      expect(textarea.selectionEnd).toBe('**hello**'.length);

      rafSpy.mockRestore();
    });

    it('selects placeholder text when no selection for bold', () => {
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
      const textarea = createMockTextarea('', 0, 0);
      const setValue = vi.fn();
      applyFormatting(textarea, 'bold', setValue);

      const callback = rafSpy.mock.calls[0][0] as FrameRequestCallback;
      callback(0);

      // Should select "bold text" inside the ** markers
      expect(textarea.selectionStart).toBe(2); // after **
      expect(textarea.selectionEnd).toBe(11); // before **

      rafSpy.mockRestore();
    });

    it('selects placeholder text when no selection for italic', () => {
      const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
      const textarea = createMockTextarea('', 0, 0);
      const setValue = vi.fn();
      applyFormatting(textarea, 'italic', setValue);

      const callback = rafSpy.mock.calls[0][0] as FrameRequestCallback;
      callback(0);

      expect(textarea.selectionStart).toBe(1); // after _
      expect(textarea.selectionEnd).toBe(12); // before _

      rafSpy.mockRestore();
    });

    it('selects placeholder text when no selection for link', () => {
      const callbacks: FrameRequestCallback[] = [];
      const rafSpy = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation((cb) => {
          callbacks.push(cb);
          return 0;
        });
      const textarea = createMockTextarea('', 0, 0);
      const setValue = vi.fn();
      applyFormatting(textarea, 'link', setValue);

      callbacks[0](0);

      // link: selStartOffset=1, replacement='[link text](url)' (16), selEndOffset=5 → end=11
      expect(textarea.selectionStart).toBe(1);
      expect(textarea.selectionEnd).toBe(11);

      rafSpy.mockRestore();
    });

    it('selects placeholder text when no selection for strikethrough', () => {
      const callbacks: FrameRequestCallback[] = [];
      const rafSpy = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation((cb) => {
          callbacks.push(cb);
          return 0;
        });
      const textarea = createMockTextarea('', 0, 0);
      const setValue = vi.fn();
      applyFormatting(textarea, 'strikethrough', setValue);

      callbacks[0](0);

      // strikethrough: selStartOffset=2, replacement='~~strikethrough~~' (17), selEndOffset=2 → end=15
      expect(textarea.selectionStart).toBe(2);
      expect(textarea.selectionEnd).toBe(15);

      rafSpy.mockRestore();
    });

    it('selects placeholder text when no selection for code', () => {
      const callbacks: FrameRequestCallback[] = [];
      const rafSpy = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation((cb) => {
          callbacks.push(cb);
          return 0;
        });
      const textarea = createMockTextarea('', 0, 0);
      const setValue = vi.fn();
      applyFormatting(textarea, 'code', setValue);

      callbacks[0](0);

      // code: selStartOffset=1, replacement='`code`' (6), selEndOffset=1 → end=5
      expect(textarea.selectionStart).toBe(1);
      expect(textarea.selectionEnd).toBe(5);

      rafSpy.mockRestore();
    });
  });

  describe('edge cases', () => {
    it('preserves text before and after selection', () => {
      const { result } = apply('abc def ghi', 4, 7, 'bold');
      expect(result).toBe('abc **def** ghi');
    });

    it('handles formatting in middle of text', () => {
      const { result } = apply('start middle end', 6, 12, 'italic');
      expect(result).toBe('start _middle_ end');
    });

    it('does nothing for an unknown format type', () => {
      const textarea = createMockTextarea('hello', 0, 5);
      const setValue = vi.fn();
      applyFormatting(textarea, 'unknown' as FormatType, setValue);
      expect(setValue).not.toHaveBeenCalled();
    });
  });
});
