"use client";

import { useRef, useState } from "react";
import { errorMessage, jsonRequest, routingRequest } from "@/lib/routing-client";
import { parseRetentionDays, RETENTION_SETTING, type RetentionDays } from "../../../proxy/src/core/history-retention";

export function useHistoryRetention(initial: RetentionDays) {
  const [days, setDays] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const save = async (value: string) => {
    if (locked.current || value === String(days)) return;
    locked.current = true;
    setSaving(true); setError(null);
    try {
      parseRetentionDays(value);
      const result = await routingRequest<{ history_retention_days: RetentionDays }>("/api/settings", jsonRequest("PUT", { key: RETENTION_SETTING, value }));
      setDays(parseRetentionDays(String(result.history_retention_days)));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { locked.current = false; setSaving(false); }
  };
  return { days, saving, error, save };
}
