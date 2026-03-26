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
  const pullDistRef = useRef(0);
  const refreshingRef = useRef(false);

  pullDistRef.current = pullDistance;
  refreshingRef.current = isRefreshing;

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    refreshingRef.current = true;
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
      refreshingRef.current = false;
      setPullDistance(0);
      pullDistRef.current = 0;
    }
  }, [onRefresh]);

  useEffect(() => {
    if (disabled) return;

    const resetPull = () => {
      pullingRef.current = false;
      setPullDistance(0);
      pullDistRef.current = 0;
    };

    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 5 || refreshingRef.current) return;
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!pullingRef.current || refreshingRef.current) return;
      if (window.scrollY > 5) {
        resetPull();
        return;
      }
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy < 0) {
        setPullDistance(0);
        pullDistRef.current = 0;
        return;
      }
      const dampened = Math.min(dy * 0.5, maxPull);
      setPullDistance(dampened);
      pullDistRef.current = dampened;
      if (dampened > 10) {
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {
      if (!pullingRef.current) return;
      pullingRef.current = false;
      if (pullDistRef.current >= threshold && !refreshingRef.current) {
        handleRefresh();
      } else {
        setPullDistance(0);
        pullDistRef.current = 0;
      }
    };

    const onTouchCancel = () => {
      resetPull();
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [disabled, threshold, maxPull, handleRefresh]);

  return { pullDistance, isRefreshing };
}
