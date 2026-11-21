/**
 * The word ghost (WP40): the rest of a long word this project already uses,
 * with no model. The vocabulary is the prose of the open file plus the
 * project's other .tex files: words of at least seven letters outside
 * comments, math, verbatim, the preamble, command names and key or path
 * arguments. A word is suggested after three typed letters when it occurs at
 * least twice and is unique or at least twice as frequent as the runner-up.
 */
import type { EditorState, Text } from '@codemirror/state';
import type { SuggestRequest, SuggestionProvider } from './provider';

/** At least seven letters; an apostrophe or hyphen may sit inside. */
const WORD_RE = /[A-Za-z][A-Za-z'-]{6,}/g;
export const MIN_WORD_LENGTH = 7;
export const MIN_TYPED = 3;
export const MIN_COUNT = 2;

const MATH_ENVS = 'equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|math|dmath|subequations';
const VERBATIM_ENVS = 'verbatim|Verbatim|lstlisting|minted|comment|alltt|filecontents|tikzpicture|tikzcd';
/** Commands whose first mandatory argument is a key, a path, a name or code, never prose. */
const LITERAL_COMMANDS = [
  'cite[a-zA-Z]*', '[a-z]*cite[a-z]*', 'nocite', 'ref', 'eqref', 'autoref', 'pageref', 'nameref', '[cC]ref', '[cC]pageref', 'vref',
  'label', 'usepackage', 'RequirePackage', 'documentclass', 'includegraphics', 'input', 'include', 'includeonly', 'subfile',
  'bibliography', 'bibliographystyle', 'addbibresource', 'graphicspath', 'url', 'href', 'path', 'begin', 'end',
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'def',
  'color', 'textcolor', 'hypersetup', 'setlength', 'addtolength', 'setcounter', 'newcounter', 'hspace', 'vspace',
].join('|');

const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** The text with everything that is not prose blanked (line breaks kept). */
export function proseOf(text: string): string {
  let t = text;
  // comments: an unescaped % to the end of its line
  t = t.replace(/(^|[^\\])((?:\\\\)*)%[^\n]*/g, (m, a: string, b: string) => a + b + blank(m.slice(a.length + b.length)));
  // a typesetting file's preamble
  const docStart = t.search(/\\begin\{document\}/);
  if (docStart > 0 && /\\documentclass/.test(t.slice(0, docStart))) t = blank(t.slice(0, docStart)) + t.slice(docStart);
  t = t.replace(new RegExp(`\\\\begin\\{(${VERBATIM_ENVS})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, 'g'), blank);
  t = t.replace(new RegExp(`\\\\begin\\{(${MATH_ENVS})\\*?\\}[\\s\\S]*?\\\\end\\{\\1\\*?\\}`, 'g'), blank);
  t = t.replace(/\\verb(.)[^\n]*?\1/g, blank);
  t = t.replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, blank);
  t = t.replace(/(^|[^\\])\$\$[\s\S]*?\$\$/g, (m, a: string) => a + blank(m.slice(a.length)));
  t = t.replace(/(^|[^\\])\$(?:\\.|[^$\\])*\$/g, (m, a: string) => a + blank(m.slice(a.length)));
  t = t.replace(new RegExp(`\\\\(?:${LITERAL_COMMANDS})\\*?(?:\\s*\\[[^\\]\\n]*\\])*\\s*\\{[^{}]*\\}`, 'g'), blank);
  // every other command name (its text arguments stay)
  t = t.replace(/\\(?:[A-Za-z@]+\*?|.)/g, blank);
  return t;
}

export interface Vocabulary {
  /** Lower-cased word → occurrences. */
  counts: Map<string, number>;
  /** Lower-cased word → the form to complete with (the lower-case form when it occurs). */
  forms: Map<string, string>;
  /** The lower-cased words, sorted, for prefix search. */
  sorted: string[];
}

export const EMPTY_VOCABULARY: Vocabulary = { counts: new Map(), forms: new Map(), sorted: [] };

/** Counts the prose words of `texts` (each a whole file). */
export function buildVocabulary(texts: readonly string[]): Vocabulary {
  const counts = new Map<string, number>();
  const forms = new Map<string, string>();
  for (const text of texts) {
    for (const m of proseOf(text).matchAll(WORD_RE)) {
      const word = m[0].replace(/['-]+$/, '');
      if (word.length < MIN_WORD_LENGTH) continue;
      const key = word.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const have = forms.get(key);
      if (have === undefined || (have !== key && word === key)) forms.set(key, word);
    }
  }
  return { counts, forms, sorted: [...counts.keys()].sort() };
}

/** Both vocabularies' counts added. */
export function mergeVocabularies(a: Vocabulary, b: Vocabulary): Vocabulary {
  if (!b.sorted.length) return a;
  if (!a.sorted.length) return b;
  const counts = new Map(a.counts);
  const forms = new Map(a.forms);
  for (const [k, n] of b.counts) {
    counts.set(k, (counts.get(k) ?? 0) + n);
    if (!forms.has(k) || (forms.get(k) !== k && b.forms.get(k) === k)) forms.set(k, b.forms.get(k)!);
  }
  return { counts, forms, sorted: [...counts.keys()].sort() };
}

function firstAtOrAfter(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The rest of the word `typed` begins, or null. The typed letters keep their case; all capitals stay capitals. */
export function lookupWord(v: Vocabulary, typed: string, o: { explicit?: boolean } = {}): string | null {
  if (typed.length < (o.explicit ? 1 : MIN_TYPED)) return null;
  const t = typed.toLowerCase();
  let best: { key: string; n: number } | null = null;
  let second = 0;
  for (let i = firstAtOrAfter(v.sorted, t), seen = 0; i < v.sorted.length && seen < 5000; i++, seen++) {
    const key = v.sorted[i];
    if (!key.startsWith(t)) break;
    if (key.length <= t.length) continue;
    const n = v.counts.get(key) ?? 0;
    if (!best || n > best.n || (n === best.n && key.length < best.key.length)) {
      if (best) second = Math.max(second, best.n);
      best = { key, n };
    } else second = Math.max(second, n);
  }
  if (!best) return null;
  if (!o.explicit && (best.n < MIN_COUNT || best.n < 2 * second)) return null;
  const rest = (v.forms.get(best.key) ?? best.key).slice(typed.length);
  const allCaps = typed.length >= 2 && typed === typed.toUpperCase() && typed !== typed.toLowerCase();
  return allCaps ? rest.toUpperCase() : rest;
}

/** The word the caret ends: letters (with inner ' or -) not part of a command, followed by no letter. */
export function typedWordAt(state: EditorState, pos: number): { from: number; word: string } | null {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(Math.max(line.from, pos - 200), pos);
  const m = /[A-Za-z][A-Za-z'-]*$/.exec(before);
  if (!m) return null;
  const prev = before[m.index - 1];
  if (prev === '\\' || prev === '@' || (prev !== undefined && /[0-9_^]/.test(prev))) return null;
  const next = state.sliceDoc(pos, Math.min(line.to, pos + 1));
  if (next && /[A-Za-z0-9'-]/.test(next)) return null;
  return { from: pos - m[0].length, word: m[0] };
}

export interface WordProviderOptions {
  /** The text of the project's other .tex files (read once a minute at most). */
  projectTexts?: () => Promise<readonly string[]>;
  /** The clock, for tests. */
  now?: () => number;
}

/** How long the open file's vocabulary is reused while the text changes. */
export const DOC_VOCAB_MS = 1500;
/** How long the other files' vocabulary is reused. */
export const PROJECT_VOCAB_MS = 60_000;

/** The word provider for one editor: the open file's words (minus the word being typed) and the project's. */
export function createWordProvider(o: WordProviderOptions = {}): SuggestionProvider & { vocabulary(state: EditorState, wordFrom: number, pos: number): Vocabulary } {
  const now = o.now ?? (() => Date.now());
  let docVocab: Vocabulary | null = null;
  let docOf: Text | null = null;
  let docAt = 0;
  let projectVocab: Vocabulary = EMPTY_VOCABULARY;
  let projectAt = -Infinity;
  let loading = false;
  let merged: Vocabulary | null = null;

  const loadProject = () => {
    if (!o.projectTexts || loading || now() - projectAt < PROJECT_VOCAB_MS) return;
    loading = true;
    projectAt = now();
    o.projectTexts()
      .then((texts) => { projectVocab = buildVocabulary(texts); merged = null; })
      .catch(() => { /* keep what was read before */ })
      .finally(() => { loading = false; });
  };

  const vocabulary = (state: EditorState, wordFrom: number, pos: number): Vocabulary => {
    loadProject();
    if (!docVocab || (docOf !== state.doc && now() - docAt >= DOC_VOCAB_MS)) {
      const doc = state.doc;
      docVocab = buildVocabulary([doc.sliceString(0, wordFrom) + ' ' + doc.sliceString(pos)]);
      docOf = doc;
      docAt = now();
      merged = null;
    }
    return (merged ??= mergeVocabularies(docVocab, projectVocab));
  };

  return {
    id: 'words',
    vocabulary,
    suggest(req: SuggestRequest) {
      if (!req.word) return null;
      return lookupWord(vocabulary(req.state, req.pos - req.word.length, req.pos), req.word, { explicit: req.explicit });
    },
  };
}
