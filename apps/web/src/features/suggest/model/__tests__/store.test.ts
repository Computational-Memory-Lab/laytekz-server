import { describe, expect, it } from 'vitest';
import { CACHE_NAME, downloadModel, hasModel, ModelError, removeModel, storedModel } from '../store';
import { GRANITE_350M, MODEL, megabytes } from '../manifest';
import { fakeHost, tinyModel } from './fakes';

describe('the pinned manifest', () => {
  it('pins Granite 4.0 350M to a Hugging Face commit, with its size and checksum', () => {
    expect(MODEL).toBe(GRANITE_350M);
    expect(MODEL.url).toBe('https://huggingface.co/ibm-granite/granite-4.0-350m-base-GGUF/resolve/b2628819fb4e3ee4a42988e532483124b3366bd2/granite-4.0-350m-base-Q4_K_M.gguf');
    expect(MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(megabytes(MODEL.bytes)).toBe('237 MB');
    expect(MODEL.licence).toBe('Apache-2.0');
  });
});

describe('downloading the model', () => {
  it('streams it into Cache Storage with progress, checks the checksum, and reads it back', async () => {
    const { manifest, data } = tinyModel();
    const host = fakeHost(data);
    const progress: number[] = [];
    await downloadModel(manifest, { signal: new AbortController().signal, onProgress: (n) => progress.push(n) }, host.deps);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0].url).toBe(manifest.url);
    expect(host.calls[0].init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' });
    expect(progress.at(-1)).toBe(data.length);
    expect(progress.length).toBeGreaterThan(5);
    expect(await hasModel(manifest, host.deps)).toBe(true);
    const blob = await storedModel(manifest, host.deps);
    expect(blob?.size).toBe(data.length);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(data);
  });

  it('deletes a file whose checksum does not match, and says so', async () => {
    const { manifest, data } = tinyModel();
    const host = fakeHost(data);
    const wrong = { ...manifest, sha256: '0'.repeat(64) };
    const err = await downloadModel(wrong, { signal: new AbortController().signal }, host.deps).catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.kind).toBe('checksum');
    expect(err.message).toMatch(/checksum/);
    expect(await hasModel(wrong, host.deps)).toBe(false);
  });

  it('a truncated file fails the check too', async () => {
    const { manifest, data } = tinyModel();
    const host = fakeHost(data.slice(0, data.length - 10));
    const err = await downloadModel(manifest, { signal: new AbortController().signal }, host.deps).catch((e) => e);
    expect(err.kind).toBe('checksum');
    expect(await storedModel(manifest, host.deps)).toBeNull();
  });

  it('a cancel stops it with an AbortError and keeps nothing', async () => {
    const { manifest, data } = tinyModel(200_000);
    let go!: () => void;
    const wait = new Promise<void>((r) => { go = r; });
    const host = fakeHost(data, { pauseAt: { at: 40_000, wait } });
    const abort = new AbortController();
    let seen = 0;
    const run = downloadModel(manifest, {
      signal: abort.signal,
      onProgress: (n) => { seen = n; },
    }, host.deps);
    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    go();
    const err = await run.catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(data.length);
    expect(await hasModel(manifest, host.deps)).toBe(false);
  });

  it('explains a blocked download, a refused one, missing space and refused storage', async () => {
    const { manifest, data } = tinyModel();
    const signal = new AbortController().signal;
    const blocked = await downloadModel(manifest, { signal }, fakeHost(data, { throws: true }).deps).catch((e) => e);
    expect(blocked.kind).toBe('blocked');
    expect(blocked.message).toMatch(/blocked/);
    const refused = await downloadModel(manifest, { signal }, fakeHost(data, { status: 403 }).deps).catch((e) => e);
    expect(refused.kind).toBe('blocked');
    expect(refused.message).toMatch(/403/);
    const full = fakeHost(data, { quota: 1000, usage: 0 });
    const space = await downloadModel(manifest, { signal }, full.deps).catch((e) => e);
    expect(space.kind).toBe('space');
    expect(full.calls).toHaveLength(0);
    const host = fakeHost(data);
    host.deps.caches.failPut = true;
    const storage = await downloadModel(manifest, { signal }, host.deps).catch((e) => e);
    expect(storage.kind).toBe('storage');
  });

  it('removing deletes every stored copy', async () => {
    const { manifest, data } = tinyModel();
    const host = fakeHost(data);
    await downloadModel(manifest, { signal: new AbortController().signal }, host.deps);
    expect(await host.deps.caches.has(CACHE_NAME)).toBe(true);
    await removeModel(host.deps);
    expect(await hasModel(manifest, host.deps)).toBe(false);
  });
});
