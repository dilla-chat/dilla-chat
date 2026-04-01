import { memo } from 'react';
import './Skeleton.css';

interface Props {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
}

export default memo(function Skeleton({
  width = '100%',
  height = '1rem',
  borderRadius = 4,
  className = '',
}: Readonly<Props>) {
  return (
    <div
      className={`skeleton ${className}`}
      style={{ width, height, borderRadius }}
      aria-hidden="true"
    />
  );
});
