/**
 * The settings page (WP07 settings-shell): every registry section in one
 * scrolling column beside a section nav, each setting as a generic row with
 * a scope badge, and the existing rows embedded where they already worked
 * (the project's rows, the account's, the connections, the shortcut
 * recorders). WP06 renders it lazily for /settings/<section> and, over a
 * project's editor that stays mounted, for /p/<id>/settings/<section>; the
 * `#<setting id>` of the address arrives as `setting` and highlights its row.
 *
 * It is a dialog (components/Modal): the editor's keys stand down while it
 * is open, a confirmation opened from inside it stacks above it, Escape and
 * Close call `onClose`, and focus returns to the opener. The V1 test ids
 * stay on the same controls (components/settings/model.ts LEGACY_TEST_IDS);
 * new ones are `settings-page` and `setting-<id>`.
 *
 * WP23 completes it: search in the header (Escape clears it first, `/`
 * comes back to it), the sync status, Reset on rows and sections, Reset all,
 * export and import of laytekz-settings.json with a preview and Undo, every
 * keybinding in the Shortcuts section, the typography preview, the Desktop
 * app section and the Labs note.
 */
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { AnySettingDef, SectionId, SettingsEnv, SettingsPageProps } from '../settings/types';
import { DESKTOP_APP_PATH } from '../settings/types';
import { SECTIONS, SETTINGS, settingDef, settingsIn } from '../settings/registry';
import { defaultOf, getSetting } from '../settings/store';
import { DEFAULT_CAPABILITIES, getCapabilities, loadCapabilities } from '../settings/capabilities';
import { isDesktop } from '../util/desktop';
import { useMediaQuery } from '../util/useMediaQuery';
import { documentTitle } from '../util/documentTitle';
import { localUser, setLocalName, type AuthUser } from '../api';
import type { Capabilities } from '../features/types';
import Modal from '../components/Modal';
import { useAuth } from '../components/Auth';
import { ProjectRows, YourNameField } from '../components/ProjectSettings';
import { AccountIdentity, AgentAccess, CommitEmailRow, GitHosts, PasswordForm, PersonalTemplates, SignInMethods, usePasswordChange, ZoteroKey } from '../components/AccountSettings';
import { SettingRow } from '../components/settings/SettingRow';
import { accountRun, EMBEDDED_SETTING_IDS, embeddedSections, isRowVisible, pageSections, resolveSection, scopeName, scopeNote, sectionDomId, sectionInView, sectionPath, settingsEnv } from '../components/settings/model';
import { countText, EMBEDDED_TERMS, searchSections, type FilteredSection } from '../components/settings/search';
import { ShortcutsSection, shortcutTerms, useKeybindings } from '../components/settings/ShortcutsSection';
import { TypographyPreview } from '../components/settings/TypographyPreview';
import { DesktopRows, ImportPreview, LabsNote, SyncStatusLine } from '../components/settings/parts';
import { useChangedCount, useSettingsActions, useSettingsConflictToast } from '../components/settings/actions';
import { buildExport, isPortable, planImport, TRANSFER_FILENAME, type ImportPlan } from '../components/settings/transfer';
import { useToast } from '../components/Toast';
import '../components/settings/settings.css';

/** Saves `text` as a file the browser downloads. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Typing `/` outside a field comes back to the search. */
function typesIntoField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** The capabilities client (WP02), read so that a missing or failing one leaves the defaults. */
function usePageCapabilities(): Capabilities {
  const [caps, setCaps] = useState<Capabilities>(() => { try { return getCapabilities(); } catch { return DEFAULT_CAPABILITIES; } });
  useEffect(() => {
    let live = true;
    try { loadCapabilities().then((c) => { if (live) setCaps(c); }, () => {}); } catch { /* keeps the defaults */ }
    return () => { live = false; };
  }, []);
  return caps;
}

function inDesktopApp(): boolean {
  try { return isDesktop(); } catch { return false; }
}

/** The tab's title while the page is open; the opener's own title comes back
 *  on close unless the opener changed it meanwhile (a rename from here). */
function usePageTitle(): void {
  useEffect(() => {
    const before = document.title;
    const mine = documentTitle('Settings');
    document.title = mine;
    return () => { if (document.title === mine) document.title = before; };
  }, []);
}

/** `el`'s top inside the scroll box `root`. */
function topWithin(el: HTMLElement, root: HTMLElement): number {
  let top = 0;
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) {
    top += n.offsetTop;
    if (n.offsetParent && !root.contains(n.offsetParent)) return top - root.offsetTop;
  }
  return top;
}

export default function Settings({ section, setting, project, onClose }: SettingsPageProps) {
  const { authEnabled, user } = useAuth();
  const phone = useMediaQuery('(max-width: 640px)');
  const capabilities = usePageCapabilities();
  const desktop = useMemo(inDesktopApp, []);
  const location = useLocation();
  usePageTitle();

  const env = useMemo(
    () => settingsEnv({ accounts: authEnabled, signedIn: !!user, desktop, phone, capabilities, project }),
    [authEnabled, user, desktop, phone, capabilities, project],
  );
  // /settings/desktop-app reached the page: no desktop shell intercepted it.
  const viaAppPath = location.pathname.replace(/\/+$/, '').endsWith(`/settings/${DESKTOP_APP_PATH}`);
  const all = useMemo(
    () => pageSections(SECTIONS, settingsIn, env, embeddedSections({ accounts: authEnabled, signedIn: !!user, project: !!project, desktop: desktop || section === 'desktop' || viaAppPath })),
    [env, authEnabled, user, project, desktop, section, viaAppPath],
  );
  const projectId = project?.project.id ?? null;

  // WP23: search over the sections and rows.
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const bindings = useKeybindings();
  const searched = useMemo(
    () => searchSections(all, query, (id) => (id === 'shortcuts' ? shortcutTerms(bindings) : EMBEDDED_TERMS[id] ?? [])),
    [all, query, bindings],
  );
  const shown = searched.sections;

  // WP23: what Reset, Reset all and Export cover: the settings on show here, and the shortcut overrides.
  const resettable = useMemo(
    () => [...SETTINGS.values()].filter((d) => isPortable(d) && (isRowVisible(d, env) || EMBEDDED_SETTING_IDS.has(d.id))),
    [env],
  );
  const actions = useSettingsActions();
  const toast = useToast();
  useSettingsConflictToast();
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const exportSettings = () => {
    const file = buildExport(SETTINGS.values(), (id) => getSetting<unknown>(id), defaultOf);
    download(TRANSFER_FILENAME, `${JSON.stringify(file, null, 2)}\n`);
    const n = Object.keys(file.settings).length;
    toast(n ? `Exported ${n === 1 ? '1 setting' : `${n} settings`} to ${TRANSFER_FILENAME}` : `Exported ${TRANSFER_FILENAME}: every setting is at its default`, 'ok');
  };
  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) { toast('That file is too big to be a Laytekz settings file.', 'error'); return; }
    let text = '';
    try { text = await file.text(); } catch { toast('That file could not be read.', 'error'); return; }
    const plan = planImport(text, settingDef, (id) => getSetting<unknown>(id));
    if ('error' in plan) { toast(plan.error, 'error'); return; }
    setImportPlan(plan);
  };
  const applyImport = () => {
    const plan = importPlan;
    setImportPlan(null);
    if (!plan) return;
    actions.applyImport(plan.changes.map((c) => ({ def: settingDef(c.id)!, to: c.to })).filter((c) => !!c.def));
  };

  // A token shown once must be copied before the page may close (V1's Account settings rule).
  const [secretShown, setSecretShown] = useState(false);
  const [current, setCurrent] = useState<SectionId | null>(() => resolveSection(section, all) ?? all[0]?.def.id ?? null);
  const [target, setTarget] = useState<string | null>(setting ?? null);
  const contentRef = useRef<HTMLDivElement>(null);
  // The scroll this page makes itself keeps the section it chose current.
  const ownScroll = useRef(false);

  const scrollTo = (el: HTMLElement, center = false) => {
    const root = contentRef.current;
    if (!root) return;
    const top = Math.max(0, Math.min(root.scrollHeight - root.clientHeight, topWithin(el, root) - (center ? (root.clientHeight - el.offsetHeight) / 2 : 0)));
    if (Math.round(root.scrollTop) === Math.round(top)) return;
    ownScroll.current = true;
    root.scrollTop = top;
  };

  // The address names a section and maybe a row: show it (again when it changes while open).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    setTarget(setting ?? null);
    const row = setting ? Array.from(root.querySelectorAll<HTMLElement>('[data-setting-row]')).find((el) => el.dataset.settingRow === setting) : undefined;
    if (row) {
      scrollTo(row, true);
      row.querySelector<HTMLElement>('input:not([disabled]),select:not([disabled]),button:not([disabled]),textarea:not([disabled])')?.focus({ preventScroll: true });
      const sec = row.closest<HTMLElement>('[data-section]')?.dataset.section as SectionId | undefined;
      if (sec) setCurrent(sec);
      return;
    }
    const sec = resolveSection(section, all);
    const el = sec ? document.getElementById(sectionDomId(sec)) : null;
    if (sec && el) { scrollTo(el); setCurrent(sec); }
    // `shown` is read for this address only; a section appearing later (account data) does not scroll again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, setting]);

  // The nav follows the reading position.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (ownScroll.current) { ownScroll.current = false; return; }
      const tops = Array.from(root.querySelectorAll<HTMLElement>('[data-section]')).map((el) => ({ id: el.dataset.section as SectionId, top: topWithin(el, root) }));
      const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      const id = sectionInView(tops, root.scrollTop, atEnd);
      if (id) setCurrent(id);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => { root.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, []);

  // A new search starts at the top of the column (not on open: the address may have scrolled to a section).
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    const root = contentRef.current;
    if (root && root.scrollTop) { ownScroll.current = true; root.scrollTop = 0; }
  }, [query]);

  // On a phone the nav is a line of chips: keep the current one in view.
  useEffect(() => {
    const nav = navRef.current;
    if (!phone || !nav || !current) return;
    const el = nav.querySelector<HTMLElement>(`[data-testid="settings-nav-${current}"]`);
    if (!el) return;
    const left = el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2;
    nav.scrollLeft = Math.max(0, left);
  }, [phone, current]);

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Escape clears a typed search first (Modal leaves it to this field); the next Escape closes.
    if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); }
  };
  const onFrameKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typesIntoField(e.target)) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };

  const go = (id: SectionId) => {
    const el = document.getElementById(sectionDomId(id));
    if (el) scrollTo(el);
    setCurrent(id);
    setTarget(null);
  };

  const run = accountRun(shown, authEnabled && !!user);
  const embeddedProps = {
    user: authEnabled ? user : null,
    accounts: authEnabled,
    project,
    focusSignIn: setting === 'sign-in',
    shortcutsScope: scopeName(settingDef('keys.shortcuts') ?? { scope: 'device' }, env),
    onSecret: setSecretShown,
    onPasswordChanged: onClose,
    query,
    desktop,
    viaAppPath,
  };
  const sectionEls = shown.map((s) => (
    <SettingsSection
      key={s.def.id}
      section={s}
      env={env}
      target={target}
      head={s.embeddedShown ? <EmbeddedRows id={s.def.id} part="head" {...embeddedProps} /> : s.def.id === 'labs' ? <LabsNote /> : null}
      tail={s.embeddedShown ? <EmbeddedRows id={s.def.id} part="tail" {...embeddedProps} /> : s.def.id === 'editor-text' ? <TypographyPreview /> : null}
      resetDefs={resettable.filter((d) => d.section === s.def.id)}
      onResetSection={(defs) => { void actions.resetSection(s.def.title, defs); }}
    />
  ));
  const countLine = countText(query, searched.count);

  return (
    <Modal onClose={onClose} label="Settings" testId="settings-page" className="settings-page" initialFocus={phone ? 'panel' : searchRef} dismissable={!secretShown && !importPlan}>
      <div className="settings-page__frame" onKeyDown={onFrameKey}>
        <header className="settings-page__head">
          <div className="settings-page__heading">
            <h2>Settings</h2>
            <SyncStatusLine />
          </div>
          <p className="modal__sub" data-testid="settings-scope-note">{scopeNote(env)}</p>
          <div className="settings-page__search">
            <input
              ref={searchRef}
              type="search"
              className="input settings-search"
              placeholder="Search settings"
              aria-label="Search settings"
              aria-describedby="settings-search-count"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              autoComplete="off"
              spellCheck={false}
              data-testid="settings-search"
            />
            <span id="settings-search-count" className="settings-search__count" aria-live="polite" data-testid="settings-search-count">{query.trim() && searched.count ? countLine : ''}</span>
          </div>
        </header>
        <div className="settings-page__body" data-testid={project ? 'project-settings' : undefined}>
          <nav className="settings-page__nav" aria-label="Settings sections" data-testid="settings-nav" ref={navRef}>
            <ul>
              {shown.map((s) => (
                <li key={s.def.id}>
                  <Link
                    to={{ pathname: sectionPath(s.def.id, projectId), search: location.search }}
                    replace
                    onClick={(e: MouseEvent<HTMLAnchorElement>) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) go(s.def.id); }}
                    aria-current={current === s.def.id ? 'true' : undefined}
                    className={`settings-page__link${current === s.def.id ? ' is-current' : ''}`}
                    data-testid={`settings-nav-${s.def.id}`}
                  >
                    {s.def.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="settings-page__content" ref={contentRef} data-testid="settings-content">
            {query.trim() && !shown.length && (
              <p className="settings-search__empty" data-testid="settings-search-empty">{countLine}</p>
            )}
            {run
              ? <>
                  {sectionEls.slice(0, run.start)}
                  <div data-testid="account-settings">{sectionEls.slice(run.start, run.end + 1)}</div>
                  {sectionEls.slice(run.end + 1)}
                </>
              : sectionEls}
          </div>
        </div>
        <div className="modal__row settings-page__foot">
          <div className="settings-page__tools">
            <button type="button" className="btn" onClick={exportSettings} data-testid="settings-export">Export settings…</button>
            <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="settings-import">Import settings…</button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { void importFile(e); }} data-testid="settings-import-file" />
            <button type="button" className="btn" onClick={() => { void actions.resetAll(resettable, authEnabled && !!user && getSetting<boolean>('account.sync') !== false); }} data-testid="settings-reset-all">Reset all settings…</button>
          </div>
          <button type="button" className="btn" onClick={onClose} data-testid="settings-close">Close</button>
        </div>
      </div>
      {importPlan && <ImportPreview plan={importPlan} onApply={applyImport} onCancel={() => setImportPlan(null)} />}
    </Modal>
  );
}

/** "Reset this section", while one of its settings differs from its default. */
function SectionReset({ id, defs, onReset }: { id: SectionId; defs: readonly AnySettingDef[]; onReset(defs: readonly AnySettingDef[]): void }) {
  const changed = useChangedCount(defs);
  if (!changed) return null;
  return (
    <div className="settings-page__section-foot">
      <button type="button" className="btn btn--small" onClick={() => onReset(defs)} data-testid={`${sectionDomId(id)}-reset`}>Reset this section</button>
    </div>
  );
}

/** A section: its embedded head, its generic rows, the automatic ones, then its embedded tail and its reset. */
function SettingsSection({ section, env, target, head, tail, resetDefs, onResetSection }: {
  section: FilteredSection; env: SettingsEnv; target: string | null; head: ReactNode; tail: ReactNode;
  resetDefs: readonly AnySettingDef[]; onResetSection(defs: readonly AnySettingDef[]): void;
}) {
  const { def, rows, automatic } = section;
  const titleId = `${sectionDomId(def.id)}-title`;
  return (
    <section id={sectionDomId(def.id)} className="settings-page__section" aria-labelledby={titleId} data-section={def.id} data-testid={sectionDomId(def.id)}>
      <h3 id={titleId} className="settings-page__title">{def.title}</h3>
      {head}
      {rows.map((d) => <SettingRow key={d.id} def={d} env={env} target={target === d.id} />)}
      {automatic.length > 0 && (
        <div className="settings-page__group" role="group" aria-labelledby={`${titleId}-automatic`} data-testid={`${sectionDomId(def.id)}-automatic`}>
          <div id={`${titleId}-automatic`} className="menu__label settings__heading">Automatic changes</div>
          {automatic.map((d) => <SettingRow key={d.id} def={d} env={env} target={target === d.id} />)}
        </div>
      )}
      {tail}
      {resetDefs.length > 0 && <SectionReset id={def.id} defs={resetDefs} onReset={onResetSection} />}
    </section>
  );
}

/** The rows the page embeds, by section: what already worked in V1's dialogs.
 *  `head` comes before the section's generic rows, `tail` after them (only
 *  the account has one: who you are first, then its settings, then the
 *  commit email, sign-in methods and password). */
function EmbeddedRows({ id, part, user, accounts, project, focusSignIn, shortcutsScope, onSecret, onPasswordChanged, query, desktop, viaAppPath }: {
  id: SectionId;
  part: 'head' | 'tail';
  user: AuthUser | null;
  accounts: boolean;
  project: SettingsPageProps['project'];
  focusSignIn: boolean;
  shortcutsScope: string;
  onSecret(shown: boolean): void;
  onPasswordChanged(): void;
  query: string;
  desktop: boolean;
  viaAppPath: boolean;
}) {
  if (id === 'account') {
    if (!accounts) return part === 'head' ? <LocalNameRow project={project} /> : null;
    if (!user) return null;
    return part === 'head' ? <AccountIdentity user={user} /> : <AccountRows user={user} focusSignIn={focusSignIn} onPasswordChanged={onPasswordChanged} />;
  }
  if (part === 'tail') return null;
  if (id === 'connections') {
    if (!user) return null;
    return (
      <>
        <AgentAccess onSecret={onSecret} />
        <GitHosts />
        <PersonalTemplates />
        <ZoteroKey />
      </>
    );
  }
  if (id === 'shortcuts') return <ShortcutsSection query={query} desktop={desktop} scopeName={shortcutsScope} />;
  if (id === 'desktop') return <DesktopRows desktop={desktop} viaAppPath={viaAppPath} />;
  if (id === 'project' && project) return <ProjectRows {...project} heading={false} />;
  return null;
}

/** Without accounts: the name this browser writes under. Over a project the
 *  editor's own setter keeps its presence identity in step. */
function LocalNameRow({ project }: { project: SettingsPageProps['project'] }) {
  const [own, setOwn] = useState(() => localUser().name);
  const name = project?.yourName ?? own;
  const save = (n: string) => {
    if (project?.onSetYourName) project.onSetYourName(n);
    setOwn(setLocalName(n));
  };
  return (
    <div className="settings__row settings-row" data-setting-row="your-name">
      <div className="settings__text">
        <span className="settings-row__head">
          <label className="settings__label" htmlFor="settings-your-name">Your name</label>
        </span>
        <span className="settings__hint">Co-authors see it on your cursor, your comments and your commits</span>
      </div>
      <div className="settings__control">
        <YourNameField name={name} onSave={save} />
      </div>
    </div>
  );
}

/** The account's rows after its identity: commit email, sign-in methods, password. */
function AccountRows({ user, focusSignIn, onPasswordChanged }: { user: AuthUser; focusSignIn: boolean; onPasswordChanged(): void }) {
  const pw = usePasswordChange(onPasswordChanged);
  const sso = !!user.provider;
  return (
    <>
      <CommitEmailRow user={user} />
      {!sso && <div data-setting-row="sign-in"><SignInMethods focus={focusSignIn} /></div>}
      <PasswordForm user={user} pw={pw} />
      {!sso && (
        <div className="settings-page__actions">
          <button type="submit" form="change-password" className={`btn${pw.ready ? ' btn--primary' : ''}`} disabled={pw.busy} aria-busy={pw.busy || undefined} data-testid="save-password">{pw.busy ? '…' : 'Update password'}</button>
        </div>
      )}
    </>
  );
}
