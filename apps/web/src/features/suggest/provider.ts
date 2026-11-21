/**
 * Inline suggestions (WP40): what a suggestion provider is. The word provider
 * (wordProvider.ts) is always there; a model provider (WP43, gated) registers
 * itself with `registerSuggestionProvider` and is asked after it.
 */
import type { EditorState } from '@codemirror/state';

export interface SuggestRequest {
  state: EditorState;
  /** The caret. */
  pos: number;
  /** The letters of the word the caret ends ('' at a word boundary). */
  word: string;
  /** Asked for with the "Ask for a suggestion" key: thresholds may be relaxed. */
  explicit: boolean;
}

export interface SuggestionProvider {
  id: string;
  /**
   * False (the default): `suggest` answers synchronously, right after the
   * keystroke. True: it is asked only after the debounce, may return a
   * promise, and is aborted (`signal`) by the next keystroke or caret move.
   */
  deferred?: boolean;
  /** The text to show after the caret, or null for none. */
  suggest(req: SuggestRequest, signal: AbortSignal): string | null | Promise<string | null>;
}

const registered: SuggestionProvider[] = [];

/** Adds a provider asked after the word provider; returns the removal. */
export function registerSuggestionProvider(p: SuggestionProvider): () => void {
  registered.push(p);
  return () => {
    const i = registered.indexOf(p);
    if (i >= 0) registered.splice(i, 1);
  };
}

/** The registered providers, in registration order. */
export function suggestionProviders(): readonly SuggestionProvider[] {
  return registered;
}
