/**
 * A SyncTeX file, parsed for one question: where on the typeset page is the
 * display formula written on these source lines? Pure functions over the
 * uncompressed text; no DOM. The coordinates are PDF points (big points)
 * from the page's top-left corner, as `synctex view` reports them.
 *
 * How a display is found: TeX records each character run ('x'), kern, glue
 * and box with the input file and line it came from. A display's material is
 * recorded on its body and closing lines; the box to crop is the outermost
 * hbox above those records whose characters all come from the formula's own
 * lines. A paragraph line or a page column holds characters from elsewhere,
 * so the climb stops below it, and equation numbers (typeset on the closing
 * line) come with the display box. Anything doubtful gives null.
 */

/** Scaled points per big point (65536 × 72.27 / 72). */
export const SP_PER_BP = 65781.76;

const VBOX = 1, HBOX = 2, VOIDV = 3, VOIDH = 4, CHAR = 5, KERN = 6, GLUE = 7, MATH = 8, RULE = 9;

const KINDS: Record<string, number> = { '[': VBOX, '(': HBOX, v: VOIDV, h: VOIDH, x: CHAR, k: KERN, g: GLUE, $: MATH, r: RULE };

export interface SynctexData {
  /** Input tag → the file name as TeX opened it. */
  inputs: Map<number, string>;
  /** Big points per scaled point (unit and magnification applied), and the offsets in big points. */
  scale: number;
  xOffset: number;
  yOffset: number;
  size: number;
  kind: Uint8Array;
  tag: Int32Array;
  line: Int32Array;
  page: Int32Array;
  h: Int32Array;
  v: Int32Array;
  width: Int32Array;
  height: Int32Array;
  depth: Int32Array;
  /** The enclosing box's index, or -1. */
  parent: Int32Array;
  /** For a box: the one tag of every character record inside it (-1 mixed, 0 none), and their line range. */
  charTag: Int32Array;
  charMin: Int32Array;
  charMax: Int32Array;
  /** tag → line → indices of the character records written there. */
  chars: Map<number, Map<number, number[]>>;
}

/** A crop on one page, in big points from the page's top-left corner. */
export interface SynctexRect {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The formula goes on over another page, which the crop leaves out. */
  continues: boolean;
}

function header(text: string, name: string): number | null {
  const m = new RegExp(`^${name}:(-?[0-9.]+)`, 'm').exec(text);
  return m ? Number(m[1]) : null;
}

/** Parses an uncompressed SyncTeX file. Throws on text that is not one. */
export function parseSynctex(text: string): SynctexData {
  if (!text.startsWith('SyncTeX Version:')) throw new Error('not a SyncTeX file');
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
  const kind = new Uint8Array(lines);
  const tag = new Int32Array(lines), line = new Int32Array(lines), page = new Int32Array(lines);
  const h = new Int32Array(lines), v = new Int32Array(lines), width = new Int32Array(lines), height = new Int32Array(lines), depth = new Int32Array(lines);
  const parent = new Int32Array(lines).fill(-1);
  const charTag = new Int32Array(lines), charMin = new Int32Array(lines), charMax = new Int32Array(lines);
  const chars = new Map<number, Map<number, number[]>>();
  const inputs = new Map<number, string>();

  const contentAt = text.indexOf('\nContent:');
  const pre = contentAt >= 0 ? text.slice(0, contentAt) : text.slice(0, 4096);
  const unit = header(pre, 'Unit') || 1;
  const mag = header(pre, 'Magnification') || 1000;
  const scale = (unit * mag) / 1000 / SP_PER_BP;
  const xOffset = ((header(pre, 'X Offset') ?? 0) * unit) / SP_PER_BP;
  const yOffset = ((header(pre, 'Y Offset') ?? 0) * unit) / SP_PER_BP;

  const stack: number[] = [];
  let n = 0;
  let curPage = 0;
  let start = 0;
  const merge = (box: number, t: number, lo: number, hi: number) => {
    const have = charTag[box];
    if (have === 0) { charTag[box] = t; charMin[box] = lo; charMax[box] = hi; return; }
    if (have !== t) charTag[box] = -1;
    if (lo < charMin[box]) charMin[box] = lo;
    if (hi > charMax[box]) charMax[box] = hi;
  };
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const c = text[start];
    if (c === ')' || c === ']') {
      const box = stack.pop();
      const up = stack.length ? stack[stack.length - 1] : -1;
      if (box !== undefined && up >= 0 && charTag[box] !== 0) merge(up, charTag[box], charMin[box], charMax[box]);
    } else if (c === '{') {
      curPage = parseInt(text.slice(start + 1, end), 10) || 0;
    } else if (c === 'I' && text.startsWith('Input:', start)) {
      const rest = text.slice(start + 6, end);
      const colon = rest.indexOf(':');
      if (colon > 0) inputs.set(parseInt(rest.slice(0, colon), 10), rest.slice(colon + 1));
    } else if (KINDS[c] && curPage > 0) {
      const k = KINDS[c];
      const parts = text.slice(start + 1, end).split(':');
      const tl = parts[0].split(',');
      const pos = (parts[1] ?? '').split(',');
      const dims = (parts[2] ?? '').split(',');
      const i = n++;
      kind[i] = k;
      tag[i] = parseInt(tl[0], 10) || 0;
      line[i] = parseInt(tl[1], 10) || 0;
      page[i] = curPage;
      h[i] = parseInt(pos[0], 10) || 0;
      v[i] = parseInt(pos[1], 10) || 0;
      width[i] = parseInt(dims[0], 10) || 0;
      height[i] = parseInt(dims[1], 10) || 0;
      depth[i] = parseInt(dims[2], 10) || 0;
      parent[i] = stack.length ? stack[stack.length - 1] : -1;
      if (k === VBOX || k === HBOX) stack.push(i);
      else if ((k === CHAR || k === MATH) && tag[i] > 0) {
        if (parent[i] >= 0) merge(parent[i], tag[i], line[i], line[i]);
        let byLine = chars.get(tag[i]);
        if (!byLine) chars.set(tag[i], (byLine = new Map()));
        const at = byLine.get(line[i]);
        if (at) at.push(i); else byLine.set(line[i], [i]);
      }
    }
    start = end + 1;
  }
  return { inputs, scale, xOffset, yOffset, size: n, kind, tag, line, page, h, v, width, height, depth, parent, charTag, charMin, charMax, chars };
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return ''; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

/**
 * The input tag of a project file. TeX names inputs as it opened them: the
 * compile runs in the root file's folder, so `<abs>/./chapters/x.tex` and a
 * bare `chapters/x.tex` are relative to it. An exact match wins; otherwise an
 * absolute name that ends with the project path, when only one does.
 */
export function tagFor(inputs: ReadonlyMap<number, string>, filePath: string, rootDir: string): number | null {
  const want = normalize(filePath);
  const dir = normalize(rootDir);
  const suffix: number[] = [];
  for (const [t, raw] of inputs) {
    const name = raw.replace(/\\/g, '/');
    const dot = name.lastIndexOf('/./');
    let rel: string | null = null;
    if (dot >= 0) rel = name.slice(dot + 3);
    else if (!name.startsWith('/') && !/^[A-Za-z]:\//.test(name)) rel = name;
    if (rel !== null) {
      if (normalize(dir ? `${dir}/${rel}` : rel) === want) return t;
    } else if (name.endsWith(`/${want}`)) suffix.push(t);
  }
  return suffix.length === 1 ? suffix[0] : null;
}

/** Whether every character record inside box `i` was written on lines `lo`…`hi` of `t`. */
function pure(d: SynctexData, i: number, t: number, lo: number, hi: number): boolean {
  const ct = d.charTag[i];
  if (ct === 0) return true;
  return ct === t && d.charMin[i] >= lo && d.charMax[i] <= hi;
}

/** Box `i` spans the whole width of the box it sits in, from its left edge: a paragraph line or an alignment row. */
function fullLine(d: SynctexData, i: number): boolean {
  const up = d.parent[i];
  if (up < 0) return false;
  const tol = 0.5 / d.scale;
  return Math.abs(d.h[i] - d.h[up]) <= tol && Math.abs(Math.abs(d.width[i]) - Math.abs(d.width[up])) <= tol;
}

/**
 * Where the display written on lines `first`…`last` of input `t` sits on the
 * page, or null when that is not certain. `single`: the whole formula is on
 * one source line, which the paragraph before it was broken on as well, so a
 * box spanning the full line is left out (and only such boxes means null).
 */
export function displayRect(d: SynctexData, t: number, first: number, last: number, o: { single?: boolean; pad?: number } = {}): SynctexRect | null {
  const byLine = d.chars.get(t);
  if (!byLine || last < first) return null;
  const tops = new Set<number>();
  for (let ln = first; ln <= last; ln++) {
    for (const rec of byLine.get(ln) ?? []) {
      let best = -1;
      for (let cur = d.parent[rec]; cur >= 0 && pure(d, cur, t, first, last); cur = d.parent[cur]) {
        if (d.kind[cur] === HBOX) best = cur;
      }
      if (best >= 0) tops.add(best);
    }
  }
  let boxes = [...tops];
  if (o.single) {
    const narrow = boxes.filter((b) => !fullLine(d, b));
    if (!narrow.length) return null;
    boxes = narrow;
  }
  if (!boxes.length) return null;
  const pages = new Map<number, { x0: number; y0: number; x1: number; y1: number; area: number }>();
  for (const b of boxes) {
    const w = d.width[b];
    const left = w < 0 ? d.h[b] + w : d.h[b];
    const x0 = left * d.scale + d.xOffset, x1 = (left + Math.abs(w)) * d.scale + d.xOffset;
    const y0 = (d.v[b] - d.height[b]) * d.scale + d.yOffset, y1 = (d.v[b] + d.depth[b]) * d.scale + d.yOffset;
    const r = pages.get(d.page[b]);
    const area = (x1 - x0) * (y1 - y0);
    if (!r) pages.set(d.page[b], { x0, y0, x1, y1, area });
    else { r.x0 = Math.min(r.x0, x0); r.y0 = Math.min(r.y0, y0); r.x1 = Math.max(r.x1, x1); r.y1 = Math.max(r.y1, y1); r.area += area; }
  }
  let pick: number | null = null;
  for (const [p, r] of pages) if (pick === null || r.area > pages.get(pick)!.area) pick = p;
  if (pick === null) return null;
  const r = pages.get(pick)!;
  // a crop taller than the formula's lines could ever be is a page or column, not a display
  const lines = last - first + 1;
  if (r.x1 - r.x0 <= 0 || r.y1 - r.y0 <= 0 || r.y1 - r.y0 > 48 * (lines + 2) || r.x1 - r.x0 > 1200) return null;
  const pad = o.pad ?? 0;
  return { page: pick, x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad, continues: pages.size > 1 };
}
