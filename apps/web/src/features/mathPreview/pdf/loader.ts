import { withBase } from '../../../basePath';
import { gunzipText } from './gunzip';
import { displayRect, parseSynctex, tagFor, type SynctexData, type SynctexRect } from './synctex';

/** The header naming the run a SyncTeX file belongs to (server: features/mathPreview/server.ts). */
export const SYNCTEX_RUN_HEADER = 'x-synctex-run';
export const SYNCTEX_PATH_HEADER = 'x-synctex-path';

type WorkerAsk =
  | { type: 'load'; bytes: ArrayBuffer }
  | { type: 'rect'; filePath: string; rootDir: string; first: number; last: number; single: boolean; pad: number };
export type WorkerRequest = WorkerAsk & { id: number };
export interface WorkerReply { id: number; ok: boolean; rect: SynctexRect | null; error?: string }

export interface RectQuery { filePath: string; first: number; last: number; single: boolean; pad: number }

/** One typeset's SyncTeX file, parsed. */
export interface LoadedSynctex {
  compileId: number;
  /** The root file's folder ('' at the top), which the inputs are relative to. */
  rootDir: string;
  rect(q: RectQuery): Promise<SynctexRect | null>;
  dispose(): void;
}

/** The root file's folder, from the SyncTeX file's path ("paper/.aldine-out/main.synctex.gz" → "paper"). */
export function rootDirOf(synctexPath: string): string | null {
  const m = /^(?:(.*)\/)?\.aldine-out\/[^/]+$/.exec(synctexPath);
  return m ? m[1] ?? '' : null;
}

/** The parse in this thread: where workers are missing (tests, old engines) or refused. */
async function inThread(compileId: number, rootDir: string, bytes: ArrayBuffer): Promise<LoadedSynctex> {
  const data: SynctexData = parseSynctex(await gunzipText(bytes));
  return {
    compileId,
    rootDir,
    rect: async (q) => {
      const tag = tagFor(data.inputs, q.filePath, rootDir);
      return tag === null ? null : displayRect(data, tag, q.first, q.last, { single: q.single, pad: q.pad });
    },
    dispose() {},
  };
}

function inWorker(compileId: number, rootDir: string, bytes: ArrayBuffer): Promise<LoadedSynctex> {
  const worker = new Worker(new URL('./synctex.worker.ts', import.meta.url), { type: 'module' });
  let seq = 0;
  const waiting = new Map<number, (r: WorkerReply) => void>();
  const ask = (m: WorkerAsk, transfer?: Transferable[]) => new Promise<WorkerReply>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    worker.postMessage({ ...m, id }, transfer ?? []);
  });
  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const done = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    done?.(e.data);
  };
  const fail = () => { for (const done of waiting.values()) done({ id: 0, ok: false, rect: null, error: 'worker failed' }); waiting.clear(); };
  worker.onerror = fail;
  return ask({ type: 'load', bytes }, [bytes]).then((r) => {
    if (!r.ok) { worker.terminate(); throw new Error(r.error ?? 'SyncTeX file not readable'); }
    return {
      compileId,
      rootDir,
      rect: async (q) => {
        const reply = await ask({ type: 'rect', rootDir, ...q });
        return reply.ok ? reply.rect : null;
      },
      dispose() { fail(); worker.terminate(); },
    };
  });
}

let current: { key: string; loaded: Promise<LoadedSynctex | null> } | null = null;

/**
 * The SyncTeX file of the typeset `compileId`, fetched on the first question
 * about it and parsed off the main thread. Null when the server's file is
 * another run's (the `x-synctex-run` header), missing, or unreadable; a
 * failure is not remembered, so a later preview asks again.
 */
export function loadSynctex(projectId: string, branch: string, compileId: number): Promise<LoadedSynctex | null> {
  const key = `${projectId}::${branch}::${compileId}`;
  if (current?.key === key) return current.loaded;
  const previous = current;
  void previous?.loaded.then((l) => l?.dispose());
  const loaded = (async (): Promise<LoadedSynctex | null> => {
    const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectId)}/output/synctex?branch=${encodeURIComponent(branch)}`), { cache: 'no-store' });
    if (!res.ok) return null;
    if (res.headers.get(SYNCTEX_RUN_HEADER) !== String(compileId)) return null;
    let path = '';
    try { path = decodeURIComponent(res.headers.get(SYNCTEX_PATH_HEADER) ?? ''); } catch { return null; }
    const rootDir = rootDirOf(path);
    if (rootDir === null) return null;
    const bytes = await res.arrayBuffer();
    if (typeof Worker === 'function') {
      try {
        return await inWorker(compileId, rootDir, bytes.slice(0));
      } catch { /* the worker could not start or parse: parse here instead */ }
    }
    return inThread(compileId, rootDir, bytes);
  })().catch(() => null);
  const entry = { key, loaded };
  current = entry;
  void loaded.then((l) => { if (!l && current === entry) current = null; });
  return loaded;
}

/** Forgets the loaded file (the page closed). */
export function disposeSynctex(): void {
  const c = current;
  current = null;
  void c?.loaded.then((l) => l?.dispose());
}
