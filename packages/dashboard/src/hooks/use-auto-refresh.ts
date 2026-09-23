"use client";

import { useEffect } from "react";

export function useAutoRefresh(intervalMs: number, refresh: () => void, pending: boolean) {
  useEffect(() => {
    if (intervalMs === 0 || pending) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, refresh, pending]);
}
