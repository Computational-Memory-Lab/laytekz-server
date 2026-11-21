/**
 * Whether this browser can run the suggestion model (WP43), and if not, why,
 * in words the settings row shows. The runtime (llama.cpp compiled to
 * WebAssembly) needs SIMD and exception handling; the model is kept in Cache
 * Storage, which needs a secure context; and it takes about half a gigabyte
 * of memory while loaded.
 */

export interface SupportEnv {
  secure: boolean;
  wasm: boolean;
  simd: boolean;
  exceptions: boolean;
  caches: boolean;
  /** navigator.deviceMemory (Chromium only, in GB, rounded and capped at 8). */
  deviceMemoryGb?: number;
}

/** The least memory a device may report. The model needs about 0.5 GB while loaded. */
export const MIN_DEVICE_MEMORY_GB = 2;

/** Why the model cannot run here, or null when it can. */
export function supportProblem(env: SupportEnv): string | null {
  if (!env.secure || !env.caches) {
    return 'This browser does not let the site store the model here (it needs a secure connection and site storage; private windows often block it).';
  }
  if (!env.wasm) return 'This browser cannot run WebAssembly, which the model needs.';
  if (!env.simd) return 'This browser’s WebAssembly has no SIMD support, which the model needs.';
  if (!env.exceptions) return 'This browser’s WebAssembly is too old to run the model (no exception handling). Updating the browser may help.';
  if (env.deviceMemoryGb != null && env.deviceMemoryGb < MIN_DEVICE_MEMORY_GB) {
    return `This device reports less than ${MIN_DEVICE_MEMORY_GB} GB of memory, too little to run the model.`;
  }
  return null;
}

// The smallest modules that use a SIMD instruction and a try block (the
// probes wasm-feature-detect and wllama use).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const EXCEPTIONS_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]);

function validates(bytes: BufferSource): boolean {
  try {
    return WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

/** Reads the environment of the running browser. */
export function readSupportEnv(g: typeof globalThis = globalThis): SupportEnv {
  const wasm = typeof g.WebAssembly === 'object' && typeof g.WebAssembly?.validate === 'function';
  const nav = (g as { navigator?: Navigator & { deviceMemory?: number } }).navigator;
  let caches = false;
  try {
    caches = typeof g.caches === 'object' && g.caches !== null;
  } catch {
    caches = false;
  }
  return {
    secure: g.isSecureContext !== false,
    wasm,
    simd: wasm && validates(SIMD_PROBE),
    exceptions: wasm && validates(EXCEPTIONS_PROBE),
    caches,
    deviceMemoryGb: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined,
  };
}
