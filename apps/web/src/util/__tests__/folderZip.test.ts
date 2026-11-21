// @vitest-environment node
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, entriesFromPicker, folderName, selectEntries, skipPath, zipEntries, type FolderEntry } from '../folderZip';

const file = (name: string, text: string, lastModified = Date.UTC(2026, 10, 21, 12, 0, 0)) => new File([text], name, { lastModified });
const entry = (path: string, text: string): FolderEntry => ({ path, file: file(path.split('/').pop()!, text) });

/** Reads a ZIP's central directory back: name, method and the stored bytes, inflated. */
function readZip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let off = buf.readUInt32LE(end + 16);
  const out: { name: string; method: number; flags: number; data: string; crcOk: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(off)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    const lnameLen = buf.readUInt16LE(local + 26);
    const body = buf.subarray(local + 30 + lnameLen, local + 30 + lnameLen + csize);
    const raw = method === 8 ? inflateRawSync(body) : body;
    out.push({ name, method, flags, data: raw.toString('utf8'), crcOk: crc32(new Uint8Array(raw)) === crc });
    off += 46 + nameLen;
  }
  return out;
}

describe('importing a folder', () => {
  it('leaves out hidden files, node_modules and LaTeX build byproducts', () => {
    expect(skipPath('thesis/main.tex')).toBe(false);
    expect(skipPath('thesis/figures/plot.pdf')).toBe(false);
    expect(skipPath('thesis/main.bbl')).toBe(false);
    expect(skipPath('thesis/.git/config')).toBe(true);
    expect(skipPath('thesis/.DS_Store')).toBe(true);
    expect(skipPath('thesis/node_modules/x/index.js')).toBe(true);
    expect(skipPath('thesis/__MACOSX/main.tex')).toBe(true);
    for (const ext of ['aux', 'log', 'fls', 'fdb_latexmk', 'synctex.gz', 'out', 'toc', 'blg', 'bcf', 'run.xml']) {
      expect(skipPath(`thesis/main.${ext}`), ext).toBe(true);
    }
  });

  it('names the project after the folder and keeps the picker paths', () => {
    const picked = [file('main.tex', 'a'), file('refs.bib', 'b')];
    Object.defineProperty(picked[0], 'webkitRelativePath', { value: 'thesis/main.tex' });
    Object.defineProperty(picked[1], 'webkitRelativePath', { value: 'thesis/refs.bib' });
    const entries = entriesFromPicker(picked);
    expect(entries.map((e) => e.path)).toEqual(['thesis/main.tex', 'thesis/refs.bib']);
    expect(folderName(entries)).toBe('thesis');
    expect(folderName([entry('main.tex', 'x')])).toBeNull();
    const { keep, skipped } = selectEntries([...entries, entry('thesis/main.aux', 'x'), entry('thesis/.git/HEAD', 'x')]);
    expect(keep.length).toBe(2);
    expect(skipped).toBe(2);
  });

  it('writes a ZIP the import can read: UTF-8 names, deflated text, exact bytes', async () => {
    const tex = `\\documentclass{article}\\begin{document}${'Données répétées. '.repeat(50)}\\end{document}`;
    const zip = await zipEntries([entry('thèse/main.tex', tex), entry('thèse/figures/a.txt', 'tiny')], 'thèse');
    expect(zip.name).toBe('thèse.zip');
    expect(zip.type).toBe('application/zip');
    const files = readZip(Buffer.from(await zip.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(['thèse/main.tex', 'thèse/figures/a.txt']);
    expect(files[0].method).toBe(8);
    expect(files[1].method).toBe(0);
    expect(files.every((f) => f.flags & 0x0800)).toBe(true);
    expect(files[0].data).toBe(tex);
    expect(files[1].data).toBe('tiny');
    expect(files.every((f) => f.crcOk)).toBe(true);
  });
});
