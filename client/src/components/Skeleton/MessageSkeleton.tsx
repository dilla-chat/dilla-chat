import { memo, useMemo } from 'react';
import Skeleton from './Skeleton';
import './Skeleton.css';

interface Props {
  count?: number;
}

const CONTENT_WIDTHS = ['75%', '90%', '60%', '85%', '70%'];

export default memo(function MessageSkeleton({ count = 5 }: Readonly<Props>) {
  const items = useMemo(
    () => Array.from({ length: count }, (_, i) => CONTENT_WIDTHS[i % CONTENT_WIDTHS.length]),
    [count],
  );

  return (
    <>
      {items.map((width, i) => (
        <div key={i} className="skeleton-message">
          <Skeleton
            width={34}
            height={34}
            borderRadius="var(--radius-md)"
            className="skeleton-message-avatar"
          />
          <div className="skeleton-message-content">
            <div className="skeleton-message-meta">
              <Skeleton width={80} height={12} borderRadius={3} />
              <Skeleton width={40} height={10} borderRadius={3} />
            </div>
            <Skeleton width={width} height={12} borderRadius={3} />
          </div>
        </div>
      ))}
    </>
  );
});
