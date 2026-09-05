import { useEffect } from 'react';

export function useHeartbeat(): void {
  useEffect(() => {
    if (document.visibilityState !== 'visible') return;

    const sendBeat = () => fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
    const id = setInterval(sendBeat, 30_000);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clearInterval(id);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
