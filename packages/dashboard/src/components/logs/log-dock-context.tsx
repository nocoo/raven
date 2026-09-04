"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

interface LogDockContextValue {
  isOpen: boolean;
  requestIdFilter: string | null;
  openLogs: (requestId?: string) => void;
  closeLogs: () => void;
  toggleLogs: () => void;
  setRequestIdFilter: (requestId: string | null) => void;
}

const LogDockContext = createContext<LogDockContextValue | null>(null);

export function LogDockProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [requestIdFilter, setRequestIdFilter] = useState<string | null>(null);

  const openLogs = useCallback((requestId?: string) => {
    if (requestId !== undefined) {
      setRequestIdFilter(requestId);
    }
    setIsOpen(true);
  }, []);

  const closeLogs = useCallback(() => {
    setIsOpen(false);
  }, []);

  const toggleLogs = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const value = useMemo(
    () => ({
      isOpen,
      requestIdFilter,
      openLogs,
      closeLogs,
      toggleLogs,
      setRequestIdFilter,
    }),
    [isOpen, requestIdFilter, openLogs, closeLogs, toggleLogs],
  );

  return (
    <LogDockContext.Provider value={value}>
      {children}
    </LogDockContext.Provider>
  );
}

export function useLogDock(): LogDockContextValue {
  const context = useContext(LogDockContext);
  if (!context) {
    throw new Error("useLogDock must be used within a LogDockProvider");
  }
  return context;
}
