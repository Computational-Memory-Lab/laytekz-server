/**
 * Laytekz V2 LaTeX-context contracts (WP01, frozen). The functions are in
 * editor/texContext/index.ts (WP08).
 */

export type TexCtxKind = 'text' | 'table' | 'math' | 'comment' | 'verbatim' | 'literal' | 'code';

export type ArgKind = 'url' | 'path' | 'cite-key' | 'ref-key' | 'label' | 'package' | 'env-name' | 'color' | 'definition' | 'option' | 'text';

export type TableFamily = 'tabular' | 'array' | 'align';

export interface TexContext {
  kind: TexCtxKind;
  /** The context chip's text: 'align*', 'URL', 'preamble', 'cell 2', 'text in math'. */
  detail: string;
  /** The innermost environment, and every open one outermost first. */
  env: string | null;
  envStack: readonly string[];
  math: null | { delim: '$' | '$$' | '\\(' | '\\[' | 'env'; env?: string; display: boolean; textInside: boolean };
  table: null | { env: string; family: TableFamily; column: number; topLevel: boolean };
  arg: null | { command: string; kind: ArgKind; index: number; from: number; to: number };
  /** Inside a monospace construct (\texttt, verbatim-like). */
  mono: boolean;
  preamble: boolean;
  inDocument: boolean;
}

/** A closed math construct; `source` is the text between innerFrom and innerTo. */
export interface Formula {
  from: number; to: number; innerFrom: number; innerTo: number;
  source: string; display: boolean; kind: 'inline' | 'display' | 'env'; env?: string;
}

export interface TableEnv { name: string; family: TableFamily; from: number; to: number; bodyFrom: number; bodyTo: number }

export interface CommandSpan { name: string; from: number; to: number; args: { from: number; to: number; optional: boolean }[] }
