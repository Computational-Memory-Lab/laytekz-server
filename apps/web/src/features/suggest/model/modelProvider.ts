/**
 * The model as a suggestion provider (WP43). It is asked after the word
 * provider, 250 ms after the last typed character (the scheduler's
 * debounce), only at a word boundary in prose, and only while "Smarter
 * suggestions" is on and the page is visible. The prompt is the
 * fill-in-the-middle window from promptContext.ts; the answer goes through
 * WP40's trimming rules. A keystroke or caret move aborts the question.
 */
import type { Text } from '@codemirror/state';
import type { SuggestionProvider } from '../provider';
import { promptContext, type PromptContext } from '../promptContext';
import { postprocess, STOP_TOKENS } from '../postprocess';
import { MODEL, type ModelManifest } from './manifest';
import type { CompletionEngine } from './engine';

/** At most this many tokens per suggestion (about a short phrase). */
export const MAX_TOKENS = 24;

/**
 * A word boundary: the character after the caret ends a line or is a space or
 * one of `)]}$.,;:`, and the character before is a space or punctuation.
 * Mid-word the word provider answers, so the two never compete.
 */
export function atWordBoundary(doc: Text, pos: number): boolean {
  if (pos <= 0) return false;
  const before = doc.sliceString(pos - 1, pos);
  const after = doc.sliceString(pos, Math.min(doc.length, pos + 1));
  const afterOk = after === '' || /[\s)\]}$.,;:]/.test(after);
  const beforeOk = /[\s.,;:!?)\]}'"`~-]/.test(before);
  return afterOk && beforeOk;
}

export interface ModelPrompt {
  prompt: string;
  /** The caret follows a space the prompt left out (a lone trailing space confuses the tokenizer). */
  spaceDropped: boolean;
}

/** `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`, without the prefix's trailing spaces. */
export function buildPrompt(m: ModelManifest, ctx: PromptContext): ModelPrompt {
  const prefix = ctx.prefix.replace(/[ \t]+$/, '');
  return { prompt: `${m.fim.prefix}${prefix}${m.fim.suffix}${ctx.suffix}${m.fim.middle}`, spaceDropped: prefix.length !== ctx.prefix.length };
}

/** The model's raw text as a suggestion for the caret, or null. */
export function toSuggestion(raw: string, ctx: PromptContext, spaceDropped: boolean, m: ModelManifest = MODEL): string | null {
  let text = raw;
  if (spaceDropped) {
    // The person already typed the space; a continuation that does not start a new word does not fit after it.
    if (!/^[ \t]/.test(text)) return null;
    text = text.replace(/^[ \t]+/, '');
  }
  return postprocess(text, ctx.prefix, ctx.suffix, [...STOP_TOKENS, ...m.stops]);
}

export interface ModelProviderDeps {
  /** "Smarter suggestions" is on. */
  enabled(): boolean;
  /** The loaded runtime, or null (no model, another tab has it, or aborted while loading). */
  runtime(signal: AbortSignal): Promise<CompletionEngine | null>;
  /** The page is visible (default: always). */
  visible?(): boolean;
  manifest?: ModelManifest;
}

export function createModelProvider(deps: ModelProviderDeps): SuggestionProvider {
  const m = deps.manifest ?? MODEL;
  return {
    id: 'model',
    deferred: true,
    async suggest(req, signal) {
      try {
        if (!deps.enabled()) return null;
        if (deps.visible && !deps.visible()) return null;
      } catch {
        return null;
      }
      if (!req.explicit && (req.word || !atWordBoundary(req.state.doc, req.pos))) return null;
      const ctx = promptContext(req.state.doc, req.pos);
      if (!ctx.prefix.trim()) return null;
      const engine = await deps.runtime(signal);
      if (!engine || signal.aborted) return null;
      const { prompt, spaceDropped } = buildPrompt(m, ctx);
      let raw: string;
      try {
        raw = await engine.complete(prompt, { signal, maxTokens: MAX_TOKENS, stops: m.stops });
      } catch {
        return null;
      }
      if (signal.aborted) return null;
      return toSuggestion(raw, ctx, spaceDropped, m);
    },
  };
}
