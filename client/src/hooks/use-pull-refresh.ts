import { useRef, useEffect, useState, useCallback } from "react";

interface PullRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number;
  maxPull?: number;
  disabled?: boolean;
}

export function usePullRefresh({
  onRefresh,
  threshold = 80,
  maxPull = 130,
  disabled = false,
}: PullRefreshOptions) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
      setPullDistance(0);
    }
  }, [onRefresh]);

  useEffect(() => {
    if (disabled) return;

    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 5) return;
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pullingRef.current || isRefreshing) return;
      if (window.scrollY > 5) {
        pullingRef.current = false;
        setPullDistance(0);
        return;
      }
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy < 0) {
        setPullDistance(0);
        return;
      }
      const dampened = Math.min(dy * 0.5, maxPull);
      setPullDistance(dampened);
      if (dampened > 10) {
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      if (pullDistance >= threshold && !isRefreshing) {
        handleRefresh();
      } else {
        setPullDistance(0);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [disabled, isRefreshing, pullDistance, threshold, maxPull, handleRefresh]);

  return { pullDistance, isRefreshing };
}
