import { useCallback, useEffect, useRef, useState } from 'react';
import { withBase } from '../../basePath';
import { IconChevronRight } from '../../components/Icons';
import Modal from '../../components/Modal';
import { useSetting } from '../../settings/store';
import { usePageEvents } from '../host';
import type { EditorPageCtx } from '../types';
import type { SlotProps } from '../../slots/types';
import { downloadForArxiv, keepGenerated, loadGenerated, saveLink } from './api';
import { describeFile, downloadNameFor, keepState, outputHref, VIEWABLE, type GeneratedFile, type GeneratedList } from './generated';
import { LIST_SETTING } from './ids';
import './outputs.css';

/** The open/closed state, remembered per project in this browser. */
const openKey = (projectId: string) => `aldine.outputs.generatedOpen.${projectId}`;
function readOpen(projectId: string): boolean {
  try { return localStorage.getItem(openKey(projectId)) === '1'; } catch { return false; }
}
function writeOpen(projectId: string, open: boolean): void {
  try { if (open) localStorage.setItem(openKey(projectId), '1'); else localStorage.removeItem(openKey(projectId)); } catch { /* private window */ }
}

type Load = { state: 'loading' | 'ok' | 'error'; list: GeneratedList | null; error?: string };

/**
 * F11 (WP34): the files the last typeset wrote, under the file tree
 * (`files.footer`). Each can be viewed (text files), downloaded, and, for
 * what a submission needs (.bbl, .ind, .gls, .nls, .acr), added to the
 * project after a confirmation. Off with the `outputs.generatedList` setting.
 */
export default function GeneratedFiles({ page }: SlotProps) {
  const [shown] = useSetting<boolean>(LIST_SETTING);
  if (!page || shown === false) return null;
  return <GeneratedSection page={page} />;
}

function GeneratedSection({ page }: { page: EditorPageCtx }) {
  usePageEvents(page, ['projectChanged']);
  const { projectId, branch } = page;
  const [open, setOpen] = useState(() => readOpen(projectId));
  const [load, setLoad] = useState<Load>({ state: 'loading', list: null });
  const [viewing, setViewing] = useState<GeneratedFile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++seq.current;
    setLoad((l) => ({ ...l, state: l.list ? l.state : 'loading' }));
    try {
      const list = await loadGenerated({ projectId, branch, pdfUrl: page.lastCompile()?.pdfUrl ?? null, rootFile: page.project()?.rootFile });
      if (n === seq.current) setLoad({ state: 'ok', list });
    } catch (err) {
      if (n === seq.current) setLoad((l) => ({ state: 'error', list: l.list, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [page, projectId, branch]);

  useEffect(() => {
    void refresh();
    return page.events.on('compileFinished', () => { void refresh(); });
  }, [page, refresh]);

  const toggle = () => { const next = !open; setOpen(next); writeOpen(projectId, next); };
  const list = load.list;
  const files = list?.files ?? [];
  const projectName = page.project()?.name;
  const canEdit = page.canEdit() && !page.showcase();
  const href = (f: GeneratedFile) => withBase(outputHref(projectId, branch, list?.dir ?? '.aldine-out', f.name));

  const keep = async (f: GeneratedFile, update: boolean) => {
    const ok = await page.confirm(update
      ? {
        title: `Update ${f.name} in the project?`,
        body: `The project's ${f.name} is replaced with the one the last typeset wrote. The change is committed, so collaborators, the ZIP and git sync get it.`,
        confirmLabel: `Update ${f.name}`,
      }
      : {
        title: `Add ${f.name} to the project?`,
        body: `It will be committed, so collaborators, the ZIP and git sync get it. It does not update itself: after changing your .bib, typeset and choose Update.`,
        confirmLabel: `Add ${f.name}`,
      });
    if (!ok) return;
    setBusy(f.name);
    try {
      const r = await keepGenerated(projectId, branch, f.name);
      const where = r?.path ?? f.name;
      page.toast(r?.unchanged ? `${where} in the project is already the same as the last typeset's`
        : `${update ? 'Updated' : 'Added'} ${where}${update ? ' in' : ' to'} the project${r?.gitignore ? `, and ${r.gitignore} now lets it in` : ''}`, 'ok');
      await page.refreshFiles();
      await refresh();
    } catch (err) {
      page.toast(`Could not ${update ? 'update' : 'add'} ${f.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const arxiv = () => { void downloadForArxiv({ projectId, branch, projectName, toast: page.toast, confirm: page.confirm, page }); };

  return (
    <section className="genfiles" aria-label="Generated files" data-testid="generated-files">
      <button type="button" className="genfiles__head" onClick={toggle} aria-expanded={open} data-testid="generated-files-toggle"
        title="The files the last typeset wrote: the bibliography, the log, the index">
        <span className={`genfiles__chev${open ? ' genfiles__chev--open' : ''}`} aria-hidden="true"><IconChevronRight /></span>
        <span className="genfiles__title">Generated by the last typeset</span>
        <span className="genfiles__count" data-testid="generated-files-count">{list ? files.length : '…'}</span>
      </button>
      {open && (
        <div className="genfiles__body">
          {load.state === 'error' && !list && (
            <p className="genfiles__empty" data-testid="generated-files-error">
              Could not list the generated files. <button type="button" className="genfiles__link" onClick={() => void refresh()}>Try again</button>
            </p>
          )}
          {list && files.length === 0 && (
            <p className="genfiles__empty" data-testid="generated-files-empty">Nothing yet: typeset to build the PDF and the files it needs.</p>
          )}
          {files.length > 0 && (
            <ul className="genfiles__list" role="list">
              {files.map((f) => {
                const k = list ? keepState(f, list, canEdit) : null;
                const meta = describeFile(f);
                return (
                  <li key={f.name} className={`genfiles__row${f.fromLastRun === false ? ' genfiles__row--old' : ''}`} data-testid="generated-file" data-name={f.name}>
                    <span className="genfiles__name" title={f.name}>{f.name}</span>
                    <span className="genfiles__line">
                      {meta && <span className="genfiles__meta" data-testid="generated-file-meta">{meta}</span>}
                      <span className="genfiles__actions">
                        {VIEWABLE.test(f.name) && (
                          <button type="button" className="genfiles__link" onClick={() => setViewing(f)} aria-label={`View ${f.name}`} data-testid="generated-file-view">View</button>
                        )}
                        <a className="genfiles__link" href={href(f)} download={downloadNameFor(f, projectName)} aria-label={`Download ${f.name}`} data-testid="generated-file-download">Download</a>
                        {k === 'add' && (
                          <button type="button" className="genfiles__link" disabled={busy === f.name} onClick={() => void keep(f, false)}
                            title="Copy it into the project's files, after you confirm" data-testid="generated-file-add">Add to project…</button>
                        )}
                        {k === 'update' && (
                          <button type="button" className="genfiles__link genfiles__link--warn" disabled={busy === f.name} onClick={() => void keep(f, true)}
                            title="The project's copy differs from the last typeset's" data-testid="generated-file-update">Update…</button>
                        )}
                        {k === 'same' && <span className="genfiles__badge" data-testid="generated-file-tracked">In project</span>}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="genfiles__arxiv" onClick={arxiv} data-testid="generated-files-arxiv"
            title="A ZIP arXiv accepts: the source with the .bbl, without hidden files">Download for arXiv (ZIP)</button>
        </div>
      )}
      {viewing && (
        <FileViewer file={viewing} href={href(viewing)} downloadAs={downloadNameFor(viewing, projectName)} onClose={() => setViewing(null)} />
      )}
    </section>
  );
}

/** A generated text file, read-only. */
function FileViewer({ file, href, downloadAs, onClose }: { file: GeneratedFile; href: string; downloadAs: string; onClose(): void }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(href)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => { if (live) setText(t); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [href]);
  return (
    <Modal onClose={onClose} label={file.name} wide testId="generated-file-viewer">
      <div>
        <h2>{file.name}</h2>
        <p className="modal__sub">Written by {file.fromLastRun === false ? 'an earlier' : 'the last'} typeset. It is rebuilt each time, so changes belong in the source.</p>
        {failed
          ? <p data-testid="generated-file-viewer-error">Could not open {file.name}. Typeset again, then try once more.</p>
          : <pre className="logview genfiles__pre" data-testid="generated-file-text">{text ?? 'Loading…'}</pre>}
        <div className="modal__row">
          <button type="button" className="btn" onClick={() => saveLink(href, downloadAs)} data-testid="generated-file-viewer-download">Download</button>
          <button type="button" className="btn btn--primary" onClick={onClose} data-testid="generated-file-viewer-close">Close</button>
        </div>
      </div>
    </Modal>
  );
}
