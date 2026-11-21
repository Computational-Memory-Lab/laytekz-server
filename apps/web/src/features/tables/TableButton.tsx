import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SlotProps } from '../../slots/types';
import type { EditorPageCtx } from '../types';
import { useSetting } from '../../settings/store';
import { useChordLabel } from '../../keys/registry';
import { api } from '../../api';
import { openMenu } from '../../components/Menu';
import type { MenuEntry } from '../../components/Menu';
import { usePopover } from '../../util/usePopover';
import { safeStorage } from '../../util/safeStorage';
import { TABLE_OPS } from '../../editor/visual/tableEdit';
import { ALIGN_MESSAGES, alignTableCommand, runTableOp, tableOpProblem } from '../../editor/tables/commands';
import { tableAt } from '../../editor/tables/locate';
import { insertContext } from './actions';
import type { InsertContext } from './actions';
import { PICKER_EVENT, alignOptions, editorMode, insertForPage } from './bus';
import { FIRST_SIZE, START, clampSize, keyStep, maxCols, shownFor, sizeLabel, sizeWords } from './picker';
import type { Shown, Size } from './picker';
import { loadsBooktabs } from './plan';
import { TABLES_SETTING_IDS as ids } from './settings';
import type { ColumnAlign, LinesChoice } from './settings';
import './tables.css';

const LAST_SIZE = 'aldine.tables.lastSize';
const isSize = (v: unknown): v is Size => !!v && typeof (v as Size).cols === 'number' && typeof (v as Size).rows === 'number';

/** Whether the main file's preamble loads booktabs, read when the picker opens and kept for 30 s. */
const rootCache = new Map<string, { at: number; value: boolean }>();
async function rootBooktabs(page: EditorPageCtx): Promise<boolean | null> {
  const root = page.project()?.rootFile;
  if (!root || root === page.activeFile()) return null;
  const key = `${page.projectId}\n${page.branch}\n${root}`;
  const hit = rootCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  try {
    const value = loadsBooktabs(await api.readFile(page.projectId, page.branch, root));
    rootCache.set(key, { at: Date.now(), value });
    return value;
  } catch { return null; }
}

function IconTable() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M2 9.8h12M6 3v10M10 3v10" />
    </svg>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, testId }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void; testId: string;
}) {
  return (
    <div className="tables-picker__row" role="radiogroup" aria-label={label} data-testid={testId}>
      <span className="tables-picker__rowlabel">{label}</span>
      <span className="tables-picker__seg">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
            className={`tables-picker__segbtn${value === o.value ? ' is-on' : ''}`}
            onClick={() => onChange(o.value)} data-testid={`${testId}-${o.value}`}>{o.label}</button>
        ))}
      </span>
    </div>
  );
}

/** The editor header's table button (editor.tools, order 100): a grid picker, its options, and the tools for the table at the cursor. */
export default function TableButton({ page }: SlotProps) {
  const [shownSetting] = useSetting<boolean>(ids.button);
  const [float, setFloat] = useSetting<boolean>(ids.insertFloat);
  const [header, setHeader] = useSetting<boolean>(ids.insertHeader);
  const [lines, setLines] = useSetting<LinesChoice>(ids.insertLines);
  const [align, setAlign] = useSetting<ColumnAlign>(ids.insertAlign);
  const alignChord = useChordLabel('tables.align');
  const pop = usePopover();
  const phone = !!page?.ui.phone();
  const [size, setSize] = useState<Size>(() => clampSize(safeStorage.getJSON(LAST_SIZE, FIRST_SIZE, isSize), phone));
  const [shown, setShown] = useState<Shown>(() => shownFor(size, { cols: START, rows: START }, phone));
  const [ctx, setCtx] = useState<InsertContext | null>(null);
  const [rootLoads, setRootLoads] = useState<boolean | null>(null);
  const [inTable, setInTable] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const rowsBtn = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(() => {
    const view = page?.view();
    if (!view) { setCtx(null); setInTable(false); return; }
    setCtx(insertContext(view.state, rootLoads));
    try { setInTable(!!tableAt(view.state, view.state.selection.main.head)); } catch { setInTable(false); }
  }, [page, rootLoads]);

  const open = useCallback(() => {
    if (!page) return;
    const start = clampSize(safeStorage.getJSON(LAST_SIZE, FIRST_SIZE, isSize), phone);
    setSize(start);
    setShown(shownFor(start, { cols: START, rows: START }, phone));
    pop.setOpen(true);
    void rootBooktabs(page).then(setRootLoads);
  }, [page, phone, pop]);

  useEffect(() => { if (pop.open) refresh(); }, [pop.open, refresh]);
  useEffect(() => { if (pop.open) gridRef.current?.focus({ preventScroll: true }); }, [pop.open]);

  // the palette's "Insert table…"
  useEffect(() => {
    if (shownSetting === false) return;
    const onAsk = (e: Event) => { e.preventDefault(); open(); };
    window.addEventListener(PICKER_EVENT, onAsk);
    return () => window.removeEventListener(PICKER_EVENT, onAsk);
  }, [open, shownSetting]);

  if (!page || shownSetting === false) return null;

  const refusal = ctx?.refusal ?? null;
  const floatOff = ctx?.floatRefusal ?? null;
  const shownLines: Exclude<LinesChoice, 'auto'> = (lines ?? 'auto') === 'auto' ? (ctx?.autoLines ?? 'hline') : (lines as Exclude<LinesChoice, 'auto'>);

  const insert = (s: Size) => {
    if (refusal) return;
    safeStorage.setJSON(LAST_SIZE, s);
    // closed without handing focus back to the button: the editor (or the new grid's cell) takes it
    pop.setOpen(false);
    insertForPage(page, s, { float: float !== false, header: header !== false, lines: lines ?? 'auto', align: align ?? 'l', rootLoadsBooktabs: rootLoads, mode: editorMode() });
  };

  const hover = (s: Size) => {
    const next = clampSize(s, phone);
    setSize(next);
    setShown((sh) => shownFor(next, sh, phone));
  };

  const onGridKey = (e: ReactKeyboardEvent) => {
    const step = keyStep(size, e.key, phone);
    if (!step) return;
    e.preventDefault();
    if (step === 'insert') insert(size);
    else hover(step);
  };

  const alignHere = () => {
    const view = page.view();
    pop.setOpen(false);
    if (!view) return;
    view.focus();
    const outcome = alignTableCommand(view, alignOptions());
    if (outcome !== 'aligned') page.toast(ALIGN_MESSAGES[outcome], 'info');
  };

  const rowsMenu = () => {
    const view = page.view();
    const el = rowsBtn.current;
    if (!view || !el) return;
    const item = (o: (typeof TABLE_OPS)[number]): MenuEntry => {
      const problem = tableOpProblem(view, o.op);
      return {
        id: o.op, label: o.label, disabled: !!problem, testId: `tables-op-${o.op}`,
        onSelect: () => { pop.setOpen(false); view.focus(); if (!runTableOp(view, o.op) && problem) page.toast(problem, 'info'); },
      };
    };
    const items: MenuEntry[] = [];
    for (const group of ['insert', 'merge', 'move', 'delete'] as const) {
      if (items.length) items.push({ kind: 'separator' });
      items.push(...TABLE_OPS.filter((o) => o.group === group).map(item));
      if (group === 'move') {
        items.push({ kind: 'submenu', id: 'align', label: 'Column alignment', testId: 'tables-op-align', items: TABLE_OPS.filter((o) => o.group === 'align').map(item) });
      }
    }
    const r = el.getBoundingClientRect();
    openMenu({ items, anchor: { type: 'rect', rect: { top: r.top, right: r.right, bottom: r.bottom, left: r.left }, placement: 'bottom-end' }, label: 'Rows and columns', testId: 'tables-ops-menu', returnFocus: el });
  };

  const cells = [];
  for (let r = 0; r < shown.rows; r++) {
    for (let c = 0; c < shown.cols; c++) {
      const on = c < size.cols && r < size.rows;
      cells.push(
        <span key={`${r}-${c}`} className={`tables-picker__cell${on ? ' is-on' : ''}`} data-testid={`tables-picker-cell-${c + 1}-${r + 1}`}
          onPointerEnter={phone ? undefined : () => hover({ cols: c + 1, rows: r + 1 })}
          onClick={() => (phone ? hover({ cols: c + 1, rows: r + 1 }) : insert({ cols: c + 1, rows: r + 1 }))} />,
      );
    }
  }

  return (
    <span ref={pop.ref} className="tables-tool">
      <button
        ref={pop.trigger}
        type="button"
        className="btn btn--ghost btn--small tables-tool__btn"
        title="Insert a table"
        aria-label="Insert a table"
        aria-expanded={pop.open}
        aria-haspopup="dialog"
        onClick={() => (pop.open ? pop.close() : open())}
        data-testid="tables-button"
      >
        <IconTable />
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      {pop.open && (
        <div className={`tables-picker${phone ? ' tables-picker--sheet' : ''}`} role="dialog" aria-label="Insert a table" data-testid="tables-picker">
          <div
            ref={gridRef}
            className={`tables-picker__grid${refusal ? ' is-disabled' : ''}`}
            role="grid"
            aria-label="Table size"
            aria-disabled={refusal ? true : undefined}
            title={refusal ?? undefined}
            tabIndex={0}
            onKeyDown={onGridKey}
            style={{ gridTemplateColumns: `repeat(${shown.cols}, var(--tables-cell))` }}
            data-testid="tables-picker-grid"
          >
            {cells}
          </div>
          <div className="tables-picker__size" aria-live="polite">
            <strong data-testid="tables-picker-size">{sizeLabel(size)}</strong>
            <span className="tables-picker__words">{sizeWords(size)}</span>
          </div>
          {refusal && <p className="tables-picker__note" data-testid="tables-picker-refusal">{refusal}</p>}
          {phone && (
            <button type="button" className="btn btn--primary tables-picker__insert" disabled={!!refusal} onClick={() => insert(size)} data-testid="tables-picker-insert">
              Insert {sizeLabel(size)} table
            </button>
          )}
          <div className="tables-picker__options">
            <label className="tables-picker__check" title={floatOff ?? undefined}>
              <input type="checkbox" checked={float !== false && !floatOff} disabled={!!floatOff} onChange={(e) => setFloat(e.target.checked)} data-testid="tables-option-float" />
              Caption and label (table float)
            </label>
            <label className="tables-picker__check">
              <input type="checkbox" checked={header !== false} onChange={(e) => setHeader(e.target.checked)} data-testid="tables-option-header" />
              Header row
            </label>
            <Segmented<Exclude<LinesChoice, 'auto'>> label="Lines" value={shownLines} testId="tables-option-lines"
              options={[{ value: 'booktabs', label: 'Booktabs' }, { value: 'hline', label: '\\hline' }, { value: 'none', label: 'None' }]}
              onChange={(v) => setLines(v)} />
            <Segmented<ColumnAlign> label="Columns" value={align ?? 'l'} testId="tables-option-align"
              options={[{ value: 'l', label: 'Left' }, { value: 'c', label: 'Centered' }, { value: 'r', label: 'Right' }]}
              onChange={(v) => setAlign(v)} />
          </div>
          {inTable && (
            <div className="tables-picker__here" data-testid="tables-picker-here">
              <span className="tables-picker__rowlabel">Table at the cursor</span>
              <button type="button" className="menu__item" onClick={alignHere} data-testid="tables-align-here">
                Align columns{alignChord ? <span className="tables-picker__kbd">{alignChord}</span> : null}
              </button>
              <button ref={rowsBtn} type="button" className="menu__item" onClick={rowsMenu} aria-haspopup="menu" data-testid="tables-rows-columns">
                Rows and columns <span aria-hidden="true">▸</span>
              </button>
            </div>
          )}
          {!phone && <p className="tables-picker__hint">Up to {maxCols(phone)} columns and 20 rows.</p>}
        </div>
      )}
    </span>
  );
}
