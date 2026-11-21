import { gunzipText } from './gunzip';
import { displayRect, parseSynctex, tagFor, type SynctexData } from './synctex';
import type { WorkerReply, WorkerRequest } from './loader';

/** Parses one typeset's SyncTeX file off the main thread and answers crop questions about it. */
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null; postMessage(m: WorkerReply): void };
let data: SynctexData | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  void (async () => {
    try {
      if (m.type === 'load') {
        data = parseSynctex(await gunzipText(m.bytes));
        scope.postMessage({ id: m.id, ok: true, rect: null });
      } else {
        if (!data) throw new Error('nothing loaded');
        const tag = tagFor(data.inputs, m.filePath, m.rootDir);
        const rect = tag === null ? null : displayRect(data, tag, m.first, m.last, { single: m.single, pad: m.pad });
        scope.postMessage({ id: m.id, ok: true, rect });
      }
    } catch (err) {
      scope.postMessage({ id: m.id, ok: false, rect: null, error: String((err as Error)?.message ?? err) });
    }
  })();
};
