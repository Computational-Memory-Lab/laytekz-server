# WPX1 pdf-comments

## Summary
Feature 19: select text in the compiled PDF and comment on it. A small
Comment button appears beside a PDF selection (also "Comment on this text"
in the PDF's right-click menu, and the comment shortcut ⇧⌘C / Ctrl+Shift+C
while the PDF holds the selection). Choosing it asks SyncTeX (the same
`POST /api/projects/:id/synctex` inverse lookup the double-click jump uses)
for the source file and line of the selection's first and last line, finds
the selected words in that paragraph of the source, selects them in the
editor and runs the page's own `comment` command, so the existing composer,
comments API, Review panel and marked range in the source are used
unchanged; no second comment store exists. If SyncTeX finds no source, the
text comes from outside the project, or the words are not near that line,
a toast says so and nothing is anchored. Choosing a comment in Review also
scrolls the PDF to it (when the preview is beside the editor), through the
page's Jump PDF to cursor after a silent lookup. Two switches under
Settings › PDF: `pdfComments.enabled` and `pdfComments.revealInPdf`, both on
by default.

## Files
- `apps/web/src/features/pdfComments/index.ts` (changed: was WP01's stub)
- `apps/web/src/features/pdfComments/settings.ts` (changed: was WP01's stub)
- `apps/web/src/features/pdfComments/flow.ts` (new)
- `apps/web/src/features/pdfComments/match.ts` (new)
- `apps/web/src/features/pdfComments/place.ts` (new)
- `apps/web/src/features/pdfComments/CommentButton.tsx` (new)
- `apps/web/src/features/pdfComments/pdfComments.css` (new)
- `apps/web/src/features/pdfComments/__tests__/match.test.ts` (new)
- `apps/web/src/features/pdfComments/__tests__/place.test.ts` (new)
- `apps/web/src/features/pdfComments/__tests__/flow.test.ts` (new)
- `e2e/tests/2x1-pdf-comments.spec.ts` (new)
- `docs/galley-v2/WPX1.md` (new)

`apps/server/src/features/pdfComments/server.ts` is unchanged: the feature
needs nothing new on the server (the comments routes and the SyncTeX route
exist).

## Marked hunks
None: every file is new or the feature's own stub; no upstream file changed.

## Requests

### R1: scripts/v2/ownership.json and the scratch scripts: a package entry for WPX1
- **Anchor:** `"packages": {` in `scripts/v2/ownership.json`.
- **Hunk:**
  ```json
  "WPX1": {
    "slug": "pdf-comments",
    "wave": "x",
    "server": [
      "apps/web/src/features/pdfComments/**",
      "apps/server/src/features/pdfComments/**",
      "docs/galley-v2/WPX1.md",
      "e2e/tests/2x1-*.spec.ts"
    ]
  },
  ```
  and drop `pdfComments` from `reserved`. `scratch-sync.sh`, `remote.sh` and
  `check-ownership.mjs` accept only `WP[0-9][0-9]`; they need `WPX[0-9]` too
  (`case "$wp" in WP[0-9][0-9]|WPX[0-9])`).
- **Why:** `check-ownership.mjs WPX1` answers "unknown package WPX1" until then.
- **Without it:** nothing at run time. I synced the build machine with a
  private copy of `scratch-sync.sh` limited to the files listed above.

### R2: apps/web/src/features/types.ts (contract): `EditorPageCtx.runCommand(id): boolean`
- **Anchor:** `  openSettings(t?: SettingsTarget): void;` inside `EditorPageCtx`; then
  `runCommand: (id) => source().runCommand(id),` in `pageCtx.ts` and
  `runCommand: (cid) => runCommand(cid),` in Editor.tsx's `pageSource.current`.
- **Why:** the feature runs the page's `comment` and `jump-pdf` commands. Only
  `EditorFeatureCtx` has `runCommand`, so `flow.ts` keeps the one the editor
  contribution's context hands over (`trackEditor`).
- **Without it:** works, because the comment flow opens the source file first,
  which builds the editor contribution; "show in the PDF" needs a file open,
  which choosing a comment in Review always does.

### R3 (optional): apps/web/src/pages/Editor.tsx: a review event instead of a DOM listener
- **Anchor:** `const revealComment = useCallback((c: Comment) => {`
- **Hunk:** `page.events.emit('commentRevealed', { id: c.id });` (and
  `commentRevealed: { id: string }` in `PageEvents`, a contract change).
- **Why:** "show in the PDF" listens for clicks on `[data-comment-card] .review__anchor`.
- **Without it:** works as long as ReviewPanel keeps that class and attribute.

## Deviations
- **The package is not in the plan**; this file and the task brief are its
  brief. Its directory was `reserved` in ownership.json (R1).
- **No composer of its own.** The feature selects the found words in the
  editor (a selection-only transaction, `userEvent 'select.pdfComment'`) and
  runs the page's `comment` command, which reads that selection. The
  composer therefore quotes the source text (`\emph{…}` included), as for a
  comment made in the editor.
- **The comment shortcut over the PDF** is taken by a `keydown` capture
  listener on `window` added in `boot()`. Boot runs when the manifest is
  installed, before Editor.tsx adds its own capture listener for the
  shortcut in an effect, so it runs first; it calls `preventDefault()` only
  when the document's selection is inside `[data-testid="pdf-pane"]`, the
  setting is on and no modal dialog is open, and Editor.tsx's listener skips
  default-prevented keys. Anywhere else the key behaves as in V1. The
  shortcut is still the `comment` binding (rebindable under Shortcuts).
- **Matching** (`match.ts`): both sides are reduced to letters and digits
  (NFKD, lower case: ligatures, accents and hyphenation stop mattering); the
  source side leaves out `%` comments, command names and the arguments of
  `\label`, `\ref`, `\cite`, `\begin`, … The occurrence nearest the SyncTeX
  line, in the paragraph (or the 30 lines around it), wins. When the whole
  selection is not found (a citation printed as `[1]`, a reference number),
  its two ends are matched (24, 16, 10 or 6 letters each) and the comment
  spans from one to the other; below 12 letters only an exact match counts.
  Otherwise nothing is anchored and the editor caret is put on the SyncTeX
  line with a toast that says the words were not found there.
- **Show in the PDF** applies to every comment chosen in Review (the comments
  store records no origin), only with the side-by-side layout and not on a
  phone (Jump PDF to cursor would switch a one-pane layout to the PDF), and
  only when a silent forward lookup finds the line in the PDF, so a comment
  in a `.bib` or unused file never raises the jump's error toast.
- **The PDF right-click menu**: with the switch on, a plain right-click inside
  a PDF selection now opens the app menu (README D2: "Comment on this text",
  then Copy) instead of the browser's; Shift+right-click still gives the
  browser's menu. With the switch off the native menu shows as in V1.

## Privacy notes
Nothing new leaves the browser beyond what the double-click jump and comments
already send: the selection's page and box (to the project's own SyncTeX
route) and the comment the person writes. The two switches are account
scope, so with preference sync they are stored with the account.

## Operator variables
None.

## Tests
Build machine, HEAD ca15343 plus this package's files only (a private copy of
`scratch-sync.sh`, R1):
- `npm run typecheck -w apps/web`: clean.
- `vitest run src/features/pdfComments`: 3 files, 24 tests pass (`match` 10:
  keys, commands and comments left out, paragraphs, words across commands and
  line breaks, nearest occurrence, ligatures/hyphenation/accents, a citation
  printed as a number, a SyncTeX line a few lines off, null rather than a
  wrong anchor, a line past the end; `place` 7: the double-click jump's file
  matching, files outside the project; `flow` 7: the composer opens on the
  found words with the document unchanged, every refusal says so and anchors
  nothing, a 409 passes the server's sentence on, show-in-PDF jumps only after
  Review selected the comment and a silent lookup found it).
- `npm run test -w apps/web`: 138 files, 1519 of 1520 pass; the one failure is
  V1's timing-sensitive `visual/__tests__/incremental.test.ts`, which passes
  on its own (WP05's notes report the same).
- `node scripts/v2/check-contracts.mjs`: OK.
- e2e (`scripts/v2/e2e-slot.sh -c e2e tests/2x1-pdf-comments.spec.ts tests/10-review.spec.ts --retries=0`,
  same tree, no `--with`): 12 passed. Spec 2x1: a drag across words in the
  PDF shows the Comment button; choosing it opens the composer quoting the
  source words, and the saved comment shows in Review, as a marked range in
  the source and through the comments API with the right offsets, with the
  file unchanged; Ctrl+Shift+C over a PDF selection quotes the PDF words, not
  an older selection in the editor; the switch off hides the button. V1's
  review spec 10 (9 tests, Review clicks included) still passes.
- Not run: the Electron app (no desktop change), the auth suite.
- `check-ownership.mjs WPX1`: cannot run until R1 (unknown package).

## For later packages
- The PDF selection reaches the feature as `page.events.on('pdfSelection')`;
  `flow.ts` keeps the last one (`liveSelection()`, `subscribeSelection()`).
- `commentOnSelection(page, selection)` (flow.ts) is the whole action and
  returns why it stopped (`'composer'`, `'not-found'`, `'no-source'`, …).
- `locateSelection(doc, line, text, {endLine})` (match.ts) is pure and can
  serve any PDF-to-source refinement (WP21's crops, a future "find in source").
