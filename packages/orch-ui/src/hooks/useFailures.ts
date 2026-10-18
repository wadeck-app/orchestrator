import { useCallback, useEffect, useRef, useState } from 'react';
import type { FailureEntry } from '../components/FailureBanner.js';
import { getApiBase } from '../runtime-config.js';
export type { FailureEntry } from '../components/FailureBanner.js';

export function useFailures(apiBase = getApiBase(), refreshMs = 30_000): {
  failures: FailureEntry[];
  acknowledgeOne: (jobId: string) => Promise<void>;
  acknowledgeAll: () => Promise<void>;
} {
  const [failures, setFailures] = useState<FailureEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/failures`);
      if (!res.ok) {
        return;
      }
      const data = await res.json() as FailureEntry[];
      setFailures(data);
    } catch { /* daemon may be unavailable transiently - keep previous state */ }
  }, [apiBase]);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => { void refresh(); }, refreshMs);
    return () => { if (timerRef.current) {
      clearInterval(timerRef.current);
    } };
  }, [refresh, refreshMs]);

  /*
   * A failure leaves the screen only once the server has acknowledged it. Both used to drop the card
   * after any answer, a 503 included, so a failure could vanish from view while still unacknowledged
   * on the server; and the per-job button sent no job id, so the server acknowledged every failure
   * while the screen hid one. On a refusal the card stays, and the next refresh shows the truth.
   */
  const acknowledge = useCallback(async (jobId?: string): Promise<boolean> => {
    try {
      const res = await fetch(`${apiBase}/api/failures/ack`, {
        method: 'POST',
        body: JSON.stringify(jobId === undefined ? {} : { jobId }),
        headers: { 'Content-Type': 'application/json' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }, [apiBase]);

  const acknowledgeAll = useCallback(async () => {
    if (await acknowledge()) {
      setFailures([]);
    }
  }, [acknowledge]);

  const acknowledgeOne = useCallback(async (jobId: string) => {
    if (await acknowledge(jobId)) {
      setFailures(prev => prev.filter(f => f.jobId !== jobId));
    }
  }, [acknowledge]);

  return { failures, acknowledgeOne, acknowledgeAll };
}
