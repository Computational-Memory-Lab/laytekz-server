import type { PdfRect } from '../../contextmenu/types';

/** One record of POST /api/projects/:id/synctex (`synctex edit`/`view` output: Input, Line, Page, x, y, …). */
export type SynctexRecord = Record<string, number | string>;

export interface SourcePlace {
  /** The project path, or the file's name when it is not one of the project's files. */
  file: string;
  /** 1-based. */
  line: number;
  inProject: boolean;
}

/**
 * The source file and line an inverse SyncTeX answer names, matched to the
 * project's files the way the double-click jump does (Editor.tsx
 * onPdfInverse): the exact project path first, then a suffix match either
 * way. Older compilers report paths as TeX opened them (…/paper/./ch1.tex).
 */
export function sourcePlace(records: readonly SynctexRecord[] | undefined, files: readonly { path: string; type?: string }[]): SourcePlace | null {
  const rec = records?.find((r) => r.input || r.line != null);
  if (!rec) return null;
  const line = Number(rec.line);
  const file = String(rec.input || '').replace(/\/(?:\.\/)+/g, '/');
  if (!file || !Number.isFinite(line) || line < 1) return null;
  const list = files.filter((f) => f.type === undefined || f.type === 'file');
  const match = list.find((f) => f.path === file)
    ?? list.find((f) => file.endsWith('/' + f.path))
    ?? list.find((f) => f.path.endsWith('/' + file));
  if (match) return { file: match.path, line, inProject: true };
  return { file: file.split('/').pop() || file, line, inProject: false };
}

/** The point SyncTeX is asked about for one line box of the selection: just inside its left edge, half way down. PDF points, top-left origin. */
export function probePoint(r: PdfRect): { x: number; y: number } {
  return { x: r.left + Math.min(2, Math.max(0, (r.right - r.left) / 2)), y: (r.top + r.bottom) / 2 };
}

/** The same words, ignoring spacing and punctuation (the text layer's and the Selection's renderings differ). */
export function sameSelectedText(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return norm(a) === norm(b) && norm(a).length > 0;
}

/** A short, one-line version of the selected text for messages. */
export function shortQuote(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
