import { useEffect, useMemo, useState } from 'react';
import { matchesShortcut } from '../../keys/registry';
import { loadSetup, PickerShell, type PickerChip, type PickerRow } from '../citations/api';
import { applyReference, chosenStyle, documentSetup, insertLabelHere } from './actions';
import { cachedLabels, loadLabels } from './labelIndex';
import {
  buildReference, GROUPS, groupOf, kindLabel, rankLabels, refSetupOf, setupNote, STYLE_LABELS, stylesFor,
  type LabelDetail, type RefGroup, type RefStyle,
} from './refCommands';
import { closeRefPicker, type RefPickerRequest } from './store';

export const INSERT_BINDING = 'crossrefs.insert';

/**
 * The cross-reference picker (⇧⌘X). Lists the project's labels by kind
 * (figures, tables, equations, sections …) with their captions or headings;
 * type to filter, Tab to reference several, Enter to insert the document's
 * form (\cref, Figure~\ref …), Shift+Enter for a bare \ref.
 */
export default function RefPicker({ req }: { req: RefPickerRequest }) {
  const { page } = req;
  const [labels, setLabels] = useState<LabelDetail[]>(() => cachedLabels(page.projectId, page.branch));
  const [loaded, setLoaded] = useState(() => cachedLabels(page.projectId, page.branch).length > 0);
  const [setup, setSetup] = useState(() => documentSetup(page.projectId, page.branch, page.view()?.state ?? null));
  const [query, setQuery] = useState(req.query);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<LabelDetail[]>([]);
  const [group, setGroup] = useState<RefGroup | null>(null);
  const preferred = useMemo(() => chosenStyle(), []);
  const styles = useMemo(() => stylesFor(setup, preferred), [setup, preferred]);
  const [style, setStyle] = useState<RefStyle>(preferred);

  useEffect(() => {
    let live = true;
    void loadLabels(page.projectId, page.branch, true).then((l) => { if (live) { setLabels(l); setLoaded(true); } });
    void loadSetup(page.projectId, page.branch, true).then((s) => {
      const next = refSetupOf(s as unknown as Record<string, unknown> | null);
      if (live && next) setSetup(next);
    });
    return () => { live = false; };
  }, [page]);

  const rows = useMemo(() => rankLabels(labels, query, group), [labels, query, group]);
  useEffect(() => { if (active >= rows.length) setActive(0); }, [rows, active]);
  const groups = useMemo(() => GROUPS.filter((g) => labels.some((l) => groupOf(l) === g.id)), [labels]);

  const close = () => {
    closeRefPicker();
    page.view()?.focus();
  };

  const isChosen = (l: LabelDetail) => chosen.some((c) => c.label === l.label);
  const withRow = (i: number): LabelDetail[] => {
    const row = rows[i];
    if (!row || (chosen.length && !query.trim()) || isChosen(row)) return chosen;
    return [...chosen, row];
  };

  const submit = (i: number, shift: boolean) => {
    const picked = withRow(i);
    if (!picked.length) return;
    if (applyReference(page, picked, style, shift)) closeRefPicker();
  };

  const addRow = (i: number): boolean => {
    const row = rows[i];
    if (!row) return false;
    if (!isChosen(row)) setChosen([...chosen, row]);
    setQuery('');
    setActive(0);
    return true;
  };

  const previewLabels = withRow(active);
  const preview = previewLabels.length
    ? buildReference(previewLabels, { style, setup, sentenceStart: false })
    : '';

  const chips: PickerChip[] = chosen.map((l) => ({ id: l.label, label: l.label, title: l.title }));

  const pickerRows: PickerRow[] = rows.map((l) => ({
    id: l.label,
    testId: `ref-picker-row-${l.label}`,
    chosen: isChosen(l),
    content: (
      <>
        <div className={`picker__line${l.kind === 'equation' ? ' picker__key' : ''}`}>{l.title || l.label}</div>
        <div className="picker__sub">{l.label} · {l.file}{l.line ? `:${l.line}` : ''}</div>
      </>
    ),
    aside: (
      <>
        <span>{kindLabel(l)}</span>
        {l.duplicate && <span className="picker__badge" title="The project defines this label more than once">defined twice</span>}
      </>
    ),
  }));

  const empty = !loaded
    ? <span>Loading labels…</span>
    : labels.length === 0
      ? (
        <>
          <span>No labels in this project yet.</span>
          <button type="button" className="picker__link" data-testid="ref-picker-add-label" onClick={() => { closeRefPicker(); insertLabelHere(page); }}>
            Insert label here
          </button>
        </>
      )
      : <span>No labels match &ldquo;{query}&rdquo;.</span>;

  return (
    <PickerShell
      label="Insert cross-reference"
      note={setupNote(setup)}
      query={query}
      onQuery={(q) => { setQuery(q); setActive(0); }}
      placeholder="Search by caption, heading, label or file"
      rows={pickerRows}
      active={active}
      onActive={setActive}
      chips={chips}
      onRemoveChip={(id) => setChosen(chosen.filter((l) => l.label !== id))}
      onChoose={(i, o) => submit(i, o.shift)}
      onTab={addRow}
      onKey={(e) => {
        // The picker's own chord moves to the next form.
        if (matchesShortcut(e.nativeEvent, INSERT_BINDING)) {
          setStyle(styles[(styles.indexOf(style) + 1) % styles.length] ?? 'auto');
          return true;
        }
        return false;
      }}
      onClose={close}
      empty={empty}
      testId="ref-picker"
      footer={<span>↵ insert · ⇧↵ bare \ref · Tab add another · Esc close</span>}
    >
      {groups.length > 1 && (
        <div className="picker__section">
          <div className="picker__styles" role="group" aria-label="Kind">
            <button type="button" className="picker__style" aria-pressed={group === null} onMouseDown={(e) => e.preventDefault()} onClick={() => { setGroup(null); setActive(0); }} data-testid="ref-picker-group-all">
              All
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className="picker__style"
                aria-pressed={group === g.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setGroup(group === g.id ? null : g.id); setActive(0); }}
                data-testid={`ref-picker-group-${g.id}`}
              >
                {g.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="picker__section">
        <div className="picker__styles" role="group" aria-label="Form">
          {styles.map((s) => (
            <button
              key={s}
              type="button"
              className="picker__style"
              aria-pressed={style === s}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setStyle(s)}
              data-testid={`ref-style-${s}`}
            >
              {STYLE_LABELS[s]}
            </button>
          ))}
        </div>
        <span className="picker__preview" data-testid="ref-picker-preview">{preview}</span>
      </div>
    </PickerShell>
  );
}
