import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import MessageMarkdown from './MessageMarkdown';

// rehype-highlight + highlight.js CSS imports blow up jsdom — stub them
// out before importing the component.
vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}));

describe('MessageMarkdown', () => {
  it('returns null for empty text', () => {
    const { container } = render(<MessageMarkdown text="" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders plain text inside a paragraph', () => {
    const { container } = render(<MessageMarkdown text="hello world" />);
    expect(container.querySelector('.mm-root')).toBeTruthy();
    expect(container.textContent).toContain('hello world');
  });

  it('renders bold + italic markdown', () => {
    const { container } = render(<MessageMarkdown text="**bold** and *italic*" />);
    expect(container.querySelector('strong')).toBeTruthy();
    expect(container.querySelector('em')).toBeTruthy();
  });

  it('strips heading levels but keeps their text (chat-style)', () => {
    const { container } = render(<MessageMarkdown text="# Big" />);
    // disallowedElements + unwrapDisallowed → the h1 is removed but
    // its inner text bubbles up unchanged.
    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toContain('Big');
  });

  it('preserves @handle text in the rendered output', () => {
    // The mention pre-processor wraps @alice in a special-scheme link.
    // react-markdown's URL sanitizer may strip non-standard schemes
    // (e.g. dilla:) which can disable the chip styling but must NEVER
    // drop the visible @alice text — that would corrupt user content.
    const { container } = render(<MessageMarkdown text="hey @alice" />);
    expect(container.textContent).toContain('@alice');
  });

  it('renders @everyone / @here without crashing', () => {
    const { container } = render(<MessageMarkdown text="hi @everyone and @here" />);
    expect(container.textContent).toContain('@everyone');
    expect(container.textContent).toContain('@here');
  });

  it('accepts currentUserHandle/currentUserId props without crashing', () => {
    const { container } = render(
      <MessageMarkdown text="ping @me" currentUserHandle="me" currentUserId="u1" />,
    );
    expect(container.textContent).toContain('@me');
  });

  it('does NOT match @ inside emails (foo@example.com)', () => {
    const { container } = render(<MessageMarkdown text="mail me foo@example.com" />);
    expect(container.querySelector('.ic-mention')).toBeNull();
  });

  it('external https link gets target=_blank rel="noopener noreferrer"', () => {
    const { container } = render(<MessageMarkdown text="see [docs](https://example.com)" />);
    const a = container.querySelector('a.ic-link') as HTMLAnchorElement;
    expect(a).toBeTruthy();
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });

  it('renders an inline <img> for image URLs (giphy / direct image links)', () => {
    const { container } = render(
      <MessageMarkdown text="[gif](https://media.giphy.com/x.gif)" />,
    );
    expect(container.querySelector('img.mm-inline-image')).toBeTruthy();
  });

  it('renders code blocks with .code-block wrapper', () => {
    const { container } = render(
      <MessageMarkdown text={'```js\nconsole.log(1)\n```'} />,
    );
    expect(container.querySelector('pre.code-block')).toBeTruthy();
  });

  it('inline backtick code stays inline (no <pre>)', () => {
    const { container } = render(<MessageMarkdown text="run `npm test`" />);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code')).toBeTruthy();
  });

  it('GFM tables get wrapped in .mm-table-wrap', () => {
    const md = `| a | b |\n| - | - |\n| 1 | 2 |`;
    const { container } = render(<MessageMarkdown text={md} />);
    expect(container.querySelector('.mm-table-wrap')).toBeTruthy();
    expect(container.querySelector('table')).toBeTruthy();
  });

  it('escapes ] inside the captured mention handle (markdown link parser would otherwise choke)', () => {
    // ] isn't a valid handle char, so the regex stops before it.
    // Still — verifying we don't crash on adversarial input.
    const { container } = render(<MessageMarkdown text="hi @alice]bracket" />);
    expect(container.textContent).toContain('@alice');
  });
});
