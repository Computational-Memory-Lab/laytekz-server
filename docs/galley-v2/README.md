# Laytekz V2: package notes, requests and contract decisions

This directory holds one notes file per work package (`WP01.md` … `WP45.md`)
and this README. The plan is `v2-planning/v2-plan.md` beside the two
repositories (section 2 holds the contracts, 2.10 the working rules, 3.2 the
ownership matrix, 3.3 each package's brief). Section 4 below records what WP01
decided where the plan was ambiguous or did not fit the code; it overrides the
plan where they differ. The integrator folds these notes into `GALLEY.md` and
`privacy.ts` after each wave; nobody else edits those two files or
`CHANGELOG.md`.

Path shorthand, as in the plan: `web/` = `apps/web/src/`, `srv/` =
`apps/server/src/`, `desk/` = `desktop-v2/`, `e2e/` = `e2e/`.

## 1. Your notes file: `docs/galley-v2/<WP>.md`

Write it as you go, not at the end. Use these headings, in this order (leave a
section out only when it would be empty):

```markdown
# WP05 editor-host

## Summary
Two or three sentences: what now exists and what it does for a user (nothing, in wave 0).

## Files
- `apps/web/src/components/CodePane.tsx` (changed)
- `apps/web/src/editor/core/featureHost.ts` (new)
- `desktop-v2/src/main/menu.js` (changed)

## Marked hunks
Every hunk inside a file that came from upstream, by file: the `Galley:` comment's
text or a unique line near it, and one sentence on what the hunk does.

## Requests
(section 2 below)

## Deviations
Every place you departed from the plan or from the frozen contracts, exactly
(old signature, new signature, why).

## Privacy notes
Hosts the code contacts, data it stores and where, what leaves the browser.

## Operator variables
New environment variables: name, default, effect.

## Tests
The commands you ran and their results; your e2e spec names; what you could not run.

## For later packages
What a package that builds on yours must know.
```

**The `## Files` list is your ownership claim.** One bullet per file you
created, changed or deleted; the path in backticks comes first; server-v2
paths are repository-relative, desktop-v2 paths start with `desktop-v2/`.
`scripts/v2/check-ownership.mjs <WP>` reads it.

## 2. Requests: changes you need in a file you do not own

You never edit a file outside your package's globs (`scripts/v2/ownership.json`),
however small the change. Missing hooks become requests in your notes; the
integrator applies them between waves (Editor.tsx, CodePane.tsx and the small
`routes.ts` lines are integrator-only from wave 1 on). Format:

````markdown
### R1: apps/web/src/pages/Editor.tsx: render the probe's banner slot
- **Anchor:** a unique line the hunk goes after, quoted exactly:
  `<div className="editor-pane__header" data-testid="editor-pane-header">`
- **Hunk** (at most 30 lines, with its `Galley:` comment):
  ```diff
  +      {/* Galley: V2 editor banners */}
  +      <Slot name="editor.banners" page={pageCtx} />
  ```
- **Why:** what cannot work without it.
- **Without it:** how your package behaves until it lands (it must degrade, never break).
````

Number requests R1, R2 … per package. A request that changes a frozen
contract (section 3) says which type and gives the new signature; only the
integrator changes contracts.

## 3. Ownership, frozen files, and the checks

- `scripts/v2/ownership.json` lists every package's globs (server-v2 paths
  under `server`, desktop-v2 paths under `desktop`), its wave, and:
  - `frozen`: the contract files (`web/features/{types,manifest}.ts`, every
    `types.ts` WP01 wrote, `web/settings/registry/index.ts`,
    `srv/features/{types,index}.ts`, `desk/src/main/features/index.js`), the
    mock router, `e2e/playwright.config.ts`, `scripts/v2/**`, this README,
    `GALLEY.md`, `CHANGELOG.md`, `srv/privacy.ts`: integrator only.
  - `integratorAfterWave0`: files a wave-0 package owns that freeze after wave 0
    (Editor.tsx, CodePane.tsx, PdfPane.tsx, main.tsx, the CSS entry files, …).
  - `neverEdited`: plan §2.7's list (the datastores, `config.ts`,
    `origin-check.ts`, `desktop-handoff.ts`, the compiler's `format.js` and
    `guard.js`, `CHANGELOG.md`).
  - `reserved`: the directories of the two late features (section 4, D1).
  - `external`: paths outside both repositories (WP39's and WP45's deploy
    scripts); not checked. `latex_docs/deploy` is V1 and is never modified;
    the integrator decides where V2 deploy changes live before wave 4.
- Every package also owns its notes file and its e2e specs,
  `e2e/tests/2NN-<slug>.spec.ts` with NN its number (WP05 → `205-…`).
  Server unit tests are `apps/server/test/<slug>-*.test.mjs`; web unit tests
  sit next to the code they test in a `__tests__` directory your globs cover.
- `node scripts/v2/check-ownership.mjs <WP>` must pass before you report done.
  It fails when your `## Files` list names a file you do not own, a frozen
  file or a never-edited one. It warns about owned changes missing from the
  list and about stray changes (no package of your wave owns them). Eight
  agents share one working copy, so a stray change may be someone else's: say
  so in your report and never revert another agent's work. The integrator runs
  it with `--strict` (strays fail) before committing.
- `node scripts/v2/check-ownership.mjs --lint` checks the manifest (45
  packages, no file claimed twice within a wave). `node scripts/v2/check-contracts.mjs`
  checks what no type checker sees across the apps (feature id lists, both
  manifests, the registry imports, the stubs, the shell list, the vocabulary
  twin). `node scripts/v2/selftest.mjs` runs the glob tests and both checks.

## 4. Tooling: where and how to build and test

The Mac is short on memory: installs, type checks, unit tests and builds run
on the Linux build machine (`ssh $V2_REMOTE`). Never touch `~/galley-server` there
or anything on ports 3040 and 3041: that is the live site.

| Script (scripts/v2/) | Where | What |
|---|---|---|
| `scratch-sync.sh <WP> [--with <WP>]…` | Mac | Builds `~/v2-scratch/<WP>/server` on the build machine: `git archive HEAD` (cached per commit) plus your own changed files (`check-ownership.mjs <WP> --list`), `node_modules` linked from the wave's install `~/laytekz-v2/server`. Re-run after every change you want to test. |
| `remote.sh <WP> '<command>'` | Mac | Runs a command there, in your scratch tree, under `nice -n 10`, with Node and TeX Live on PATH. |
| `e2e-slot.sh [playwright args]` | build machine (through remote.sh) | Playwright inside one of two slots (`flock ~/v2-scratch/e2e.{1,2}.lock`): slot k gets the app on `31k0`, mocks on `31k1`–`31k8`, base-path/provisioning on `32k0`–`32k6`, a loopback compiler with a one-off token on `40k0`. Default `-c e2e`. Example: `scripts/v2/remote.sh WP06 'scripts/v2/e2e-slot.sh -c e2e tests/206-page-host.spec.ts'`. |
| `desktop-test.sh [playwright args]` | Mac | desktop-v2's Electron tests under `/tmp/laytekz-electron.lock` (one Electron across all agents), one worker, `ELECTRON_RUN_AS_NODE` removed. |
| `with-lock.sh <lockfile> <cmd…>` | both | flock(1) where installed, Perl's flock(2) on macOS (no flock binary there). |
| `refresh-base.sh [--install]` | Mac (integrator) | Makes `~/laytekz-v2/server` the committed tree, keeping `node_modules`; `--install` runs `npm ci` (after a lockfile change). |
| `check-ownership.mjs`, `check-contracts.mjs`, `selftest.mjs` | either | Section 3. |

Typical loop for a server-v2 package:

```bash
cd server-v2   # the shared working copy
scripts/v2/scratch-sync.sh WP05
scripts/v2/remote.sh WP05 'npm run typecheck -w apps/web && npm run test -w apps/web'
scripts/v2/remote.sh WP05 'npm run typecheck -w apps/server && npm run test:unit -w apps/server'
node scripts/v2/check-ownership.mjs WP05
```

Your scratch tree contains HEAD plus only your files: the other wave-0
packages' functions are the throwing stubs WP01 committed (section 6). Unit
tests mock what a neighbour has not delivered (`vi.mock('../settings/store')`).
For an end-to-end smoke run that needs a neighbour, `scratch-sync.sh WP06 --with WP02`
overlays that package's current files; say in your notes which runs used
`--with`, because acceptance is judged again at integration.

Three server unit test files, `compiler-sandbox`, `manual-commits` and
`preamble-cache`, fail on the build machine with the untouched V1 code too
(no `unzip` there, and its latexmk and PDF text tools differ): that is the
baseline, not your change. The compiler there has no latexindent (Perl's
YAML::Tiny is missing), so a spec that formats a document cannot pass there.

The e2e suites run Playwright's Chromium from `~/.cache/ms-playwright` on the
build machine; the libraries it lacks there (no sudo) are unpacked under
`~/.local/opt/chromium-libs`, which `e2e-slot.sh` puts on `LD_LIBRARY_PATH`. Specs follow `e2e/tests/2NN-<slug>.spec.ts`; device keys keep
the `aldine.` prefix; new dependencies are allowed only for WP17 and WP43.

## 5. Contract decisions (WP01)

These complete or correct the plan's section 2. The frozen files carry them;
this is the record.

**D1. Two late features have ids now.** `FEATURE_IDS` adds `pdfComments`
(feature 19: comment on text selected in the PDF) and `refManagers` (feature
20: reference-manager panels on the sidebar's main row), with stubs on the web
and server side and `reserved` entries in ownership.json. Their packages get
numbers later; nobody edits their directories until then.

**D2. Room for those features in wave 0.**
- `FeatureModule.pdfContextMenu?: PdfContextMenuEntry[]` and
  `PageEvents.pdfSelection`; the types `PdfTextSelection`, `PdfRect`,
  `PdfMenuTarget`, `PdfContextMenuEntry` (`web/contextmenu/types.ts`).
- `FeatureModule.pinnedPanels?: PinnedPanel[]` puts a plugin's panel
  (`plugin:<id>`) on the sidebar's main row, after the core pinned panels
  (references 100, zotero 200, today's `PINNED_PANELS`).
- `SlotItem.panel.pinned` does the same for a feature's own `sidebar.panels` item.
- A thirteenth slot, `pdf.overlay`, over the PDF pages.
- **PDF app menu policy** (WP05 implements it in PdfPane): a plain right-click
  inside a PDF text selection opens the app menu only when some enabled
  feature's `pdfContextMenu` entry returns items; otherwise (and always with
  Shift, on touch, or with no entries) the native menu shows, exactly as today.
  The menu ends with Copy. Test id `pdf-context-menu`.

**D3. Who renders the slots.** The PDF pane's header (word count, download
button) is in `Editor.tsx`, not `PdfPane.tsx`, so **WP06 renders all thirteen
slots**, `pdf.status`, `pdf.actions` and `pdf.overlay` included. WP05's
PdfPane work is the `pdf()` accessor, the PDF app menu and selection reports
(D4).

**D4. The seams between Editor.tsx (WP06) and CodePane/PdfPane (WP05)**, frozen
in `web/features/types.ts`:
- CodePane gets an optional prop `featureHost?: CodePaneFeatureHost`
  (`modules`, `page()`, `userId`, `notify`, `openSettings`, `runCommand`);
  without it no feature runs. `CodePaneHandle` gains `view(): EditorView | null`
  (`CodePaneFeatureHandle`). The editor's identity name and colour still come
  from the existing `identity` prop; `EditorFeatureCtx.identity.id` is `userId`.
- PdfPane gets `featureHost?: PdfPaneFeatureHost` (`modules`, `page()`,
  `onTextSelection`); `PdfPaneHandle` gains `pdf(): PdfDocumentInfo | null`
  and `textSelection()` (`PdfPaneFeatureHandle`). WP06 builds
  `EditorPageCtx.pdf()` on `pdfRef.current?.pdf()` and emits `pdfSelection`
  from `onTextSelection`.
- WP06 passes `modules` = the manifest's `FEATURES`, without `_probe` unless
  `localStorage['aldine.e2e.probe'] === '1'`.
- Read-only rules need no new CodePane prop: WP06 computes the first reason,
  passes `readOnly` (existing prop) and renders the banner in `editor.banners`.

**D5. Settings store (WP02), additions to plan §2.5.**
- `getSetting(id)` serves every scope; a project-scope id reads the open
  project's value, its default until loaded. `setSetting` is for device and
  account scope; project values go through `useProjectSetting`'s setter.
- `setSettingsProject({projectId, canEdit} | null)`: WP06 calls it when an
  editor page opens and closes. `refreshProjectSettings(): Promise<string[]>`:
  WP06 calls it on the branch signal `settings` and then emits
  `projectSettingsChanged` with the returned ids.
- `openSettings(t)` dispatches the cancelable window event
  `OPEN_SETTINGS_EVENT = 'laytekz:open-settings'` (detail: the target or null);
  WP06 handles it (navigate, then `preventDefault()`); unhandled, the store
  loads `/settings/<section>`. The desktop menu dispatches the same event.
  URLs: `/settings/<section>#<setting>` and `/p/<id>/settings/<section>#<setting>`;
  the section is a `SectionId`; `/settings/desktop-app` (`DESKTOP_APP_PATH`)
  is the desktop shell's own window and shows the `desktop` section on the web.
- The capabilities client is `web/settings/capabilities.ts`
  (`getCapabilities`, `loadCapabilities`, `useCapabilities`,
  `DEFAULT_CAPABILITIES`); `isDesktop()`/`desktopVersion()` are
  `web/util/desktop.ts`, parsing the UA token ` Laytekz-Desktop/<version>`.
- `apiRequest` (web/api.ts) is implemented already: it exposes the existing
  `req` helper.
- **Core setting ids are frozen** in `CORE_SETTING_IDS` (web/settings/types.ts):
  the twelve V1 preferences WP06 moves onto `useSetting` (`appearance.theme`,
  `keys.shortcuts`, `typesetting.auto`, `typesetting.draft`,
  `editor.spellcheck`, `editor.spellLang`, `editor.vim`, `editor.changeMarks`,
  `editor.mode`, `layout.panes`, `pdf.zoom`, `labs.agentPresence`), each on
  its V1 key with its exact V1 codec, plus `typing.explain` and
  `editor.contextMenu`. WP02 defines them in `settings/registry/core.ts`.
- **Default appearance is "Match system"** (V1 answered Q11). WP02's prepaint
  acceptance "gives dark when storage throws" becomes: when storage throws,
  the prepaint follows the system, and gives dark only when `matchMedia` is
  unavailable too (what `index.html` does today). Nothing may assume dark.

**D6. The settings registry** (`web/settings/registry/index.ts`, frozen and
implemented) exports `SECTIONS`, `SETTINGS`, `settingDef(id)`, `settingsIn(section)`
and `REGISTRY_PROBLEMS` (WP02's tests assert it is empty). It reads
`CORE_SETTINGS` (`web/settings/registry/core.ts`, WP02), `EDITOR_SETTINGS`
(`web/editor/core/editorSettingDefs.ts`, a new file for WP05, pure data so the
registry loads no CodeMirror) and every `features/<id>/settings.ts` (exporting
`settings: readonly AnySettingDef[]`). Settings files are pure data: no
runtime import of React, CodeMirror, `.tsx` files or the store
(check-contracts enforces it); a custom control loads lazily through
`control.load()`. A feature's setting ids start with `<featureId>.`; account
ids must match `PREF_KEY_RE`, so `_probe.*` settings are device scope. A bad
definition is dropped and reported, never thrown on. `AnySettingDef` exists
because `hint` makes `SettingDef<T>` invariant in T.

**D7. Keybindings (WP04), additions to plan §2.3.** `web/keys/registry.ts` also
exports `registerKeybindings(defs)` (WP06 registers every feature's at boot),
`keybindings()`, `chordLabel(id)` (outside React) and `bindingFor(e, scopes, {desktop})`.
WP06 dispatches `page` (bubble) and `page-capture` (capture) bindings through
`bindingFor` and runs their command; WP05 dispatches `editor` bindings from
one CodeMirror keydown handler the same way. ⇧⌘C / Ctrl+Shift+C is the
existing `comment` binding (V1's choice): the plan's "rejected: Mod+Shift+C
(devtools)" applies to new bindings only, and the collision test must keep
`comment` on it. The registry's core bindings are V1's five (`typeset`,
`comment`, `jump`, `palette`, `search`; Editor.tsx and CommandPalette.tsx
dispatch them) plus `settings` (⌘, / Ctrl+,, page, `desktop: 'native-menu'`,
command `settings`, dispatched by the page host) and `follow` (Alt+Enter,
editor, run by `modClickExtension()` itself, so it can be rebound).

**D8. Commands (WP04).** `web/commands/index.ts`: `paletteCommands(defs, {page, showcase, viewer})`
(drops refused rows and `when`-false rows, fills `hint` from the binding) and
`settingToggleCommands(defs)` ("Turn X on/off" for `palette: true` switches,
ids `setting.<id>`; existing ids such as `vim` and `spell` are not duplicated).
WP06 calls both.

**D9. Automatic edits (WP08).** `statsEdit` (the annotation that keeps the
statistics fields' own edits from triggering rules) lives in
`web/editor/core/autoEdit.ts` from wave 0, because the core must recognise
it; WP38 re-exports it from `features/stats/api.ts`. The core skips a rule
whose `getSetting(settingId)` is false. WP05 installs `autoEditCore(rules)`
in its own compartment with the rules of the features whose `files` and
`modes` match the open file, and reconfigures it when they change.
`AUTO_EDIT_PRIORITY` and `KEY_CHAIN_PRIORITY` (web/editor/core/types.ts) hold
the plan's priority tables. `lastAutoEdit` is a real (always-null) StateField
in the stub, so importing it never breaks a build.

**D10. Key chains and mod-click (WP04).** `keyChainsExtension()` and
`modClickExtension()` are what WP05 installs once; the facets are
`keyChains` and `modClick`. WP04's own chain entries live inside
`keyChainsExtension()` (Tab: completion 100, indent 0; Escape: completion 100),
so WP05 removes CodePane's current Tab bindings (`acceptCompletion`,
`indentWithTab`) when it installs it. Features' `keyChains`, `modClick` and
`autoEditRules` follow their compartment's files, modes and deps (WP05
provides `keyChains.of(e)` / `modClick.of(h)` inside the feature compartment).

**D11. Late-bound hooks (WP05, `web/editor/core/hooks.ts`).**
`setCiteCommandResolver(fn: (state, filePath) => string | null): () => void`,
`citeCommandFor(state, filePath): string` (default `'cite'`, no backslash),
`onFilesMoved(projectId, branch, moves)`: Editor.tsx calls it for every
`filesMoved` event after remapping its own active file; it remaps file spots
and parked docs.

**D12. Core extraction (WP05) moves nothing out of files WP05 does not own.**
`core/language.ts`, `core/brackets.ts` and `core/completion.ts` import and
group what `editor/latexHighlight.ts`, `editor/latexExtras.ts`,
`editor/completions.ts` and `editor/beginEnv.ts` export today; CodePane then
imports from `core/*`. Those four files stay untouched in wave 0.

**D13. Server feature host (WP03).**
- `registerFeatures(app, features = SERVER_FEATURES)` lives in
  `srv/features/host.ts` (WP03), not in the frozen `index.ts`; `app.ts` gets
  `await registerFeatures(app)` right after `registerRoutes`.
- `ServerFeature.id` is typed `FeatureId`. `ProjectSettingDef.clientVisible`
  defaults to true; unknown `ext` keys never reach a client. `publicExt(meta)`
  is in `srv/features/projectSettings.ts`.
- The project settings revision is kept at `ext[EXT_REV_KEY]` (`'_rev'`),
  never sent as a value. The preference row's provider is `PREFS_PROVIDER`
  (`'laytekz-preferences'`). `tokenWrites`/`viewerWrites` entries are
  `'METHOD /route/pattern'`.
- Wire types (both sides): `AccountPrefsResponse {prefs, rev: number, updatedAt: string | null}`
  (every GET/PATCH/PUT reply), `AccountPrefsPatch`, `AccountPrefsPut`,
  `ProjectSettingsResponse {values, rev: number}`, `ProjectSettingsPatch`;
  errors are `{ error, key? }`. `PREF_KEY_RE`, `PREF_LIMITS`.
- `Capabilities {rev: string, accounts, prefs, mcp, oauthRegistration, …}` is
  the same type on both sides.

**D14. collab.ts primitives** (stubs in `srv/collab.ts`, Galley-marked; WP03
implements and tests them):
`flushBranchDocsHashed(projectId, branch): Record<path, sha256-16>`;
`branchChangeEvents: BranchChangesEmitter` (`'change'` with
`{projectId, branch, paths | null, version}`; the plan's "branchChanges
emitter", renamed because `branchChanges` is collab.ts's existing version map);
`applySpansToDoc(projectId, branch, filePath, after, origin?): {from,to}[] | null`;
`moveDocState(projectId, branch, from, to, {folder?, files?}?)`;
`copyDocState({projectId, branch}, {projectId, branch}, paths): number`;
`signalBranch(projectId, branch | '*', key, value)`;
`registerDocLoadHook(fn): () => void`. `RouteKit.signal` is `signalBranch`.
Signal keys with a meaning: `settings` (value: the new project settings rev;
WP06 then calls `refreshProjectSettings()` and emits `projectSettingsChanged`)
and `moves` (`FILES_MOVED_SIGNAL`, value `FilesMovedSignal {moves, by, at}`;
WP28 sends it from wave 3, WP06 emits `filesMoved` from it in wave 0). WP06
adds `onSignal(key, fn: (value: unknown) => void): () => void` to its branch
signal for them.

**D15. Desktop shell (WP09).** `desk/src/main/features/index.js` documents
`ShellFeature`, `ShellPage` and `ShellCtx` in JSDoc. Added: `settingsPage`,
the page the shell opens for `<base>/settings/desktop-app`; the stub
`desktopSettings` feature sets `'change-server.html'` (today's Change Server
page), so WP09's intercept opens whatever that feature names and WP41 later
changes only its own feature. Feature modules never import `electron` at
their top level (the list loads in plain Node).

**D16. The e2e mock router.** `e2e/tests/mock-zotero.mjs` (name kept) loads
every `e2e/tests/mocks/*.mjs` (a leading `_` skips a file). A module exports
`handle(req, res, {port, url, send}) → boolean | Promise<boolean>`, optional
`order` (default 500) and `start({port})`. `zotero.mjs` is order 1000 and
answers every remaining path (403 without its key), so new mocks sort before
it and claim their own path prefix. The V1 behaviour is split across
`anthropic.mjs` (100), `refs.mjs` (200, WP16 owns it), `venues.mjs` (300),
`mendeley.mjs` (400, a stub; WP35 owns it with `zotero.mjs`). A request-level
comparison against the V1 mock (27 requests: status, headers, bodies, and the
venue registry file) is byte-identical. `playwright.config.ts` passes these
to the app server (`V2_MOCK_ENV`); the server reads none of them yet:

| Variable | Value in e2e | Served by |
|---|---|---|
| `CROSSREF_API_BASE` | `http://localhost:<mock>/crossref` | refs.mjs (WP16) |
| `DATACITE_API_BASE` | `…/datacite` | refs.mjs |
| `PUBMED_API_BASE` | `…/pubmed` | refs.mjs |
| `OPENLIBRARY_API_BASE` | `…/openlibrary` | refs.mjs |
| `S2_API_BASE` | `…/s2` | refs.mjs |
| `MENDELEY_API_BASE` | `…/mendeley` | mendeley.mjs (WP35) |
| `MENDELEY_OAUTH_BASE` | `…/mendeley/oauth` | mendeley.mjs |
| `MENDELEY_CLIENT_ID`, `MENDELEY_CLIENT_SECRET` | `e2e-mendeley`, `e2e-mendeley-secret` | (turns the provider on against the mock) |
| `ZOTERO_OAUTH_BASE` | `…/zotero-oauth` | zotero.mjs (WP35); no Zotero OAuth credentials are set, so spec 05's API-key flow is unchanged |
| `ALDINE_INSTANCE_PET` | `$(pwd)/e2e/fixtures/operator/pet-test.png` | WP39 adds the grey test shape |

The existing `ZOTERO_API_BASE`, `DOI_API_BASE`, `ARXIV_API_BASE`,
`OPENALEX_API_BASE` and `ANTHROPIC_BASE_URL` stay at the mock's root.

**D17. Ownership additions to the plan's rows.** WP04 also owns
`web/util/menuModel.ts` (Menu.tsx's model) and its test; WP05 owns
`web/editor/core/editorSettingDefs.ts` (D6); WP03 owns
`srv/features/_probe/**` (the server half of the probe, for its feature-host
tests); WP06 owns `web/features/__tests__/**`; WP09 owns `desk/tests/mocks/**`;
WP15 owns `srv/features/{citations,crossrefs}/**` (route registration for
`…/cite-setup` and `…/labels`); WP16 owns `srv/features/references/**`;
WP32 and WP37 own `web/features/highlighter/**` in their waves, WP40 owns
`web/features/suggest/**` except `model/**`, WP44 owns `web/features/pet/**`
except `engine/**`. WP07 owns the V1 specs that open a settings dialog (listed
in ownership.json).

**D18. Stubs.** Bodies throw `Not implemented yet: <module> <name> (<WP> <slug>)`.
Exceptions, because a throw would be worse: facets and the `lastAutoEdit`
field are real definitions; `RESERVED` and the stub settings lists are empty
arrays; `DEFAULT_CAPABILITIES` is real; `pages/Settings.tsx` renders a
placeholder (`data-testid="settings-page-stub"`) so WP06's routes can be
exercised; `apiRequest` is implemented (D5); the desktop stub
`desktopSettings` carries `settingsPage` (D15). No existing code path imports
any of it.

## 6. Wave 0: who calls whose stubs at run time

| Package | Calls at run time (stubs until that package lands) |
|---|---|
| WP02 settings-core | the registry (WP01, real) |
| WP03 server-foundation | nothing new |
| WP04 input-core | `getSetting` (WP02) for `editor.contextMenu` and palette toggles |
| WP05 editor-host | `getSetting`/`subscribeSetting` (WP02), `autoEditCore` (WP08), `keyChainsExtension`/`modClickExtension`/`contextMenuExtension`/`bindingFor` (WP04) |
| WP06 page-host | `useSetting`/`startSettings`/`setSettingsProject`/`refreshProjectSettings`/capabilities/`isDesktop` (WP02), `paletteCommands`/`settingToggleCommands`/`registerKeybindings`/`bindingFor` (WP04), Settings page (WP07, placeholder), `onFilesMoved` (WP05) |
| WP07 settings-shell | the store and registry (WP02, WP01), `useChordLabel`/`setChord` (WP04) for the Shortcuts rows it embeds |
| WP08 typing-core | `getSetting`/`setSetting` (WP02) for rule switches and "Turn off" |
| WP09 desktop-shell | nothing from the other packages |

Guard calls into unfinished neighbours in your own tests (mocks), keep the
editor working when a stub would throw where that is cheap (a try around an
optional extension), and use `--with` for smoke runs.
