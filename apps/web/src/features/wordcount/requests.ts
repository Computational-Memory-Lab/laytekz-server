import { useEffect, useRef } from 'react';
import type { EditorPageCtx } from '../types';

/** The status buttons on screen, each able to open its breakdown (the palette's "Show word count breakdown"). */
const openers = new Set<() => void>();

/** Opens the breakdown of the status on screen; false when none is shown. */
export function requestBreakdown(): boolean {
  for (const open of openers) { open(); return true; }
  return false;
}

export function useBreakdownRequests(page: EditorPageCtx | null, open: () => void): void {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    if (!page) return;
    const fn = () => ref.current();
    openers.add(fn);
    return () => { openers.delete(fn); };
  }, [page]);
}
