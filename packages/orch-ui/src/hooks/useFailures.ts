import { useCallback, useEffect, useRef, useState } from 'react';

export interface FailureEntry {
  jobId: string;
  entry: {
    startedAt: string;
    exitCode: number | null;
    pid?: number | null;
    triggeredBy?: unknown;
  };
  jobLabel?: string;
}

export function useFailures(apiBase = ''): {
  failures: FailureEntry[];
  acknowledgeOne: (jobId: string) => Promise<void>;
  acknowledgeAll: () => Promise<void>;
} {
  const [failures, setFailures] = useState<FailureEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/failures`);
      if (!res.ok) return;
      const data = await res.json() as FailureEntry[];
      setFailures(data);
    } catch { /* daemon may be unavailable transiently - keep previous state */ }
  }, [apiBase]);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => { void refresh(); }, 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refresh]);

  const acknowledgeAll = useCallback(async () => {
    try {
      await fetch(`${apiBase}/api/failures/ack`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
      setFailures([]);
    } catch { /* ignore */ }
  }, [apiBase]);

  const acknowledgeOne = useCallback(async (jobId: string) => {
    try {
      await fetch(`${apiBase}/api/failures/ack`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
      setFailures(prev => prev.filter(f => f.jobId !== jobId));
    } catch { /* ignore */ }
  }, [apiBase]);

  return { failures, acknowledgeOne, acknowledgeAll };
}
