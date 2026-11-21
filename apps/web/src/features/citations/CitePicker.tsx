import { useEffect, useMemo, useState } from 'react';
import { cachedBib, loadBib } from '../../editor/latexExtras';
import { matchesShortcut } from '../../keys/registry';
import { getSetting } from '../../settings/store';
import PickerShell, { type PickerChip, type PickerRow } from './PickerShell';
import { applyChoice, removeCitation } from './actions';
import {
  citationFor, formatLocator, LOCATOR_LABELS, locatorOf, notesOf, STYLE_LABELS, styleOf, stylesFor,
  type CiteStyle, type LocatorKind,
} from './citeCommands';
import { apaByline, rankEntries, type Entry } from './entries';
import { cachedSetup, loadSetup } from './refIndex';
import { CITATION_SETTINGS, type EnterChoice } from './settings';
import { closePicker, type PickerRequest } from './store';

export const INSERT_BINDING = 'citations.insert';
const PRENOTES = ['see', 'see also', 'e.g.,', 'cf.'];
const MAIN: readonly CiteStyle[] = ['parenthetical', 'narrative'];

function enterStyle(): CiteStyle {
  try {
    return getSetting<EnterChoice>(CITATION_SETTINGS.enter) === 'narrative' ? 'narrative' : 'parenthetical';
  } catch {
    return 'parenthetical';
  }
}

const other = (s: CiteStyle): CiteStyle => (s === 'narrative' ? 'parenthetical' : 'narrative');

/**
 * The citation picker (⇧⌘E). Search the project's references, Tab to cite
 * several, choose the style and the notes, Enter to insert. Opened with the
 * caret in a citation it edits that one ("Edit citation"), prefilled.
 */
export default function CitePicker({ req }: { req: PickerRequest }) {
  const { page, family } = req;
  const edit = req.mode === 'edit' && req.citation ? req.citation : null;
  const initialNotes = edit ? notesOf(edit) : { prenote: '', postnote: '' };
  const initialLocator = locatorOf(initialNotes.postnote);

  const [entries, setEntries] = useState<Entry[]>(() => cachedBib(page.projectId, page.branch));
  const [setup, setSetup] = useState(() => cachedSetup(page.projectId, page.branch));
  const [query, setQuery] = useState(req.query);
  const [active, setActive] = useState(0);
  const [keys, setKeys] = useState<string[]>(edit ? edit.keys : []);
  const available = stylesFor(family);
  const [style, setStyle] = useState<CiteStyle>(() => {
    const s = edit ? styleOf(edit.command, family) : enterStyle();
    return s && available.includes(s) ? s : 'parenthetical';
  });
  const [prenote, setPrenote] = useState(initialNotes.prenote);
  const [kind, setKind] = useState<LocatorKind>(initialLocator.kind);
  const [locator, setLocator] = useState(initialLocator.value);
  const [notesTouched, setNotesTouched] = useState(false);

  useEffect(() => {
    let live = true;
    void loadBib(page.projectId, page.branch, true).then((e) => { if (live) setEntries(e); });
    void loadSetup(page.projectId, page.branch).then((s) => { if (live && s) setSetup(s); });
    return () => { live = false; };
  }, [page]);

  const cited = useMemo(() => new Set(req.cited.keys()), [req.cited]);
  const rows = useMemo(() => rankEntries(entries, query, cited), [entries, query, cited]);
  useEffect(() => { if (active >= rows.length) setActive(0); }, [rows, active]);
  const known = useMemo(() => new Set(entries.map((e) => e.key)), [entries]);

  const close = () => {
    closePicker();
    page.view()?.focus();
  };

  const notes = () => (!notesTouched && edit
    ? initialNotes
    : { prenote: family === 'bibtex' ? '' : prenote, postnote: formatLocator(family, kind, locator) });

  const keysWith = (i: number): string[] => {
    const row = query.trim() && i >= 0 ? rows[i] : undefined;
    return row && !keys.includes(row.entry.key) ? [...keys, row.entry.key] : keys;
  };

  const submit = (i: number, shift: boolean) => {
    const chosen = keysWith(i);
    if (!chosen.length) {
      if (rows[i]) chosen.push(rows[i].entry.key);
      else return;
    }
    let s = style;
    if (shift) {
      s = MAIN.includes(style) ? other(style) : 'narrative';
      if (!available.includes(s)) { page.toast('Narrative citations need natbib or biblatex.', 'info'); return; }
    }
    const n = notes();
    if (applyChoice(req, { keys: chosen, style: s, prenote: n.prenote, postnote: n.postnote })) closePicker();
  };

  const addRow = (i: number): boolean => {
    const row = rows[i];
    if (!row) return false;
    if (!keys.includes(row.entry.key)) setKeys([...keys, row.entry.key]);
    setQuery('');
    setActive(0);
    return true;
  };

  const preview = citationFor(family, style, keysWith(active).length ? keysWith(active) : ['key'], notes()) ?? '';
  const chips: PickerChip[] = keys.map((k) => ({ id: k, label: k, error: entries.length > 0 && !known.has(k), title: known.has(k) || !entries.length ? undefined : 'No entry with this key in the project' }));
  const loaded = setup?.bibFiles?.length ? new Set(setup.bibFiles) : null;

  const pickerRows: PickerRow[] = rows.map(({ entry, alsoIn }) => {
    const times = req.cited.get(entry.key) ?? 0;
    return {
      id: entry.key,
      testId: `cite-picker-row-${entry.key}`,
      chosen: keys.includes(entry.key),
      content: (
        <>
          <div className="picker__line">{apaByline(entry)}</div>
          {entry.title && <div className="picker__sub">{entry.title.replace(/[{}]/g, '')}</div>}
        </>
      ),
      aside: (
        <>
          <span className="picker__key">{entry.key}</span>
          <span style={{ display: 'flex', gap: 4 }}>
            {/(^|\/)zotero\.bib$/i.test(entry.file) && <span className="picker__badge">Zotero</span>}
            {times > 0 && <span className="picker__badge">cited {times}×</span>}
            {loaded && !loaded.has(entry.file) && <span className="picker__badge" title={`${entry.file} is not loaded by the document`}>not loaded</span>}
          </span>
          {alsoIn.length > 0 && <span>also in {alsoIn.join(', ')}</span>}
        </>
      ),
    };
  });

  const searchOnline = () => {
    close();
    page.ui.showPanel('plugin:references', query.trim() || undefined);
  };

  const empty = entries.length === 0
    ? (
      <>
        <span>No references in this project&rsquo;s .bib files yet.</span>
        <span style={{ display: 'flex', gap: 12 }}>
          <button type="button" className="picker__link" onClick={searchOnline} data-testid="cite-picker-online">Search papers online</button>
          <button type="button" className="picker__link" onClick={() => { close(); page.ui.showPanel('plugin:zotero'); }} data-testid="cite-picker-zotero">Import from Zotero</button>
        </span>
      </>
    )
    : (
      <>
        <span>No references match &ldquo;{query}&rdquo;.</span>
        <button type="button" className="picker__link" onClick={searchOnline} data-testid="cite-picker-online">Search papers online for &ldquo;{query}&rdquo;</button>
      </>
    );

  return (
    <PickerShell
      label={edit ? 'Edit citation' : 'Insert citation'}
      note={setup && family === setup.family ? setup.label : req.familyLabel}
      query={query}
      onQuery={(q) => { setQuery(q); setActive(0); }}
      placeholder="Search by author, year, title or key"
      rows={pickerRows}
      active={active}
      onActive={setActive}
      chips={chips}
      onRemoveChip={(id) => setKeys(keys.filter((k) => k !== id))}
      onChoose={(i, o) => submit(i, o.shift)}
      onTab={addRow}
      onKey={(e) => {
        // The picker's own chord flips parenthetical and narrative.
        if (matchesShortcut(e.nativeEvent, INSERT_BINDING)) {
          const next = other(style);
          if (available.includes(next)) setStyle(next);
          return true;
        }
        // Enter in a notes field inserts too (the search field handles its own).
        const t = e.target as HTMLElement;
        if (e.key === 'Enter' && (t.tagName === 'INPUT' || t.tagName === 'SELECT') && !t.classList.contains('picker__input')) {
          submit(active, e.shiftKey);
          return true;
        }
        return false;
      }}
      onClose={close}
      empty={empty}
      testId="cite-picker"
      footer={(
        <>
          <span>↵ insert · ⇧↵ {MAIN.includes(style) ? STYLE_LABELS[other(style)].toLowerCase() : 'narrative'} · Tab add another · Esc close</span>
          <span className="picker__spacer" />
          {edit && (
            <button type="button" className="picker__danger" data-testid="cite-picker-remove" onClick={() => { if (removeCitation(req)) closePicker(); }}>
              Remove citation
            </button>
          )}
        </>
      )}
    >
      <div className="picker__section">
        <label>
          Prenote
          <input
            list="cite-picker-prenotes"
            value={prenote}
            disabled={family === 'bibtex'}
            title={family === 'bibtex' ? 'Prenotes need natbib, biblatex or apacite' : undefined}
            onChange={(e) => { setPrenote(e.target.value); setNotesTouched(true); }}
            data-testid="cite-prenote"
          />
          <datalist id="cite-picker-prenotes">{PRENOTES.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <label>
          <select value={kind} onChange={(e) => { setKind(e.target.value as LocatorKind); setNotesTouched(true); }} aria-label="Locator" data-testid="cite-locator-kind">
            {(Object.keys(LOCATOR_LABELS) as LocatorKind[]).map((k) => <option key={k} value={k}>{LOCATOR_LABELS[k]}</option>)}
          </select>
          <input value={locator} onChange={(e) => { setLocator(e.target.value); setNotesTouched(true); }} aria-label="Locator value" placeholder={kind === 'page' ? '12 or 12-15' : ''} data-testid="cite-locator" />
        </label>
      </div>
      <div className="picker__section">
        <div className="picker__styles" role="group" aria-label="Style">
          {(Object.keys(STYLE_LABELS) as CiteStyle[]).filter((s) => available.includes(s) || s === 'narrative').map((s) => (
            <button
              key={s}
              type="button"
              className="picker__style"
              aria-pressed={style === s}
              disabled={!available.includes(s)}
              title={!available.includes(s) ? 'Narrative citations need natbib or biblatex' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setStyle(s)}
              data-testid={`cite-style-${s}`}
            >
              {STYLE_LABELS[s]}
            </button>
          ))}
        </div>
        <span className="picker__preview" data-testid="cite-picker-preview">{preview}</span>
      </div>
    </PickerShell>
  );
}
