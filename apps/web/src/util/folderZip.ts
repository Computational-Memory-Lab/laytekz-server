/**
 * Galley: import a project from a folder. The browser packs the folder's files
 * into a ZIP and the existing ZIP import (/api/projects/import) places it, so
 * a folder and a ZIP land exactly the same way (same path checks, same
 * wrapper-folder stripping, same size limit).
 *
 * Left out of the archive: hidden files and folders (.git, .DS_Store, …),
 * node_modules and __MACOSX, and LaTeX's run-time byproducts, which the
 * project typesets again anyway.
 */

export interface FolderEntry { path: string; file: File }

const SKIP_DIRS = new Set(['node_modules', '__macosx']);
const BUILD_BYPRODUCTS = /\.(aux|log|fls|fdb_latexmk|synctex|synctex\.gz|synctex\(busy\)|out|toc|lof|lot|blg|bcf|run\.xml|xdv|dvi|nav|snm|vrb|idx|ilg|ind|glg|glo|gls|ist|acn|acr|alg|thm|loa|lol)$/i;

/** Whether a folder-relative path stays out of the archive. */
export function skipPath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return true;
  if (parts.some((p) => p.startsWith('.') || SKIP_DIRS.has(p.toLowerCase()))) return true;
  return BUILD_BYPRODUCTS.test(parts[parts.length - 1]);
}

/** The files an `<input webkitdirectory>` returned, with their folder-relative paths. */
export function entriesFromPicker(files: readonly File[]): FolderEntry[] {
  return files.map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));
}

/** The top folder's name ("thesis" for "thesis/main.tex"), or null for loose files. */
export function folderName(entries: readonly FolderEntry[]): string | null {
  const first = entries[0]?.path.split('/');
  if (!first || first.length < 2) return null;
  return entries.every((e) => e.path.startsWith(`${first[0]}/`)) ? first[0] : null;
}

/** Splits what to pack from what is left out. */
export function selectEntries(entries: readonly FolderEntry[]): { keep: FolderEntry[]; skipped: number } {
  const keep = entries.filter((e) => !skipPath(e.path));
  return { keep, skipped: entries.length - keep.length };
}

/**
 * Walks folders dropped on the page (DataTransferItem.webkitGetAsEntry), one
 * list per dropped folder. The entries must be taken during the drop event;
 * the walk itself may run afterwards.
 */
export async function walkDropped(root: FileSystemDirectoryEntry): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  const visit = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader();
    // readEntries answers in batches (about 100 in Chrome) until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const entry of batch) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory) {
          if (!skipPath(`${path}/x`)) await visit(entry as FileSystemDirectoryEntry, `${path}/`);
        } else if (entry.isFile && !skipPath(path)) {
          const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
          out.push({ path, file });
        }
      }
    }
  };
  await visit(root, `${root.name}/`);
  return out;
}

// ---- a small ZIP writer (APPNOTE 6.3): deflate where the browser can, else store

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw' as CompressionFormat));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Packs the entries into a ZIP named `${name}.zip`. */
export async function zipEntries(entries: readonly FolderEntry[], name: string): Promise<File> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { path, file } of entries) {
    const raw = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(raw);
    const deflated = raw.length > 64 ? await deflateRaw(raw) : null;
    const useDeflate = !!deflated && deflated.length < raw.length;
    const body = useDeflate ? deflated! : raw;
    const nameBytes = enc.encode(path);
    const { time, date } = dosTime(file.lastModified);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, useDeflate ? 8 : 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes as BlobPart, body as BlobPart);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, useDeflate ? 8 : 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    const rec = new Uint8Array(46 + nameBytes.length);
    rec.set(new Uint8Array(cd.buffer), 0);
    rec.set(nameBytes, 46);
    central.push(rec);
    offset += 30 + nameBytes.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new File([...parts, ...(central as BlobPart[]), end.buffer], `${name}.zip`, { type: 'application/zip' });
}
