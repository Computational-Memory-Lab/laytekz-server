import { useCallback, useSyncExternalStore } from 'react';

function media(query: string): MediaQueryList | null {
  try { return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null; } catch { return null; }
}

/** Whether a media query matches, live. False where there is no window to ask. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const m = media(query);
    m?.addEventListener('change', cb);
    return () => m?.removeEventListener('change', cb);
  }, [query]);
  return useSyncExternalStore(subscribe, () => media(query)?.matches ?? false, () => false);
}

const REDUCE = '(prefers-reduced-motion: reduce)';

/* Galley: the "Reduce motion" setting (V2, WP02) puts data-motion="reduce" on
   <html> (settings/apply.ts); it counts as the system asking. */
function motionAttribute(): boolean {
  try { return typeof document !== 'undefined' && document.documentElement?.dataset?.motion === 'reduce'; } catch { return false; }
}

export function prefersReducedMotion(): boolean {
  return motionAttribute() || (media(REDUCE)?.matches ?? false);
}

/** prefersReducedMotion, live: the system's setting and the app's own. */
export function useReducedMotion(): boolean {
  const subscribe = useCallback((cb: () => void) => {
    const m = media(REDUCE);
    m?.addEventListener('change', cb);
    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      observer = new MutationObserver(cb);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    }
    return () => { m?.removeEventListener('change', cb); observer?.disconnect(); };
  }, []);
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
