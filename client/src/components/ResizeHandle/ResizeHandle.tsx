import { useCallback, useEffect, useRef, useState } from 'react';
import './ResizeHandle.css';

interface ResizeHandleProps {
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
  side?: 'left' | 'right';
}

export default function ResizeHandle({ onResize, onResizeEnd, side = 'left' }: Readonly<ResizeHandleProps>) {
  const [dragging, setDragging] = useState(false);
  const lastX = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    lastX.current = e.clientX;
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setDragging(false);
      onResizeEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging, onResize, onResizeEnd]);

  return (
    <button
      type="button"
      className={`resize-handle ${dragging ? 'dragging' : ''}`}
      aria-label="Resize panel"
      data-side={side}
      onMouseDown={handleMouseDown}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onResize(-10);
        else if (e.key === 'ArrowRight') onResize(10);
      }}
      data-testid="resize-handle"
    />
  );
}
