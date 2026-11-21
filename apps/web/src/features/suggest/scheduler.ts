/**
 * When to ask for a suggestion (WP40). Only after a local typed character (a
 * collaborator's edit, an undo, a paste or an agent's write never asks) or
 * the "Ask for a suggestion" key. Synchronous providers (the word ghost)
 * answer at once, in a microtask after the keystroke; promised answers (a
 * model, WP43) are asked for after a debounce and aborted by the next
 * keystroke or caret move. Never with a selection, several cursors, a
 * read-only or unsynced document, during composition, outside Vim's insert
 * mode, while a completion list or snippet field is active, or outside prose.
 */
import { Facet, StateEffect, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { hasNextSnippetField } from '@codemirror/autocomplete';
import { completionListOpen, ghostExtension, ghostField, setGhost } from './ghost';
import { canSuggestAt } from './promptContext';
import { typedWordAt } from './wordProvider';
import type { SuggestionProvider } from './provider';

export interface SuggestConfig {
  /** Asked in order; the first answer wins. */
  providers(): readonly SuggestionProvider[];
  /** The document has its first sync (the editor's load gate). */
  synced(): boolean;
  /** Told when an asked-for suggestion found nothing. */
  nothing?(): void;
  /** Debounce for promised answers, in ms (default 250). */
  debounceMs?: number;
}

export const suggestConfig = Facet.define<SuggestConfig, SuggestConfig | null>({ combine: (v) => v[v.length - 1] ?? null });

/** Asks for a suggestion now (the "Ask for a suggestion" command). */
export const askSuggestion = StateEffect.define<null>();

/** Vim (when on) is outside insert mode: no suggestions then. Read from the view, so Vim's chunk is never loaded here. */
function vimNotInserting(view: EditorView): boolean {
  const vim = (view as unknown as { cm?: { state?: { vim?: { insertMode?: boolean } } } }).cm?.state?.vim;
  return !!vim && !vim.insertMode;
}

/** Whether the caret may get a suggestion now; the caret position when it may. */
export function suggestionSpot(view: EditorView, config: SuggestConfig): number | null {
  const state: EditorState = view.state;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  if (state.readOnly || view.composing || !config.synced() || vimNotInserting(view)) return null;
  if (completionListOpen(state) || hasNextSnippetField(state)) return null;
  return sel.main.head;
}

class Scheduler implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private destroyed = false;

  constructor(private readonly view: EditorView) {}

  update(u: ViewUpdate) {
    const asked = u.transactions.some((tr) => tr.effects.some((e) => e.is(askSuggestion)));
    if (u.docChanged || u.selectionSet || asked) this.cancel();
    const typed = u.docChanged && u.transactions.some((tr) => tr.isUserEvent('input.type') && !tr.isUserEvent('input.type.compose'));
    if (!typed && !asked) return;
    if (typed && !asked) {
      // typing the suggestion's next characters keeps the rest without asking again
      const before = u.startState.field(ghostField, false);
      const after = u.state.field(ghostField, false);
      if (before && after && after.pos > before.pos) return;
    }
    const doc = u.state.doc;
    queueMicrotask(() => {
      if (!this.destroyed && this.view.state.doc === doc) this.request(asked);
    });
  }

  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
  }

  private show(pos: number, text: string | null): boolean {
    if (!text || this.destroyed) return false;
    const sel = this.view.state.selection.main;
    if (!sel.empty || sel.head !== pos) return false;
    this.view.dispatch({ effects: setGhost.of({ pos, text }) });
    return true;
  }

  request(explicit: boolean): void {
    const config = this.view.state.facet(suggestConfig);
    if (!config) return;
    const providers = config.providers();
    const later = providers.filter((p) => p.deferred);
    const pos = suggestionSpot(this.view, config);
    const state = this.view.state;
    const word = pos == null ? null : typedWordAt(state, pos);
    if (pos == null || (!word && !later.length) || !canSuggestAt(state, pos)) {
      if (explicit) config.nothing?.();
      return;
    }
    const req = { state, pos, word: word?.word ?? '', explicit };
    for (const p of providers) {
      if (p.deferred) continue;
      let answer: string | null | Promise<string | null>;
      try {
        answer = p.suggest(req, new AbortController().signal);
      } catch (err) {
        console.warn(`[suggest] ${p.id} failed`, err);
        continue;
      }
      if (typeof answer === 'string' && this.show(pos, answer)) return;
    }
    if (!later.length) {
      if (explicit) config.nothing?.();
      return;
    }
    const doc = state.doc;
    const abort = (this.abort = new AbortController());
    this.timer = setTimeout(async () => {
      this.timer = null;
      for (const p of later) {
        if (abort.signal.aborted) return;
        let text: string | null = null;
        try {
          text = await p.suggest(req, abort.signal);
        } catch {
          text = null;
        }
        if (abort.signal.aborted || this.view.state.doc !== doc) return;
        if (this.show(pos, text)) return;
      }
      if (explicit) config.nothing?.();
    }, explicit ? 0 : config.debounceMs ?? 250);
  }

  destroy() {
    this.destroyed = true;
    this.cancel();
  }
}

export const suggestScheduler = ViewPlugin.fromClass(Scheduler);

/** Everything inline suggestions need in one editor. */
export function suggestExtension(config: SuggestConfig): Extension {
  return [suggestConfig.of(config), ghostExtension(), suggestScheduler];
}
