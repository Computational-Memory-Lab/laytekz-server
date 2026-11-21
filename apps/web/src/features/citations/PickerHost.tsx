import { lazy, Suspense, useSyncExternalStore } from 'react';
import type { SlotProps } from '../../slots/types';
import { pickerRequest, subscribePicker } from './store';

const CitePicker = lazy(() => import('./CitePicker'));

/** The `editor.overlay` slot item: draws the citation picker while it is open on this page. */
export default function PickerHost({ page }: SlotProps) {
  const req = useSyncExternalStore(subscribePicker, pickerRequest, pickerRequest);
  if (!req || !page || req.page.projectId !== page.projectId || req.page.branch !== page.branch) return null;
  return (
    <Suspense fallback={null}>
      <CitePicker key={req.seq} req={req} />
    </Suspense>
  );
}
