import { memo, useMemo } from 'react';
import Skeleton from './Skeleton';

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
        <div key={width} data-testid="skeleton-message" className="flex items-start gap-3 py-2 px-4">
          <Skeleton width={36} height={36} borderRadius="50%" />
          <div className="flex flex-col gap-2 flex-1">
            <Skeleton width={120} height={14} />
            <Skeleton width={width} height={14} />
          </div>
        </div>
      ))}
    </>
  );
});
