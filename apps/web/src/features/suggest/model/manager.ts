/**
 * The suggestion model's life on this device (WP43): whether the browser can
 * run it, the one-time download (progress, cancel, checksum), removal, and
 * the runtime in this tab. Only one tab holds the runtime at a time (a Web
 * Lock); it is loaded on the first suggestion that needs it and unloaded
 * after 10 minutes without use or 2 minutes hidden. Nothing is downloaded
 * except through `download()`, which only the settings row calls.
 */
import { MODEL, type ModelManifest } from './manifest';
import { readSupportEnv, supportProblem, type SupportEnv } from './support';
import { browserStoreDeps, downloadModel, hasModel, isAbort, ModelError, removeModel, storedModel, type StoreDeps } from './store';
import { createEngine, type CompletionEngine, type EngineDeps } from './engine';

export type ModelStatus =
  | { kind: 'checking' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'absent' }
  | { kind: 'downloading'; loaded: number; total: number }
  | { kind: 'installed' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; during: 'download' | 'load' };

export const IDLE_UNLOAD_MS = 10 * 60_000;
export const HIDDEN_UNLOAD_MS = 2 * 60_000;
export const LOCK_NAME = 'laytekz-suggest-model';

export interface ManagerDeps {
  manifest?: ModelManifest;
  env?(): SupportEnv;
  store?(): StoreDeps;
  engine?: EngineDeps;
  /** Holds the one-tab lock until the returned release runs; null when another tab has it. */
  lock?(): Promise<(() => void) | null>;
  /** Called with a listener for visibility changes; returns the removal. */
  onVisibility?(fn: (visible: boolean) => void): () => void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

function browserLock(): Promise<(() => void) | null> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      return new Promise<void>((release) => resolve(() => release()));
    }).catch(() => resolve(() => {}));
  });
}

function browserVisibility(fn: (visible: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const on = () => fn(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', on);
  return () => document.removeEventListener('visibilitychange', on);
}

export class ModelManager {
  private state: ModelStatus = { kind: 'checking' };
  private readonly listeners = new Set<() => void>();
  private readonly m: ModelManifest;
  private checked: Promise<void> | null = null;
  private download$: AbortController | null = null;
  private engine$: Promise<CompletionEngine | null> | null = null;
  private engine: CompletionEngine | null = null;
  private release: (() => void) | null = null;
  private idle: unknown = null;
  private hidden: unknown = null;
  private stopVisibility: (() => void) | null = null;
  private loadFailed = false;

  constructor(private readonly deps: ManagerDeps = {}) {
    this.m = deps.manifest ?? MODEL;
  }

  get manifest(): ModelManifest {
    return this.m;
  }

  status = (): ModelStatus => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(s: ModelStatus) {
    this.state = s;
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* a listener's problem is its own */ }
    }
  }

  private storeDeps(): StoreDeps {
    return (this.deps.store ?? browserStoreDeps)();
  }

  /** Why this browser cannot run the model, or null. */
  problem(): string | null {
    try {
      return supportProblem((this.deps.env ?? readSupportEnv)());
    } catch {
      return 'This browser cannot run the model.';
    }
  }

  /** Checks support and whether the model is stored (again). */
  refresh(): Promise<void> {
    const run = (async () => {
      const busy = this.state.kind === 'downloading' || this.state.kind === 'loading' || this.state.kind === 'ready';
      if (busy) return;
      const reason = this.problem();
      if (reason) {
        this.set({ kind: 'unsupported', reason });
        return;
      }
      const stored = await hasModel(this.m, this.storeDeps());
      if (this.state.kind === 'downloading' || this.state.kind === 'loading' || this.state.kind === 'ready') return;
      if (this.state.kind === 'error' && (!stored || this.state.during === 'load')) return; // keep the reason on screen
      this.set(stored ? { kind: 'installed' } : { kind: 'absent' });
    })();
    this.checked = run;
    return run;
  }

  /**
   * Downloads and checks the model. Resolves true once it is stored, false
   * when cancelled or failed (the status then says why).
   */
  async download(): Promise<boolean> {
    if (this.state.kind === 'downloading') return false;
    const reason = this.problem();
    if (reason) {
      this.set({ kind: 'unsupported', reason });
      return false;
    }
    const abort = (this.download$ = new AbortController());
    this.loadFailed = false;
    this.set({ kind: 'downloading', loaded: 0, total: this.m.bytes });
    let last = 0;
    try {
      await downloadModel(this.m, {
        signal: abort.signal,
        onProgress: (loaded, total) => {
          // Re-render at most every ~1 MB.
          if (loaded - last < 1_000_000 && loaded < total) return;
          last = loaded;
          if (this.download$ === abort) this.set({ kind: 'downloading', loaded, total });
        },
      }, this.storeDeps());
      if (this.download$ !== abort) return false;
      this.download$ = null;
      this.set({ kind: 'installed' });
      return true;
    } catch (err) {
      if (this.download$ === abort) this.download$ = null;
      if (isAbort(err) || abort.signal.aborted) {
        if (this.status().kind === 'downloading') this.set({ kind: 'absent' });
        return false;
      }
      const message = err instanceof ModelError ? err.message : 'The download failed. Try again.';
      this.set({ kind: 'error', message, during: 'download' });
      return false;
    }
  }

  /** Stops a download in progress; nothing stays stored. */
  cancel(): void {
    const abort = this.download$;
    this.download$ = null;
    abort?.abort();
    if (this.state.kind === 'downloading') this.set({ kind: 'absent' });
  }

  /** Unloads the runtime and deletes the stored model. */
  async remove(): Promise<void> {
    this.cancel();
    await this.unload();
    await removeModel(this.storeDeps());
    this.loadFailed = false;
    const reason = this.problem();
    this.set(reason ? { kind: 'unsupported', reason } : { kind: 'absent' });
  }

  /**
   * The runtime, loading it if the model is stored and no other tab holds it.
   * Null when there is no model, another tab has it, it failed to start, or
   * `signal` was aborted first (the load itself carries on for next time).
   */
  async runtime(signal?: AbortSignal): Promise<CompletionEngine | null> {
    if (this.engine) {
      this.touch();
      return this.engine;
    }
    if (this.loadFailed) return null;
    if (!this.engine$) {
      this.engine$ = this.load().finally(() => { this.engine$ = null; });
    }
    const loading = this.engine$;
    if (!signal) return loading;
    return new Promise((resolve) => {
      const stop = () => resolve(null);
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
      loading.then((e) => {
        signal.removeEventListener('abort', stop);
        resolve(signal.aborted ? null : e);
      }, () => resolve(null));
    });
  }

  private async load(): Promise<CompletionEngine | null> {
    if (!this.checked) await this.refresh();
    else await this.checked;
    if (this.state.kind !== 'installed') return null;
    const release = await (this.deps.lock ?? browserLock)();
    if (!release) return null; // another tab holds the model
    this.set({ kind: 'loading' });
    try {
      const blob = await storedModel(this.m, this.storeDeps());
      if (!blob) {
        release();
        this.set({ kind: 'absent' });
        return null;
      }
      const engine = await createEngine(blob, this.deps.engine);
      if (this.status().kind !== 'loading') {
        // removed while it was starting
        await engine.unload();
        release();
        return null;
      }
      this.engine = engine;
      this.release = release;
      this.stopVisibility = (this.deps.onVisibility ?? browserVisibility)((visible) => this.visibility(visible));
      this.set({ kind: 'ready' });
      this.touch();
      return engine;
    } catch (err) {
      release();
      this.loadFailed = true;
      console.warn('[suggest model] could not start', err);
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 160)})` : '';
      this.set({ kind: 'error', message: `The model could not start in this browser${detail}. Word suggestions keep working.`, during: 'load' });
      return null;
    }
  }

  private timer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, t) => setTimeout(f, t)))(fn, ms);
  }

  private clear(t: unknown): void {
    if (t != null) (this.deps.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);
  }

  /** Marks the runtime as used: it unloads 10 minutes after the last use. */
  touch(): void {
    this.clear(this.idle);
    this.idle = this.engine ? this.timer(() => { void this.unload(); }, IDLE_UNLOAD_MS) : null;
  }

  private visibility(visible: boolean) {
    this.clear(this.hidden);
    this.hidden = !visible && this.engine ? this.timer(() => { void this.unload(); }, HIDDEN_UNLOAD_MS) : null;
  }

  /** Frees the runtime and the lock; the stored model stays. */
  async unload(): Promise<void> {
    this.clear(this.idle);
    this.clear(this.hidden);
    this.idle = this.hidden = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    const engine = this.engine;
    this.engine = null;
    const release = this.release;
    this.release = null;
    if (engine) await engine.unload();
    release?.();
    if (this.state.kind === 'ready' || this.state.kind === 'loading') this.set({ kind: 'installed' });
  }
}

let shared: ModelManager | null = null;

/** The tab's manager, made on first use. */
export function modelManager(): ModelManager {
  return (shared ??= new ModelManager());
}
