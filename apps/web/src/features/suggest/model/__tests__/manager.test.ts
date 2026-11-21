import { describe, expect, it, vi } from 'vitest';
import { HIDDEN_UNLOAD_MS, IDLE_UNLOAD_MS, ModelManager, type ManagerDeps } from '../manager';
import { supportProblem, readSupportEnv, type SupportEnv } from '../support';
import { createEngine, type MakeWllama, type WllamaLike } from '../engine';
import { fakeHost, tinyModel } from './fakes';

const OK_ENV: SupportEnv = { secure: true, wasm: true, simd: true, exceptions: true, caches: true, deviceMemoryGb: 8 };

function fakeWllama(o: { failGpu?: boolean; failAll?: boolean } = {}) {
  const made: (WllamaLike & { params: Record<string, unknown>[]; url: string })[] = [];
  const make: MakeWllama = (url) => {
    const w = {
      url,
      params: [] as Record<string, unknown>[],
      loadModel: vi.fn(async (_b: Blob[], params?: Record<string, unknown>) => {
        w.params.push(params ?? {});
        if (o.failAll || (o.failGpu && params?.n_gpu_layers !== 0)) throw new Error('webgpu device lost');
      }),
      createCompletion: vi.fn(async (r: { prompt: string; abortSignal: AbortSignal }) => {
        if (r.abortSignal.aborted) throw new DOMException('aborted', 'AbortError');
        return { choices: [{ text: ` after ${r.prompt.length}` }] };
      }),
      exit: vi.fn(async () => {}),
    };
    made.push(w);
    return w;
  };
  return { make, made };
}

function setup(o: { env?: SupportEnv; lockFree?: boolean; failGpu?: boolean; failAll?: boolean; stored?: boolean } = {}) {
  const { manifest, data } = tinyModel();
  const host = fakeHost(data);
  const wl = fakeWllama(o);
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let visibility: ((v: boolean) => void) | null = null;
  const released = vi.fn();
  const deps: ManagerDeps = {
    manifest,
    env: () => o.env ?? OK_ENV,
    store: () => host.deps,
    engine: { make: async () => wl.make, wasmUrl: async () => 'https://laytekz.test/assets/wllama.wasm' },
    lock: async () => (o.lockFree === false ? null : released),
    onVisibility: (fn) => { visibility = fn; return () => { visibility = null; }; },
    setTimer: (fn, ms) => { const t = { fn, ms, id: timers.length + 1 }; timers.push(t); return t.id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const mgr = new ModelManager(deps);
  return { mgr, host, wl, timers, released, manifest, hide: () => visibility?.(false), show: () => visibility?.(true) };
}

describe('support', () => {
  it('names what is missing, in plain words', () => {
    expect(supportProblem(OK_ENV)).toBeNull();
    expect(supportProblem({ ...OK_ENV, simd: false })).toMatch(/SIMD/);
    expect(supportProblem({ ...OK_ENV, exceptions: false })).toMatch(/too old/);
    expect(supportProblem({ ...OK_ENV, wasm: false })).toMatch(/WebAssembly/);
    expect(supportProblem({ ...OK_ENV, caches: false })).toMatch(/store the model/);
    expect(supportProblem({ ...OK_ENV, secure: false })).toMatch(/secure connection/);
    expect(supportProblem({ ...OK_ENV, deviceMemoryGb: 1 })).toMatch(/memory/);
    expect(supportProblem({ ...OK_ENV, deviceMemoryGb: undefined })).toBeNull();
  });

  it('reads Node’s WebAssembly as able (SIMD and exceptions)', () => {
    const env = readSupportEnv();
    expect(env.wasm).toBe(true);
    expect(env.simd).toBe(true);
    expect(env.exceptions).toBe(true);
  });
});

describe('the model manager', () => {
  it('says why an unable browser cannot use it, and never downloads there', async () => {
    const s = setup({ env: { ...OK_ENV, simd: false } });
    await s.mgr.refresh();
    expect(s.mgr.status()).toMatchObject({ kind: 'unsupported' });
    expect(await s.mgr.download()).toBe(false);
    expect(s.host.calls).toHaveLength(0);
    expect(await s.mgr.runtime()).toBeNull();
  });

  it('downloads with progress, then loads the runtime lazily on first use', async () => {
    const s = setup();
    await s.mgr.refresh();
    expect(s.mgr.status()).toEqual({ kind: 'absent' });
    expect(await s.mgr.runtime()).toBeNull(); // nothing stored: never downloads on its own
    expect(s.host.calls).toHaveLength(0);
    const seen: string[] = [];
    s.mgr.subscribe(() => seen.push(s.mgr.status().kind));
    expect(await s.mgr.download()).toBe(true);
    expect(seen[0]).toBe('downloading');
    expect(s.mgr.status()).toEqual({ kind: 'installed' });
    expect(s.wl.made).toHaveLength(0);
    const engine = await s.mgr.runtime();
    expect(engine).not.toBeNull();
    expect(s.mgr.status()).toEqual({ kind: 'ready' });
    expect(s.wl.made).toHaveLength(1);
    expect(s.wl.made[0].url).toBe('https://laytekz.test/assets/wllama.wasm');
    expect(s.wl.made[0].params[0]).toMatchObject({ n_ctx: 2048 });
    expect(await engine!.complete('abc', { signal: new AbortController().signal, maxTokens: 24, stops: [] })).toBe(' after 3');
    expect(await s.mgr.runtime()).toBe(engine); // loaded once
  });

  it('a cancelled download goes back to absent and keeps nothing', async () => {
    const s = setup();
    await s.mgr.refresh();
    const run = s.mgr.download();
    s.mgr.cancel();
    expect(await run).toBe(false);
    expect(s.mgr.status()).toEqual({ kind: 'absent' });
    await s.mgr.refresh();
    expect(s.mgr.status()).toEqual({ kind: 'absent' });
  });

  it('a failed download says why', async () => {
    const s = setup();
    s.host.deps.caches.failPut = true;
    expect(await s.mgr.download()).toBe(false);
    expect(s.mgr.status()).toMatchObject({ kind: 'error', during: 'download' });
  });

  it('falls back to the CPU when the GPU load fails, and reports a runtime that cannot start', async () => {
    const gpu = setup({ failGpu: true });
    await gpu.mgr.download();
    expect(await gpu.mgr.runtime()).not.toBeNull();
    expect(gpu.wl.made).toHaveLength(2);
    expect(gpu.wl.made[0].exit).toHaveBeenCalled();
    expect(gpu.wl.made[1].params[0]).toMatchObject({ n_gpu_layers: 0 });

    const broken = setup({ failAll: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await broken.mgr.download();
    expect(await broken.mgr.runtime()).toBeNull();
    expect(broken.mgr.status()).toMatchObject({ kind: 'error', during: 'load' });
    expect(broken.released).toHaveBeenCalled();
    expect(await broken.mgr.runtime()).toBeNull(); // no retry loop
    expect(broken.wl.made).toHaveLength(2);
    await broken.mgr.refresh(); // the settings row opening keeps the reason
    expect(broken.mgr.status()).toMatchObject({ kind: 'error', during: 'load' });
  });

  it('only one tab holds the runtime', async () => {
    const s = setup({ lockFree: false });
    await s.mgr.download();
    expect(await s.mgr.runtime()).toBeNull();
    expect(s.wl.made).toHaveLength(0);
    expect(s.mgr.status()).toEqual({ kind: 'installed' });
  });

  it('unloads after 10 idle minutes or 2 hidden ones, keeping the stored model', async () => {
    const s = setup();
    await s.mgr.download();
    await s.mgr.runtime();
    const idle = s.timers.find((t) => t.ms === IDLE_UNLOAD_MS)!;
    expect(idle).toBeDefined();
    idle.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.wl.made[0].exit).toHaveBeenCalled();
    expect(s.released).toHaveBeenCalledTimes(1);
    expect(s.mgr.status()).toEqual({ kind: 'installed' });

    await s.mgr.runtime();
    s.hide();
    const hidden = s.timers.find((t) => t.ms === HIDDEN_UNLOAD_MS)!;
    expect(hidden).toBeDefined();
    s.show();
    expect(s.timers.find((t) => t.ms === HIDDEN_UNLOAD_MS)).toBeUndefined();
    s.hide();
    s.timers.find((t) => t.ms === HIDDEN_UNLOAD_MS)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.wl.made[1].exit).toHaveBeenCalled();
    expect(s.mgr.status()).toEqual({ kind: 'installed' });
  });

  it('an aborted wait returns null while the load carries on', async () => {
    const s = setup();
    await s.mgr.download();
    const abort = new AbortController();
    const waiting = s.mgr.runtime(abort.signal);
    abort.abort();
    expect(await waiting).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.mgr.status()).toEqual({ kind: 'ready' });
  });

  it('remove unloads the runtime and deletes the model', async () => {
    const s = setup();
    await s.mgr.download();
    await s.mgr.runtime();
    await s.mgr.remove();
    expect(s.wl.made[0].exit).toHaveBeenCalled();
    expect(s.mgr.status()).toEqual({ kind: 'absent' });
    await s.mgr.refresh();
    expect(s.mgr.status()).toEqual({ kind: 'absent' });
    expect(await s.mgr.runtime()).toBeNull();
  });

  it('a model the browser evicted reads as absent', async () => {
    const s = setup();
    await s.mgr.download();
    await s.host.deps.caches.delete('laytekz-suggest-model');
    await s.mgr.refresh();
    expect(s.mgr.status()).toEqual({ kind: 'absent' });
  });
});

describe('the engine', () => {
  it('runs one completion at a time and passes the abort signal', async () => {
    const wl = fakeWllama();
    const engine = await createEngine(new Blob(['x']), { make: async () => wl.make, wasmUrl: async () => 'https://x.test/w.wasm' });
    const a = new AbortController();
    const first = engine.complete('one', { signal: a.signal, maxTokens: 24, stops: ['<|end_of_text|>'] });
    const second = engine.complete('three', { signal: new AbortController().signal, maxTokens: 24, stops: [] });
    expect(await first).toBe(' after 3');
    expect(await second).toBe(' after 5');
    const call = vi.mocked(wl.made[0].createCompletion).mock.calls[0][0];
    expect(call).toMatchObject({ prompt: 'one', max_tokens: 24, temperature: 0, stop: ['<|end_of_text|>'] });
    expect(call.abortSignal).toBe(a.signal);
    a.abort();
    await expect(engine.complete('x', { signal: a.signal, maxTokens: 24, stops: [] })).rejects.toThrow();
    await engine.unload();
    expect(wl.made[0].exit).toHaveBeenCalled();
  });
});
