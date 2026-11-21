import { lazy, Suspense, useSyncExternalStore } from 'react';
import type { SlotProps } from '../../slots/types';
import { refPickerRequest, subscribeRefPicker } from './store';

const RefPicker = lazy(() => import('./RefPicker'));

/** The `editor.overlay` slot item: draws the cross-reference picker while it is open on this page. */
export default function RefPickerHost({ page }: SlotProps) {
  const req = useSyncExternalStore(subscribeRefPicker, refPickerRequest, refPickerRequest);
  if (!req || !page || req.page.projectId !== page.projectId || req.page.branch !== page.branch) return null;
  return (
    <Suspense fallback={null}>
      <RefPicker key={req.seq} req={req} />
    </Suspense>
  );
}
