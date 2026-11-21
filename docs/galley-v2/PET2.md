# PET2 roaming desk pet

## Summary
The desk pet (feature 14) now roams the whole editor window instead of
sitting on one header bar. It hops between surfaces on ballistic arcs with
squash and stretch, scoots along them, and rides whatever it stands on: a
PDF page, a line of source, a header bar, the typeset bar under the editor.
It looks at the mouse, startles at a flick, dodges a cursor heading for
what is under it, creeps toward a resting cursor, wiggles when hovered and
steps aside when hovered for long. It reacts to typesets (looks at the PDF,
a happy spinning hop, a sad shake), settles while you type and keeps off
the line being edited, naps when you are away and peeks up from below the
window edge. Clicking it squeaks like a rubber duck (synthesized with Web
Audio, or a recorded file when the server has one) with a squash and a
little hop; dragging picks it up, and it falls onto whatever is below where
it is dropped. Still off by default; only you see and hear it.

## Files
- `apps/web/src/features/pet/controller.ts` (rewritten)
- `apps/web/src/features/pet/DeskPet.tsx` (rewritten)
- `apps/web/src/features/pet/pet.css` (rewritten)
- `apps/web/src/features/pet/sound.ts` (new)
- `apps/web/src/features/pet/runtime.ts` (changed: perch helpers removed)
- `apps/web/src/features/pet/settings.ts` (changed: reduced-motion hint)
- `apps/web/src/features/pet/index.ts` (changed: comment)
- `apps/web/src/features/pet/__tests__/runtime.test.ts` (changed)
- `apps/web/src/features/pet/engine/surfaces.ts` (new)
- `apps/web/src/features/pet/engine/moves.ts` (new)
- `apps/web/src/features/pet/engine/mood.ts` (new)
- `apps/web/src/features/pet/engine/squeak.ts` (new)
- `apps/web/src/features/pet/engine/asset.ts` (changed: `q`, `petSqueakUrl`, `PetShape`)
- `apps/web/src/features/pet/engine/prefs.ts` (changed: settings)
- `apps/web/src/features/pet/engine/brain.ts` (deleted)
- `apps/web/src/features/pet/engine/motions.ts` (deleted)
- `apps/web/src/features/pet/engine/perches.ts` (deleted)
- `apps/web/src/features/pet/engine/__tests__/engine.test.ts` (changed)
- `apps/web/src/features/pet/engine/__tests__/roam.test.ts` (new)
- `apps/web/src/features/pet/engine/__tests__/squeak.test.ts` (new)
- `apps/web/src/features/pet/engine/__tests__/brain.test.ts` (deleted)
- `apps/web/src/features/pet/engine/__tests__/perches.test.ts` (deleted)
- `apps/server/src/features/pet/asset.ts` (changed: the squeak)
- `apps/server/src/features/pet/server.ts` (changed: route variant, capability `q`, bundled squeak)
- `apps/server/test/pet-asset.test.mjs` (changed: `q` in the capability)
- `apps/server/test/pet-squeak.test.mjs` (new)
- `apps/server/assets/pet/README.md` (changed: how to add a recorded squeak)
- `e2e/tests/244-pet-runtime.spec.ts` (rewritten)
- `docs/galley-v2/PET2.md` (new)

The files fall under WP44's and WP39's globs; the scratch runs used
`scripts/v2/scratch-sync.sh WP44 --with WP39` (the scripts accept only
WPnn ids). This file and the asset README are outside every package's globs.

## Marked hunks
None: every changed file is Galley's own (the pet feature, its tests and
its notes). No upstream file and no frozen file is touched.

## How it works
- **Overlay.** `.desk-pet` is `position: fixed; inset: 0; pointer-events:
  none; z-index: 21`: just above the toolbar (20), so hops from the bars
  under it stay in view, and below everything that floats (menus, popovers,
  dialogs, toasts, settings). While a toolbar popup is open
  (`.toolbar:has([aria-expanded="true"])`, e.g. the branch menu) it drops to
  19, under the toolbar. Only `.desk-pet__body` takes the pointer. Layers, outside in: feet position
  (translate), hit box, lean, squash (per frame), effects (Web Animations),
  image (flip). It is inside the editor shell, so the settings page makes
  it inert.
- **Surfaces** (`engine/surfaces.ts`, measured in one batch by
  `controller.collect()`): `ledge` = the `[data-perch]` header spacers (feet
  on the bar's bottom line) and the top edge of the typeset bar under the
  editor (`typeset-bar` / `errors-panel`); `page` = the top edge of each
  `canvas.pdf-page` inside `[data-testid="pdf-pane"]`; `code` = the white
  space right of the text in CodeMirror's visible lines (never over code);
  `floor` = the window's bottom edge. A missing element is simply not a
  surface. `pickSpot` is a weighted draw (each kind gets its share however
  many surfaces it has), `surfaceBelow` is where a dropped or stranded pet
  lands.
- **Riding.** The anchor stores the element and the feet's x offset from
  it. A capturing `scroll` listener on the document re-reads the anchor's
  element rect whenever the scrolled box contains it, and a ResizeObserver
  watches the element and its bar or scroll box (a dragged split pane, PDF
  zoom). One rect read and one transform write per event. A spot scrolled
  out of its box: the pet clings to the edge (`clampToClip`) for 0.7 s,
  then hops to a visible spot. The element gone (a new PDF, a hidden pane,
  another file): it falls onto what is below. A hop's landing point is read
  live every frame, so it lands on a page that scrolls while it is in the
  air.
- **Motion** (`engine/moves.ts`): hop = crouch, ballistic arc (gravity 3.2 g
  cartoon scale), stretch along the flight, springy landing squash; walk =
  eased scoot with a waddle; fall = gravity then the landing squash; peek =
  slide below the window edge, look out, come back. Animation frames run only
  during a motion; still, it keeps one timer (`Deadlines`).
- **Behaviour** (`engine/mood.ts`): idle thoughts every 9–20 s (Calm) or
  3–8 s (Playful): hop, walk, look around, fidget, peek. Mouse: look and lean
  toward it, `startle` (≥ 1.5 px/ms within 110 px: "!" and a hop away),
  `dodge` (≥ 0.8 px/ms heading into it: a low sideways hop), creep toward a
  cursor resting within 280 px, wiggle on hover, step aside after 1.4 s of
  hovering. Typing: nothing voluntary within 3.5 s of a key; when the caret's
  line comes within reach it hops to a bar or a page, clear of that line.
  A held mouse button elsewhere (a selection, a drag) blocks every voluntary
  motion. Typesets: look at the PDF while it runs; success after your own
  run or after a failure: heart and a spinning hop; failure: "…" and a shake.
  Joins and comments by others: "!" and a wobble. Idle 150 s (Calm) or
  240 s (Playful): it naps (slumps, dims, "z"s) and wakes on the mouse or a
  key.
- **Squeak** (`engine/squeak.ts`, `sound.ts`): per chirp, a sawtooth plus an
  octave square gliding about 950 → 1600 → 1250 Hz ("squee", 170 ms) and,
  85 % of the time, a shorter 1300 → 1700 → 1050 Hz "eek"; 38–60 Hz amplitude
  flutter and 18–28 Hz vibrato make it rubbery; a 4× oversampled tanh clipper
  adds rasp; a 2.4–3 kHz peaking filter is the reed's nasal colour; band-passed
  noise is the breath. Pitch ±15 % and length ±20 % are drawn fresh on every
  click. Checked by rendering with OfflineAudioContext in headless Chromium
  and reading the spectrogram (harmonic stack, rising then sagging glide,
  centroid about 3.9 kHz after softening it from 4.2 kHz). The AudioContext
  is made on the first click and suspended 4 s after the last squeak.
- **Recorded squeak.** With `apps/server/assets/pet/squeak.mp3` (or `.ogg`,
  `.wav`), the server announces `q` in the `pet` capability and serves it at
  `/api/instance/pet/squeak` (same rules and headers as the image); the app
  fetches it when the pet appears and plays it with a 0.9–1.12 speed
  variation. No file: `q` is null and the synthesized squeak plays.

## Settings
Kept: "Desk pet" (off by default), "Activity" (Calm, Playful), "Size"
(Normal 40 px, Small 30 px), "React to typesetting", "Notice when someone
joins", "Notice new comments", "Nap when I am away" (was "Doze"). New:
"Squeak when clicked" (on by default). Removed: "Spot" (it roams), "Hide on
errors" (now the sad shake under typesetting), "Wander between spots" (it
always roams; Activity sets how much). Stored values of removed settings are
ignored. The palette commands and the right-click menu stay (the menu's
"Pet" is now "Squeak"; "Move to" is gone; double-click no longer sends it
away, so fast clicks keep squeaking).

## Deviations
1. The first pet's fade-in from the silhouette is gone: the pet drops in from
   behind the toolbar (reduced motion: a fade). The server still serves the
   silhouette; the app no longer asks for it.
2. Low battery no longer stills the pet (the roaming pet runs no frames when
   still, and its motions are short).
3. The toolbar is not a surface (it is the top of the window); the pet only
   flies across it.
4. Phones, tablets and windows under 720 px still get no pet.

## Privacy notes
Nothing new leaves the browser: the image and the optional recorded squeak
are same-origin, signed-in requests with `private` caching. Nothing about the
pet reaches Yjs, awareness, the project, the PDF or other people; only local
events move it.

## Operator variables
| Name | Default | Effect |
|---|---|---|
| `ALDINE_INSTANCE_PET_SQUEAK` | unset | A recorded squeak (MP3, Ogg or WAV, at most 512 KB). Unset: `squeak.mp3/.ogg/.wav` next to the bundled pet when present, else the synthesized squeak. `none`: always synthesized. |

## Tests
All runs: `scripts/v2/scratch-sync.sh WP44 --with WP39` (commit cbbdbc0 plus
these files), then `scripts/v2/remote.sh WP44 '…'`.
- `npm run typecheck -w apps/web` and `npm run typecheck -w apps/server`: pass.
- `npm run test -w apps/web`: 180 files, 1971 tests pass. The pet's own
  (`npx vitest run --root apps/web src/features/pet`): 4 files, 44 tests
  (surfaces, picking and dropping, code perches, riding offsets and
  clinging, hop arcs, the ceiling that keeps a hop inside the window,
  live-target landing, squash, walk, fall, peek, mouse reactions, caret
  avoidance, thoughts, arrivals, squeak parameter variation, the scheduled
  Web Audio graph against a fake context, prefs, asset URLs).
- apps/server `npx tsx test/pet-squeak.test.mjs`, `pet-asset.test.mjs`,
  `galley-pet-default.test.mjs`: pass (the squeak route 401 signed out, 200
  signed in with the image route's headers and ETag/304, the capability's
  `q`, 404 and `q: null` without a file, the bundled-file lookup, `none`,
  refusals of oversize and non-audio files).
- `node scripts/v2/check-contracts.mjs`: OK.
- e2e `scripts/v2/e2e-slot.sh -c e2e tests/244-pet-runtime.spec.ts tests/239-pet-engine.spec.ts --retries=0`:
  4 passed. 244: (1) off by default; the palette turns it on, it drops onto
  the editor bar (40 px, feet on the bar's line, clear of the file name, the
  overlay itself click-through); the menu's "Squeak" and "Hide for an hour"
  with its toast; "Bring the desk pet back"; the settings section has
  "Squeak when clicked" and no "Spot". (2) Demo paper: perched in the
  source it covers no text; perched on page 2's top edge, scrolling the
  preview by 150 px moves it by exactly −150 px and keeps its feet on the
  page; a click plays the synthesized squeak (an AudioContext spy sees the
  oscillators, `data-squeak="synth"`), a second click squeaks again; a
  slowed hop from the editor bar to page 2 is caught mid-air above its
  start, over the toolbar (overlay z-index 21), and lands on page 2;
  dragged over the editor and dropped, it falls onto a surface below.
  (3) Reduced motion: it sits on the editor bar, a flick past it and 3.5 s
  change nothing, a click squeaks and runs the one squash animation, and it
  stays put.
- Screenshots looked at (bundled image swapped in): on page 2, squashed on
  a click, perched at the end of a source line, mid-hop. They caught two
  bugs, both fixed: hops from the top bars went behind the toolbar (overlay
  raised above it), then out of the window (the hop's apex is now capped).
- The synthesized squeak was rendered with OfflineAudioContext in headless
  Chromium and its spectrogram read (see "How it works").
- The suite's `expectTypesetOk` helper still waits for "Typeset in" in
  `pdf-status`, which commit 282fd82 moved under the editor; this spec waits
  for the PDF pages instead. Other specs using the helper are not this
  package's.
- Test hook: `localStorage['aldine.e2e.pet'] = '1'` exposes
  `window.__laytekzDeskPet` (`perch(kindOrId, i)`, `hop(kindOrId?, i)`,
  `freeze(on)`, `slow(k)`, `think()`, `state()`).

## Not done
- No recorded squeak ships: the owner can drop `squeak.mp3` (or `.ogg`,
  `.wav`) into `apps/server/assets/pet/` and restart; the file path is
  covered by the server tests, not by an e2e run with a real file.
- The sidebar's file list is not a surface (only its tab row's spacer).
- The synthesized squeak was judged from its spectrogram, not by ear.
