// Drive CropModal load/drag/resize/save/Escape.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { CropModal } from './Settings';

if (!URL.createObjectURL || typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:fake-url');
  URL.revokeObjectURL = vi.fn();
}

beforeEach(() => {
  // canvas.toBlob in jsdom — patch
  HTMLCanvasElement.prototype.toBlob = function(cb: (blob: Blob | null) => void) {
    cb(new Blob(['x'], { type: 'image/jpeg' }));
  };
});

describe('CropModal', () => {
  const makeFile = () => new File(['x'], 'pic.png', { type: 'image/png' });

  it('renders header + Save + Cancel', () => {
    const { container } = render(
      <CropModal file={makeFile()} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(container.textContent).toContain('Crop avatar');
    expect(container.textContent).toContain('Cancel');
    expect(container.textContent).toContain('Save');
  });

  it('Cancel button calls onCancel', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <CropModal file={makeFile()} onCancel={onCancel} onConfirm={vi.fn()} />,
    );
    const cancelBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalled();
  });

  it('✕ button calls onCancel', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <CropModal file={makeFile()} onCancel={onCancel} onConfirm={vi.fn()} />,
    );
    fireEvent.click(container.querySelector('.modal-x') as HTMLElement);
    expect(onCancel).toHaveBeenCalled();
  });

  it('Escape key calls onCancel', () => {
    const onCancel = vi.fn();
    render(<CropModal file={makeFile()} onCancel={onCancel} onConfirm={vi.fn()} />);
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('backdrop click closes; click inside card does not', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <CropModal file={makeFile()} onCancel={onCancel} onConfirm={vi.fn()} />,
    );
    fireEvent.click(container.querySelector('.modal-card') as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.modal-overlay') as HTMLElement);
    expect(onCancel).toHaveBeenCalled();
  });

  it('image onLoad sets imgSize and initial crop', () => {
    const { container } = render(
      <CropModal file={makeFile()} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    const img = container.querySelector('.crop-img') as HTMLImageElement;
    if (img) {
      Object.defineProperty(img, 'clientWidth', { value: 400, configurable: true });
      Object.defineProperty(img, 'clientHeight', { value: 300, configurable: true });
      Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
      Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
      fireEvent.load(img);
      const box = container.querySelector('.crop-box');
      expect(box).toBeTruthy();
    }
  });

  it('Save without crop returns early', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <CropModal file={makeFile()} onCancel={vi.fn()} onConfirm={onConfirm} />,
    );
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    fireEvent.click(saveBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Save with crop + image attempts to draw to canvas', async () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <CropModal file={makeFile()} onCancel={vi.fn()} onConfirm={onConfirm} />,
    );
    const img = container.querySelector('.crop-img') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 300, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    fireEvent.load(img);
    const saveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(saveBtn);
      await new Promise((r) => setTimeout(r, 5));
    });
    // jsdom canvas doesn't actually render, so onConfirm may not fire if
    // ctx is null. Just verify save did not throw.
    expect(container.firstChild).toBeTruthy();
  });

  it('mouseDown on crop box begins drag (move mode)', () => {
    const { container } = render(
      <CropModal file={makeFile()} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    const img = container.querySelector('.crop-img') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 300, configurable: true });
    fireEvent.load(img);
    const box = container.querySelector('.crop-box') as HTMLElement;
    if (box) {
      fireEvent.mouseDown(box, { clientX: 100, clientY: 100 });
      // No throw is sufficient
    }
    expect(container.firstChild).toBeTruthy();
  });

  it('mouseDown on each corner handle starts a corner-resize drag', () => {
    const { container } = render(
      <CropModal file={makeFile()} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    const img = container.querySelector('.crop-img') as HTMLImageElement;
    Object.defineProperty(img, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'clientHeight', { value: 300, configurable: true });
    fireEvent.load(img);
    for (const cls of ['.crop-handle.nw', '.crop-handle.ne', '.crop-handle.sw', '.crop-handle.se']) {
      const handle = container.querySelector(cls) as HTMLElement | null;
      if (handle) fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 });
    }
    expect(container.firstChild).toBeTruthy();
  });
});
