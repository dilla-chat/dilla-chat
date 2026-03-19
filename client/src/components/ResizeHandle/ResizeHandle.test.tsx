import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import ResizeHandle from './ResizeHandle';

describe('ResizeHandle', () => {
  it('renders the handle element', () => {
    const { container } = render(<ResizeHandle onResize={vi.fn()} />);
    expect(container.querySelector('.resize-handle')).toBeInTheDocument();
  });

  it('does not have dragging class initially', () => {
    const { container } = render(<ResizeHandle onResize={vi.fn()} />);
    expect(container.querySelector('.resize-handle')).not.toHaveClass('dragging');
  });

  it('adds dragging class on mousedown', () => {
    const { container } = render(<ResizeHandle onResize={vi.fn()} />);
    const handle = container.querySelector('.resize-handle')!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    expect(handle).toHaveClass('dragging');
  });

  it('calls onResize with delta during drag', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const handle = container.querySelector('.resize-handle')!;

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 120 });

    expect(onResize).toHaveBeenCalledWith(20);
  });

  it('calls onResizeEnd on mouseup', () => {
    const onResizeEnd = vi.fn();
    const { container } = render(<ResizeHandle onResize={vi.fn()} onResizeEnd={onResizeEnd} />);
    const handle = container.querySelector('.resize-handle')!;

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseUp(document);

    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('removes dragging class on mouseup', () => {
    const { container } = render(<ResizeHandle onResize={vi.fn()} />);
    const handle = container.querySelector('.resize-handle')!;

    fireEvent.mouseDown(handle, { clientX: 100 });
    expect(handle).toHaveClass('dragging');

    fireEvent.mouseUp(document);
    expect(handle).not.toHaveClass('dragging');
  });

  it('sets cursor and user-select on body during drag', () => {
    const { container } = render(<ResizeHandle onResize={vi.fn()} />);
    const handle = container.querySelector('.resize-handle')!;

    fireEvent.mouseDown(handle, { clientX: 100 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');

    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('tracks cumulative deltas across multiple mousemove events', () => {
    const onResize = vi.fn();
    const { container } = render(<ResizeHandle onResize={onResize} />);
    const handle = container.querySelector('.resize-handle')!;

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 110 });
    fireEvent.mouseMove(document, { clientX: 130 });

    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenNthCalledWith(1, 10);
    expect(onResize).toHaveBeenNthCalledWith(2, 20);
  });
});
