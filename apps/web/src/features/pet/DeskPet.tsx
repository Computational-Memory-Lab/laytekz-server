/**
 * F14 desk pet (WP44 pet-runtime; roaming pet: PET2): the element and its
 * inputs. Everything it does is the controller's (controller.ts), which
 * reads the settings, the away time and reduced motion from here on every
 * render.
 *
 * A window-sized overlay with no pointer events holds the pet; only its body
 * takes the pointer. The layers, outside in: the feet's position, the hit
 * box, the lean toward the cursor, squash and stretch while moving, one-shot
 * effects, and the image (a background, so it cannot be dragged out of the
 * page), flipped to face where it goes. It takes no focus and is hidden from
 * assistive technology: every action has a palette command.
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SlotProps } from '../../slots/types';
import { useCapabilities } from '../../settings/capabilities';
import { getSetting, subscribeSetting } from '../../settings/store';
import { useReducedMotion } from '../../util/useMediaQuery';
import { awayUntil, subscribeAway } from './away';
import { PetController, type ControllerInput, type PetEls } from './controller';
import { measurePet, petAssetFrom, petImageUrl, petSqueakUrl, type PetShape } from './engine/asset';
import { PET_SETTING_IDS, petPrefsFrom } from './engine/prefs';
import './pet.css';

export default function DeskPet({ page }: SlotProps) {
  const asset = petAssetFrom(useCapabilities());
  const v = asset?.v ?? null;
  const q = asset?.q ?? null;
  const url = useMemo(() => (asset ? petImageUrl(asset) : null), [v]); // eslint-disable-line react-hooks/exhaustive-deps
  const squeakUrl = useMemo(() => (asset ? petSqueakUrl(asset) : null), [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const reduced = useReducedMotion();

  const [prefsRev, bumpPrefs] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeSetting([...PET_SETTING_IDS], bumpPrefs), []);
  const prefs = useMemo(() => petPrefsFrom((id) => getSetting<unknown>(id)), [prefsRev]);

  const [, bumpAway] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeAway(bumpAway), []);
  const away = awayUntil();

  // The figure's proportions, measured once per image version.
  const [measured, setMeasured] = useState<{ v: string; shape: PetShape } | null>(null);
  useEffect(() => {
    if (!asset || !url) return;
    let live = true;
    void measurePet(asset, url).then((shape) => { if (live) setMeasured({ v: asset.v, shape }); });
    return () => { live = false; };
  }, [v, url]); // eslint-disable-line react-hooks/exhaustive-deps
  const shape = measured && measured.v === v ? measured.shape : null;

  const input: ControllerInput = { page, active: !!url && !!shape && prefs.on && away === null, prefs, reduced, shape, squeakUrl, awayUntil: away };
  const inputRef = useRef(input);
  inputRef.current = input;

  const refs = {
    root: useRef<HTMLDivElement>(null), pos: useRef<HTMLDivElement>(null), shadow: useRef<HTMLDivElement>(null),
    body: useRef<HTMLDivElement>(null), lean: useRef<HTMLDivElement>(null), squash: useRef<HTMLDivElement>(null),
    fx: useRef<HTMLDivElement>(null), img: useRef<HTMLDivElement>(null), bubble: useRef<HTMLDivElement>(null),
  };
  const ctl = useRef<PetController | null>(null);
  useLayoutEffect(() => {
    const els = Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, r.current])) as Record<keyof PetEls, HTMLDivElement | null>;
    if (Object.values(els).some((e) => !e)) return;
    els.root!.style.display = 'none';
    els.root!.dataset.state = 'off';
    const c = new PetController(inputRef.current, { awayEnded: bumpAway });
    ctl.current = c;
    c.attach(els as PetEls);
    return () => { c.dispose(); ctl.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Every render: the page re-renders this item whenever the editor does.
  useLayoutEffect(() => { ctl.current?.update(input); });

  return (
    <div ref={refs.root} className="desk-pet" data-testid="desk-pet" aria-hidden="true">
      <div ref={refs.pos} className="desk-pet__pos">
        <div ref={refs.shadow} className="desk-pet__shadow" />
        <div ref={refs.body} className="desk-pet__body" data-testid="desk-pet-body">
          <div ref={refs.lean} className="desk-pet__lean">
            <div ref={refs.squash} className="desk-pet__squash">
              <div ref={refs.fx} className="desk-pet__fx">
                <div ref={refs.img} className="desk-pet__img" style={url ? { backgroundImage: `url("${url}")` } : undefined} />
              </div>
            </div>
          </div>
        </div>
        <div ref={refs.bubble} className="desk-pet__bubble" data-testid="desk-pet-bubble" />
      </div>
    </div>
  );
}
