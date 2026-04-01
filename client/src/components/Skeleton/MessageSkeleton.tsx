import { memo, useMemo } from 'react';
import Skeleton from './Skeleton';
import './Skeleton.css';

interface Props {
  count?: number;
}

const WIDTHS = ['75%', '90%', '60%', '85%', '70%'];

export default memo(function MessageSkeleton({ count = 5 }: Readonly<Props>) {
  const items = useMemo(
    () => Array.from({ length: count }, (_, i) => WIDTHS[i % WIDTHS.length]),
    [count],
  );

  return (
    <>
      {items.map((width) => (
        <div key={width} className="skeleton-message">
          <Skeleton width={36} height={36} borderRadius="50%" className="skeleton-message-avatar" />
          <div className="skeleton-message-content">
            <Skeleton width={120} height={14} />
            <Skeleton width={width} height={14} />
          </div>
        </div>
      ))}
    </>
  );
});
