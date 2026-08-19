import { useEffect, useRef } from 'react';

// Keeps the screen awake while `active` is true. Requires a secure context (HTTPS)
// and a visible tab — the Wake Lock API silently releases on backgrounding, so we
// re-acquire on visibilitychange. No-ops on unsupported browsers or plain HTTP.
export function useWakeLock(active) {
  const lockRef = useRef(null);

  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let cancelled = false;

    async function acquire() {
      try {
        lockRef.current = await navigator.wakeLock.request('screen');
      } catch {
        // Denied, unsupported, or document not visible — ignore.
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && !cancelled) acquire();
    }

    acquire();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [active]);
}
