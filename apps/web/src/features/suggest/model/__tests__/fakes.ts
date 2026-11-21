/** In-memory Cache Storage and a fake model host for the WP43 tests. */
import { createHash } from 'node:crypto';
import type { ModelManifest } from '../manifest';
import { MODEL } from '../manifest';
import type { StoreDeps } from '../store';

export class MemoryCaches {
  readonly stores = new Map<string, Map<string, { body: Uint8Array; headers: [string, string][] }>>();
  failPut = false;

  async open(name: string): Promise<Cache> {
    let store = this.stores.get(name);
    if (!store) this.stores.set(name, (store = new Map()));
    const s = store;
    const self = this;
    return {
      async put(key: RequestInfo | URL, res: Response) {
        const body = new Uint8Array(await res.arrayBuffer());
        if (self.failPut) throw new DOMException('quota', 'QuotaExceededError');
        s.set(String(key), { body, headers: [...res.headers.entries()] });
      },
      async match(key: RequestInfo | URL) {
        const hit = s.get(String(key));
        return hit ? new Response(hit.body.slice(), { headers: hit.headers }) : undefined;
      },
      async delete(key: RequestInfo | URL) {
        return s.delete(String(key));
      },
    } as unknown as Cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async match(): Promise<Response | undefined> {
    return undefined;
  }
}

/** A small stand-in model whose manifest matches its bytes. */
export function tinyModel(bytes = 50_000): { manifest: ModelManifest; data: Uint8Array } {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 31 + 7) & 0xff;
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { manifest: { ...MODEL, url: 'https://huggingface.co/test/resolve/abc/tiny.gguf', bytes, sha256 }, data };
}

/** A body streamed in chunks; it errors when `signal` aborts, as fetch's does. */
export function streamOf(data: Uint8Array, chunk = 4096, signal?: AbortSignal, pauseAt?: { at: number; wait: Promise<void> }): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (signal?.aborted) {
        ctl.error(new DOMException('aborted', 'AbortError'));
        return;
      }
      if (pauseAt && at >= pauseAt.at) {
        await pauseAt.wait;
        if (signal?.aborted) {
          ctl.error(new DOMException('aborted', 'AbortError'));
          return;
        }
      }
      if (at >= data.length) {
        ctl.close();
        return;
      }
      ctl.enqueue(data.slice(at, at + chunk));
      at += chunk;
    },
  });
}

export interface FakeHost {
  deps: StoreDeps & { caches: MemoryCaches };
  calls: { url: string; init?: RequestInit }[];
}

export function fakeHost(data: Uint8Array, o: { status?: number; throws?: boolean; quota?: number; usage?: number; pauseAt?: { at: number; wait: Promise<void> } } = {}): FakeHost {
  const caches = new MemoryCaches();
  const calls: FakeHost['calls'] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (o.throws) throw new TypeError('Failed to fetch');
    if (o.status && o.status !== 200) return new Response('no', { status: o.status });
    return new Response(streamOf(data, 4096, init?.signal ?? undefined, o.pauseAt), { status: 200 });
  }) as typeof fetch;
  const storage = {
    estimate: async () => ({ quota: o.quota ?? 10_000_000_000, usage: o.usage ?? 0 }),
    persist: async () => true,
  };
  return { deps: { fetch: fetchFn, caches: caches as unknown as CacheStorage & MemoryCaches, storage } as FakeHost['deps'], calls };
}
