import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import './EmojiPicker.css';

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export default function EmojiPicker({ onSelect, onClose, anchorRef }: Props) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ bottom: number; left: number } | null>(null);

  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
      });
    }
  }, [anchorRef]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const style: React.CSSProperties = position
    ? { position: 'fixed', bottom: position.bottom, left: position.left }
    : { position: 'absolute', bottom: '100%', left: 0 };

  const picker = (
    <div className="emoji-picker-container" ref={pickerRef} style={style}>
      <Picker
        data={data}
        onEmojiSelect={(emoji: any) => onSelect(emoji.native)}
        theme="dark"
        set="native"
        previewPosition="none"
        skinTonePosition="search"
        maxFrequentRows={2}
      />
    </div>
  );

  return position ? createPortal(picker, document.body) : picker;
}
