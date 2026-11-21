/**
 * F14 desk pet (WP44 pet-runtime): the `editor.overlay` item. Draws nothing
 * and loads nothing until the server offers a pet image and the person has
 * turned the pet on; then it loads DeskPet once and keeps it, so turning the
 * pet off plays its exit.
 */
import { lazy, Suspense, useState } from 'react';
import type { SlotProps } from '../../slots/types';
import { useCapabilities } from '../../settings/capabilities';
import { useSetting } from '../../settings/store';
import { PET_IDS, petAvailable } from './engine/prefs';

const DeskPet = lazy(() => import('./DeskPet'));

export default function PetSlot(props: SlotProps) {
  const capabilities = useCapabilities();
  const [on] = useSetting<boolean>(PET_IDS.on);
  const wanted = on === true && petAvailable({ capabilities });
  const [loaded, setLoaded] = useState(wanted);
  if (wanted && !loaded) setLoaded(true);
  if (!loaded) return null;
  return (
    <Suspense fallback={null}>
      <DeskPet {...props} />
    </Suspense>
  );
}
