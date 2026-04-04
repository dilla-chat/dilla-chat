import { memo } from 'react';

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
      className={`bg-surface-tertiary animate-pulse-skeleton ${className}`}
      style={{ width, height, borderRadius }}
      aria-hidden="true"
    />
  );
});
