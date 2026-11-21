/**
 * Where the suggestion model lives on this device (WP43): one entry in Cache
 * Storage, written while it downloads and checked against the manifest's
 * SHA-256 before anything uses it. A mismatch, a cancel or a failure leaves
 * nothing behind. Cache Storage is used rather than OPFS because it streams to
 * disk in every current browser, Safari included, without holding the 237 MB
 * file in memory.
 */
import type { ModelManifest } from './manifest';
import { Sha256 } from './sha256';

export const CACHE_NAME = 'laytekz-suggest-model';

export type ModelErrorKind = 'space' | 'blocked' | 'storage' | 'checksum';

/** A download problem, with the sentence the settings row shows. */
export class ModelError extends Error {
  constructor(readonly kind: ModelErrorKind, message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface StoreDeps {
  fetch: typeof fetch;
  caches: CacheStorage;
  storage?: Pick<StorageManager, 'estimate' | 'persist'>;
}

export function browserStoreDeps(): StoreDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    caches: globalThis.caches,
    storage: globalThis.navigator?.storage,
  };
}

const abortError = () => new DOMException('The download was cancelled.', 'AbortError');

export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

/** The stored model, or null when it is not on this device (never downloaded, removed, or evicted by the browser). */
export async function storedModel(m: ModelManifest, deps: StoreDeps): Promise<Blob | null> {
  try {
    const cache = await deps.caches.open(CACHE_NAME);
    const res = await cache.match(m.url);
    if (!res) return null;
    const blob = await res.blob();
    return blob.size === m.bytes ? blob : null;
  } catch {
    return null;
  }
}

/** Whether the model is on this device, without reading it. */
export async function hasModel(m: ModelManifest, deps: StoreDeps): Promise<boolean> {
  try {
    const cache = await deps.caches.open(CACHE_NAME);
    const res = await cache.match(m.url);
    if (!res) return false;
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) && len > 0 ? len === m.bytes : true;
  } catch {
    return false;
  }
}

/** Removes every stored copy. */
export async function removeModel(deps: StoreDeps): Promise<void> {
  try {
    await deps.caches.delete(CACHE_NAME);
  } catch {
    /* nothing stored, or storage refused: nothing to remove */
  }
}

export interface DownloadOptions {
  signal: AbortSignal;
  onProgress?(loaded: number, total: number): void;
}

/**
 * Downloads the model into Cache Storage, hashing it as it streams. Throws an
 * AbortError when cancelled and a ModelError with a plain reason otherwise;
 * in both cases nothing stays stored.
 */
export async function downloadModel(m: ModelManifest, o: DownloadOptions, deps: StoreDeps): Promise<void> {
  if (o.signal.aborted) throw abortError();
  try {
    const est = await deps.storage?.estimate?.();
    if (est && typeof est.quota === 'number' && typeof est.usage === 'number' && est.quota - est.usage < m.bytes * 1.1) {
      throw new ModelError('space', `There is not enough storage space for the model: it needs about ${Math.ceil((m.bytes * 1.1) / 1_000_000)} MB free.`);
    }
  } catch (err) {
    if (err instanceof ModelError) throw err;
  }
  try {
    await deps.storage?.persist?.();
  } catch {
    /* best effort: without it the browser may evict the model under pressure */
  }

  let res: Response;
  try {
    res = await deps.fetch(m.url, { signal: o.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch (err) {
    if (o.signal.aborted || isAbort(err)) throw abortError();
    throw new ModelError('blocked', 'The download was blocked or the connection failed (a network filter, a browser extension or the site’s security policy may be stopping it).');
  }
  if (!res.ok || !res.body) {
    throw new ModelError('blocked', `The model host refused the download (HTTP ${res.status}).`);
  }

  const hasher = new Sha256();
  let loaded = 0;
  const counted = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      hasher.update(chunk);
      loaded += chunk.byteLength;
      o.onProgress?.(loaded, m.bytes);
      ctl.enqueue(chunk);
    },
  }));

  let cache: Cache;
  try {
    cache = await deps.caches.open(CACHE_NAME);
  } catch {
    throw new ModelError('storage', 'This browser refused to store the model (site storage may be blocked or full).');
  }
  try {
    await cache.put(m.url, new Response(counted, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(m.bytes), 'x-laytekz-sha256': m.sha256 },
    }));
  } catch (err) {
    await cache.delete(m.url).catch(() => false);
    if (o.signal.aborted || isAbort(err)) throw abortError();
    throw new ModelError('storage', 'The download stopped before it finished, or this browser refused to store it. Try again.');
  }
  if (o.signal.aborted) {
    await cache.delete(m.url).catch(() => false);
    throw abortError();
  }
  if (loaded !== m.bytes || hasher.hex() !== m.sha256) {
    await cache.delete(m.url).catch(() => false);
    throw new ModelError('checksum', 'The downloaded file did not match its checksum, so it was deleted. Try again.');
  }
}
