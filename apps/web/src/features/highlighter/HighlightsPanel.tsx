/**
 * The Highlights list (WP37, a `sidebar.panels` tab): this file's
 * highlights live from the editor, or the whole project's from the server;
 * filters by colour and "Only mine"; ↑/↓ step through them.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SlotProps } from '../../slots/types';
import { IconChevronDown, IconChevronUp, IconRefresh } from '../../components/Icons';
import { useSetting } from '../../settings/store';
import { colorName, drawnColor, isPreset } from './model';
import { hlConfig } from './extension';
import { ago, hlVersion, removeRun, selectRun, visibleRuns } from './actions';
import { fetchProjectHighlights, type ProjectHighlights } from './api';
import { swatchIcon } from './menuItems';
import './ui.css';

/** Rows drawn at most; the rest are counted. */
export const LIST_MAX = 1000;

export interface ListRow {
  key: string;
  path: string;
  color: string;
  from: number;
  to: number;
  line: number;
  excerpt: string;
  name: string;
  authorId: string;
  t: number;
}

/** Rows after the filters, and the colour counts before the colour filter. */
export function filterRows(rows: readonly ListRow[], o: { me: string | null; onlyMine: boolean; showOthers: boolean; color: string | null }) {
  const byAuthor = rows.filter((r) => (!o.onlyMine && o.showOthers) || (o.me !== null && r.authorId === o.me));
  const counts = new Map<string, number>();
  for (const r of byAuthor) {
    const c = drawnColor(r.color);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const shown = o.color ? byAuthor.filter((r) => drawnColor(r.color) === o.color) : byAuthor;
  return { shown, counts };
}

export default function HighlightsPanel({ page }: SlotProps) {
  useSyncExternalStore(hlVersion.subscribe, hlVersion.get, hlVersion.get);
  const [showOthersRaw] = useSetting<boolean>('highlighter.showOthers');
  const showOthers = showOthersRaw !== false;
  const [scope, setScope] = useState<'file' | 'project'>('file');
  const [onlyMine, setOnlyMine] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [project, setProject] = useState<{ data: ProjectHighlights | null; loading: boolean; error: string | null }>({ data: null, loading: false, error: null });
  const [cursor, setCursor] = useState(-1);

  const view = page?.view() ?? null;
  const cfg = view?.state.facet(hlConfig) ?? null;
  const activeFile = page?.activeFile() ?? null;
  const user = page?.user();
  const me = cfg ? cfg.me().id : user ? `acct:${user.id}` : null;

  const load = useCallback(() => {
    if (!page) return;
    setProject((p) => ({ ...p, loading: true, error: null }));
    fetchProjectHighlights(page.projectId, page.branch)
      .then((data) => setProject({ data, loading: false, error: null }))
      .catch((err: unknown) => setProject({ data: null, loading: false, error: err instanceof Error ? err.message : 'The list did not load.' }));
  }, [page?.projectId, page?.branch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (scope === 'project') load(); }, [scope, load]);

  const fileRows: ListRow[] = useMemo(() => {
    if (!view || !cfg || !activeFile) return [];
    const doc = view.state.doc;
    return visibleRuns(view.state)
      .filter((r) => r.from < doc.length)
      .sort((a, b) => a.from - b.from || a.to - b.to)
      .map((r) => ({
        key: r.key, path: activeFile, color: r.color, from: r.from, to: Math.min(r.to, doc.length), line: doc.lineAt(r.from).number,
        excerpt: doc.sliceString(r.from, Math.min(r.to, r.from + 80)).replace(/\s+/g, ' '), name: r.name, authorId: r.author, t: r.t,
      }));
    // hlVersion changes whenever the highlights or the selection do
  }, [view, cfg, activeFile, hlVersion.get()]); // eslint-disable-line react-hooks/exhaustive-deps

  const projectRows: ListRow[] = useMemo(() => (project.data?.files ?? []).flatMap((f) => f.highlights.map((h) => ({
    key: h.id, path: f.path, color: h.colour, from: h.from, to: h.to, line: h.line, excerpt: h.excerpt.replace(/\s+/g, ' '),
    name: h.author, authorId: h.authorId, t: h.t,
  }))), [project.data]);

  const rows = scope === 'file' ? fileRows : projectRows;
  const { shown, counts } = filterRows(rows, { me, onlyMine, showOthers, color });
  const visible = shown.slice(0, LIST_MAX);

  const open = (r: ListRow) => {
    if (!page) return;
    if (view && r.path === activeFile) selectRun(view, r);
    else page.openFile(r.path, { pos: r.from });
  };
  const step = (dir: 1 | -1) => {
    if (!visible.length) return;
    let i: number;
    if (scope === 'file' && view) {
      const at = view.state.selection.main.from;
      if (dir === 1) i = visible.findIndex((r) => r.from > at);
      else i = visible.map((r) => r.from < at).lastIndexOf(true);
      if (i < 0) i = dir === 1 ? 0 : visible.length - 1;
    } else {
      i = cursor < 0 ? (dir === 1 ? 0 : visible.length - 1) : (cursor + dir + visible.length) % visible.length;
    }
    setCursor(i);
    open(visible[i]);
  };

  return (
    <div className="hl-panel" data-testid="highlights-panel">
      <div className="hl-panel__head">
        <div className="hl-seg hl-panel__scope" role="group" aria-label="Which highlights">
          <button type="button" className={`hl-seg__btn ${scope === 'file' ? 'is-active' : ''}`} aria-pressed={scope === 'file'} onClick={() => setScope('file')} data-testid="highlights-scope-file">This file</button>
          <button type="button" className={`hl-seg__btn ${scope === 'project' ? 'is-active' : ''}`} aria-pressed={scope === 'project'} onClick={() => setScope('project')} data-testid="highlights-scope-project">Project</button>
        </div>
        <span className="hl-panel__spacer" />
        <button type="button" className="btn btn--ghost btn--small" title="Previous highlight" aria-label="Previous highlight" onClick={() => step(-1)} disabled={!visible.length} data-testid="highlights-prev"><IconChevronUp /></button>
        <button type="button" className="btn btn--ghost btn--small" title="Next highlight" aria-label="Next highlight" onClick={() => step(1)} disabled={!visible.length} data-testid="highlights-next"><IconChevronDown /></button>
        {scope === 'project' && (
          <button type="button" className="btn btn--ghost btn--small" title="Refresh" aria-label="Refresh" onClick={load} disabled={project.loading} data-testid="highlights-refresh"><IconRefresh /></button>
        )}
      </div>
      <div className="hl-panel__filters">
        {[...counts.entries()].map(([c, n]) => (
          <button
            key={c}
            type="button"
            className={`hl-chip ${color === c ? 'is-active' : ''}`}
            aria-pressed={color === c}
            onClick={() => setColor(color === c ? null : c)}
            data-testid={`highlights-filter-${isPreset(c) ? c : c.slice(1)}`}
          >
            {swatchIcon(c)} {colorName(c)} <span className="hl-chip__n">{n}</span>
          </button>
        ))}
        <label className="hl-panel__mine">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} data-testid="highlights-only-mine" /> Only mine
        </label>
      </div>
      {scope === 'project' && project.loading && <p className="hl-panel__note">Loading…</p>}
      {scope === 'project' && project.error && <p className="hl-panel__note hl-panel__note--error" data-testid="highlights-error">{project.error}</p>}
      {scope === 'file' && !activeFile && <p className="hl-panel__note">Open a file to see its highlights.</p>}
      {!visible.length && !(scope === 'project' && project.loading) && (scope === 'project' || activeFile) && (
        <p className="hl-panel__note" data-testid="highlights-empty">
          {rows.length ? 'No highlights match these filters.' : `No highlights in ${scope === 'file' ? 'this file' : 'this project'} yet. Select some text and use the highlighter button. Highlights are not part of the LaTeX, the PDF, the ZIP download or the history.`}
        </p>
      )}
      <ul className="hl-panel__list" data-testid="highlights-list">
        {visible.map((r, i) => (
          <li key={`${r.path}\n${r.key}`} className={`hl-row ${i === cursor ? 'is-current' : ''}`} data-testid="highlights-row" data-hl={r.key} data-hl-color={drawnColor(r.color)}>
            <button type="button" className="hl-row__main" onClick={() => { setCursor(i); open(r); }} title={`${colorName(r.color)} highlight${r.name ? ` by ${r.name}` : ''}`}>
              <span className="hl-row__top">
                {swatchIcon(drawnColor(r.color))}
                <span className="hl-row__where">{scope === 'project' ? `${r.path}:${r.line}` : `Line ${r.line}`}</span>
                <span className="hl-row__meta">{[r.name || null, ago(r.t)].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="hl-row__text">{r.excerpt}</span>
            </button>
            {scope === 'file' && view && cfg?.canWrite() && (
              <button type="button" className="hl-row__remove" aria-label="Remove this highlight" title="Remove" onClick={() => removeRun(view, r)} data-testid="highlights-row-remove">×</button>
            )}
          </li>
        ))}
      </ul>
      {shown.length > LIST_MAX && <p className="hl-panel__note">Showing the first {LIST_MAX.toLocaleString('en')} of {shown.length.toLocaleString('en')}.</p>}
      {scope === 'project' && project.data?.truncated && <p className="hl-panel__note">The project has more highlights than the list can hold.</p>}
    </div>
  );
}
