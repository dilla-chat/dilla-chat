/**
 * Browser-mode tests for MessageInput CSS behaviors:
 * focus-within border/shadow, absolute positioning, file preview truncation, drag overlay.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../../styles/theme.css';

describe('MessageInput focus-within', () => {
  test('focus-within changes border and shadow', async () => {
    const screen = await render(
      <div style={{ position: 'relative', width: '100%', height: '200px' }}>
        <div className="message-input-wrapper">
          <div className="message-input-composer" data-testid="composer">
            <div className="message-input-textarea-area">
              <textarea className="message-input-textarea" data-testid="textarea" />
            </div>
          </div>
        </div>
      </div>,
    );

    // Focus the textarea to trigger :focus-within
    const textarea = screen.getByTestId('textarea');
    await textarea.click();
    // Allow transition to complete
    await new Promise((r) => setTimeout(r, 200));

    const el = document.querySelector('[data-testid="composer"]');
    const style = getComputedStyle(el!);
    const borderColor = style.borderColor;
    const shadow = style.boxShadow;

    // Border should change to brand color rgb(46, 139, 154)
    expect(borderColor).toBe('rgb(46, 139, 154)');
    // Box shadow should be present
    expect(shadow).not.toBe('none');
  });
});

describe('MessageInput positioning', () => {
  test('wrapper is absolute positioned at bottom', async () => {
    const screen = await render(
      <div style={{ position: 'relative', width: '100%', height: '400px' }}>
        <div className="message-input-wrapper" data-testid="wrapper">
          <div className="message-input-composer">
            <div className="message-input-textarea-area">
              <textarea className="message-input-textarea" />
            </div>
          </div>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('wrapper')).toHaveStyle({
      position: 'absolute',
      bottom: '0px',
      zIndex: '10',
    });
  });
});

describe('MessageInput file preview truncation', () => {
  test('file-preview-name truncates', async () => {
    const screen = await render(
      <div className="message-input-file-preview" style={{ maxWidth: '220px' }}>
        <div className="file-preview-details">
          <span className="file-preview-name" data-testid="file-name">
            this-is-a-very-long-filename-that-should-definitely-truncate.png
          </span>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('file-name')).toHaveStyle({
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    });
  });
});

describe('MessageInput drag overlay', () => {
  test('drag overlay covers full area', async () => {
    const screen = await render(
      <div style={{ position: 'relative', width: '400px', height: '200px' }}>
        <div className="message-input-drag-overlay" data-testid="drag-overlay">
          Drop files here
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('drag-overlay')).toHaveStyle({
      position: 'absolute',
      inset: '0px',
    });
  });
});
