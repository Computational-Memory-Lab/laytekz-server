/**
 * Libraries (F8): "3 citations changed key in Zotero: smith2020 → … · Update citations".
 * Shown in `editor.banners` after a sync this tab ran reported renamed keys.
 * Update citations rewrites the keys in the open .tex file as one edit (one
 * undo step) and lists the other .tex files that still cite an old key.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '../../api';
import type { SlotProps } from '../../slots/types';
import { countRenamed, providerLabel, renameCiteKeys, renameSummary, type KeyRename } from './model';
import { dismissNotice, noticeFor, storeVersion, subscribe } from './store';

const TEX = /\.(tex|ltx)$/i;
/** Projects with more .tex files than this are not scanned for other citations. */
const SCAN_LIMIT = 200;

export default function RenamedNotice({ page }: SlotProps) {
  useSyncExternalStore(subscribe, storeVersion);
  const notice = page ? noticeFor(page.projectId, page.branch) : null;
  const [others, setOthers] = useState<string[] | null>(null);
  const [active, setActive] = useState<string | null>(() => page?.activeFile() ?? null);

  useEffect(() => page?.events.on('activeFile', ({ path }) => setActive(path)), [page]);

  const scan = useCallback(async (renames: readonly KeyRename[], skip: string | null) => {
    if (!page) return;
    const tex = page.files().filter((f) => f.type === 'file' && TEX.test(f.path) && f.path !== skip).slice(0, SCAN_LIMIT);
    const hits: string[] = [];
    await Promise.all(tex.map(async (f) => {
      try {
        if (countRenamed(await api.readFile(page.projectId, page.branch, f.path), renames)) hits.push(f.path);
      } catch { /* unreadable: not listed */ }
    }));
    setOthers(hits.sort());
  }, [page]);

  const renames = notice?.renames;
  useEffect(() => {
    setOthers(null);
    if (renames?.length) void scan(renames, active);
  }, [renames, active, scan]);

  if (!page || !notice || !notice.renames.length) return null;
  const name = providerLabel(notice.provider);
  const n = notice.renames.length;
  const texOpen = !!active && TEX.test(active);

  const update = () => {
    if (!texOpen || !page.canEdit()) return;
    page.editDocument((text) => renameCiteKeys(text, notice.renames), (changed) => {
      page.toast(changed ? `Updated the citations in ${active}` : `${active} cites none of the old keys`, changed ? 'ok' : 'info');
      void scan(notice.renames, active);
    });
  };

  return (
    <div className="remote-pending" role="status" data-testid="libraries-renamed-notice" style={{ flexWrap: 'wrap' }}>
      <span className="remote-pending__text">
        {n === 1 ? '1 citation key' : `${n} citation keys`} changed in {name}: {renameSummary(notice.renames)}.
        {others && others.length > 0 && (
          <> Still cited in{' '}
            {others.slice(0, 4).map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <button type="button" className="link-button" onClick={() => page.openFile(p)} data-testid="libraries-renamed-file">{p}</button>
              </span>
            ))}
            {others.length > 4 && `, and ${others.length - 4} more`}.
          </>
        )}
      </span>
      {texOpen && page.canEdit() && (
        <button type="button" className="btn btn--small btn--primary" onClick={update} data-testid="libraries-renamed-update">Update citations</button>
      )}
      <button type="button" className="btn btn--small btn--ghost" onClick={() => dismissNotice(page.projectId, page.branch)} data-testid="libraries-renamed-dismiss">Dismiss</button>
    </div>
  );
}
