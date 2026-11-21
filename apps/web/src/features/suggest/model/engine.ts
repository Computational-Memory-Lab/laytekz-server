/**
 * The model runtime (WP43): wllama (llama.cpp compiled to WebAssembly, MIT)
 * in its own worker, loaded from a chunk of its own the first time a
 * suggestion is wanted. Its .wasm file is served from this site; only the
 * model weights come from the model host. WebGPU is used where the browser
 * has it; when loading on the GPU fails, it loads again on the CPU. No
 * COOP/COEP headers are added, so it runs single-threaded.
 */

export interface CompleteOptions {
  signal: AbortSignal;
  maxTokens: number;
  stops: readonly string[];
}

export interface CompletionEngine {
  /** The raw continuation of `prompt` (greedy). Rejects when aborted. */
  complete(prompt: string, o: CompleteOptions): Promise<string>;
  unload(): Promise<void>;
}

/** The part of wllama this file uses (its real types are checked where it is imported). */
export interface WllamaLike {
  loadModel(blobs: Blob[], params?: Record<string, unknown>): Promise<void>;
  createCompletion(o: {
    prompt: string; max_tokens: number; temperature: number; stop: string[]; abortSignal: AbortSignal;
  }): Promise<{ choices: { text: string }[] }>;
  exit(): Promise<void>;
}

export type MakeWllama = (wasmUrl: string) => WllamaLike;

export interface EngineDeps {
  /** Builds a runtime instance; the default imports wllama lazily. */
  make?(): Promise<MakeWllama>;
  /** The absolute URL of wllama.wasm; the default is the copy this site serves. */
  wasmUrl?(): Promise<string>;
}

/** The context the prompt and the suggestion share: 2,000 characters of prefix are about 500 tokens. */
export const N_CTX = 2048;

const quiet = { debug: () => {}, log: () => {}, warn: () => {}, error: (...a: unknown[]) => console.warn('[suggest model]', ...a) };

async function defaultMake(): Promise<MakeWllama> {
  const { Wllama } = await import('@wllama/wllama');
  return (wasmUrl) => new Wllama({ default: wasmUrl }, { suppressNativeLog: true, logger: quiet as never }) as unknown as WllamaLike;
}

async function defaultWasmUrl(): Promise<string> {
  const mod = await import('@wllama/wllama/esm/wasm/wllama.wasm?url');
  // The worker starts from a blob: URL, so a relative path would not resolve there.
  return new URL(mod.default, globalThis.location?.href).href;
}

/** Loads the model into a new runtime. */
export async function createEngine(model: Blob, deps: EngineDeps = {}): Promise<CompletionEngine> {
  const make = await (deps.make ?? defaultMake)();
  const wasm = await (deps.wasmUrl ?? defaultWasmUrl)();
  const params = { n_ctx: N_CTX, n_batch: 512, n_parallel: 1 };
  let w = make(wasm);
  try {
    await w.loadModel([model], params);
  } catch (first) {
    await w.exit().catch(() => {});
    w = make(wasm);
    try {
      await w.loadModel([model], { ...params, n_gpu_layers: 0 });
    } catch {
      await w.exit().catch(() => {});
      throw first;
    }
  }
  const runtime = w;
  // One completion at a time: a new question waits for the previous (already aborted) one to stop.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    complete(prompt, o) {
      const run = chain.then(async () => {
        if (o.signal.aborted) throw new DOMException('aborted', 'AbortError');
        // llama-server's slot keeps the last prompt cached, so the fixed prefix start is not recomputed.
        const r = await runtime.createCompletion({ prompt, max_tokens: o.maxTokens, temperature: 0, stop: [...o.stops], abortSignal: o.signal });
        return r.choices[0]?.text ?? '';
      });
      chain = run.catch(() => {});
      return run;
    },
    unload: () => runtime.exit().catch(() => {}),
  };
}
