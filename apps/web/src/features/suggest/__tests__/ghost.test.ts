import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { autocompletion, currentCompletions, snippet, type CompletionContext } from '@codemirror/autocomplete';
import { latex } from 'codemirror-lang-latex';
import { keyChains } from '../../../editor/core/keyChains';
import { undoBoundary } from '../../../editor/visual/history';
import { headlessView, pressKey, settle, typeText, withCaret, type HeadlessView } from '../../../editor/core/__tests__/replay';
import { ghostField, nextWord, setGhost } from '../ghost';
import { askSuggestion, suggestExtension } from '../scheduler';
import { createWordProvider } from '../wordProvider';
import type { SuggestionProvider } from '../provider';
import feature from '../index';
import { settings, SUGGEST_SETTINGS } from '../settings';

vi.mock('../../../settings/store', () => ({ getSetting: () => undefined, setSetting: () => {}, subscribeSetting: () => () => {} }));

const language = latex({ autoCloseTags: false, enableLinting: false, enableAutocomplete: false, enableTooltips: false });
const TEXT = 'The measurement was careful. The measurement again.\n';

interface Setup { v: HeadlessView; boundary: ReturnType<typeof vi.fn>; nothing: ReturnType<typeof vi.fn> }

function editor(src: string, o: { extra?: Extension[]; plugins?: Extension[]; providers?: SuggestionProvider[]; synced?: boolean } = {}): Setup {
  const mark = src.indexOf('|');
  const doc = mark < 0 ? src : src.slice(0, mark) + src.slice(mark + 1);
  const boundary = vi.fn();
  const nothing = vi.fn();
  const words = createWordProvider();
  const ext = suggestExtension({ providers: () => [words, ...(o.providers ?? [])], synced: () => o.synced ?? true, nothing, debounceMs: 5 });
  const v = headlessView({
    doc,
    selection: EditorSelection.cursor(mark < 0 ? doc.length : mark),
    extensions: [language, ext, undoBoundary.of(boundary), ...(feature.editor!.keyChains ?? []).map((e) => keyChains.of(e)), ...(o.extra ?? [])],
  }, [ext, ...(o.plugins ?? [])]);
  return { v, boundary, nothing };
}

const ghost = (v: HeadlessView) => v.state.field(ghostField, false)?.text ?? null;

describe('the word ghost', () => {
  it('shows the rest of a project word after three letters', async () => {
    const { v } = editor(TEXT);
    await typeText(v, 'A me');
    expect(ghost(v)).toBeNull(); // two letters are not enough
    await typeText(v, 'a');
    expect(ghost(v)).toBe('surement');
    expect(v.state.doc.toString()).toBe(TEXT + 'A mea'); // never in the document
  });

  it('Tab inserts it as one undo step', async () => {
    const { v, boundary } = editor(TEXT);
    await typeText(v, 'A meas');
    boundary.mockClear();
    expect(await pressKey(v, 'Tab')).toBe(true);
    expect(withCaret(v)).toBe(TEXT + 'A measurement|');
    expect(ghost(v)).toBeNull();
    expect(boundary).toHaveBeenCalledTimes(2); // closed before and after the insertion
    expect(v.log[v.log.length - 1].isUserEvent('input.complete')).toBe(true);
  });

  it('Tab indents as before when no suggestion shows', async () => {
    const { v } = editor('Nothing here');
    await typeText(v, ' xy');
    expect(ghost(v)).toBeNull();
    expect(await pressKey(v, 'Tab')).toBe(false); // the core chain (indent) is not in this test editor
  });

  it('typing its next letters uses it up without asking again', async () => {
    const { v } = editor(TEXT);
    await typeText(v, 'A meas');
    expect(ghost(v)).toBe('urement');
    await typeText(v, 'ur');
    expect(ghost(v)).toBe('ement');
    await typeText(v, 'x');
    expect(ghost(v)).toBeNull();
  });

  it('Escape hides it; a caret move or another edit clears it', async () => {
    const { v } = editor(TEXT);
    await typeText(v, 'A meas');
    expect(await pressKey(v, 'Escape')).toBe(true);
    expect(ghost(v)).toBeNull();
    expect(await pressKey(v, 'Escape')).toBe(false); // nothing left: Escape goes on
    await typeText(v, 'u');
    expect(ghost(v)).toBe('rement');
    v.dispatch({ selection: { anchor: 0 }, userEvent: 'select' });
    expect(ghost(v)).toBeNull();
  });

  it('Mod-→ takes the next word', async () => {
    expect(nextWord(' the next one')).toBe(' the');
    expect(nextWord(', and')).toBe(', ');
    expect(nextWord('\\cite{x}')).toBe('\\cite');
    const { v } = editor(TEXT);
    await typeText(v, 'A meas');
    expect(await pressKey(v, 'Mod-ArrowRight')).toBe(true);
    expect(withCaret(v)).toBe(TEXT + 'A measurement|');
  });

  it('a snippet field or an open completion list keeps Tab', async () => {
    const s = editor(TEXT);
    const at = s.v.state.doc.length;
    snippet('${a} and ${b}')(s.v.asView(), null as never, at, at);
    s.v.dispatch({ effects: setGhost.of({ pos: s.v.state.selection.main.head, text: 'urement' }) });
    expect(ghost(s.v)).toBe('urement');
    expect(await pressKey(s.v, 'Tab')).toBe(false);

    // a source that answers for words: its view plugin runs here too, so the list really opens
    const source = (cx: CompletionContext) => {
      const w = cx.matchBefore(/[a-z]+/);
      return w && w.to - w.from >= 4 ? { from: w.from, options: [{ label: 'measures' }] } : null;
    };
    const list = autocompletion({ override: [source] });
    const c = editor(TEXT, { extra: [list], plugins: [list] });
    await typeText(c.v, 'A meas');
    expect(ghost(c.v)).toBe('urement'); // the query is still pending: no list yet, so the ghost shows
    await new Promise((r) => setTimeout(r, 400));
    expect(currentCompletions(c.v.state)).toHaveLength(1);
    expect(ghost(c.v)).toBeNull();
    expect(await pressKey(c.v, 'Tab')).toBe(false);
  });

  it('never in math, a key or a path', async () => {
    for (const before of ['$x + ', '\\cite{', '\\includegraphics{']) {
      const { v } = editor(TEXT + before + '|' + (before.startsWith('$') ? '$' : '}'));
      await typeText(v, 'meas');
      expect(ghost(v), before).toBeNull();
    }
  });

  it('a collaborator\'s edit never asks, and clears it only on the caret\'s line', async () => {
    const { v } = editor(TEXT);
    v.dispatch({ changes: { from: 0, insert: 'The meas' } }); // remote: no user event
    await settle();
    expect(ghost(v)).toBeNull();
    v.dispatch({ changes: { from: 0, to: 8 } });
    await typeText(v, 'A meas');
    expect(ghost(v)).toBe('urement');
    v.dispatch({ changes: { from: 0, insert: 'Elsewhere. ' } }); // another line: kept, moved
    expect(ghost(v)).toBe('urement');
    expect(v.state.field(ghostField)!.pos).toBe(v.state.selection.main.head);
    const line = v.state.doc.lineAt(v.state.selection.main.head);
    v.dispatch({ changes: { from: line.from, insert: 'X' } }); // the caret's line: cleared
    expect(ghost(v)).toBeNull();
  });

  it('nothing with several cursors, read-only, or before the first sync', async () => {
    const multi = editor(TEXT, { extra: [EditorState.allowMultipleSelections.of(true)] });
    await typeText(multi.v, 'A mea');
    expect(ghost(multi.v)).toBe('surement');
    multi.v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(multi.v.state.doc.length)], 1) });
    await typeText(multi.v, 's');
    expect(ghost(multi.v)).toBeNull();

    const ro = editor(TEXT, { extra: [EditorState.readOnly.of(true)] });
    await typeText(ro.v, 'A meas');
    expect(ghost(ro.v)).toBeNull();

    const early = editor(TEXT, { synced: false });
    await typeText(early.v, 'A meas');
    expect(ghost(early.v)).toBeNull();
  });

  it('asks on request, with relaxed thresholds, and says when there is nothing', async () => {
    const { v, nothing } = editor('A mechanism here. me|');
    v.dispatch({ effects: askSuggestion.of(null) });
    await settle();
    expect(ghost(v)).toBe('chanism');
    const empty = editor('Nothing at all. qz|');
    empty.v.dispatch({ effects: askSuggestion.of(null) });
    await settle();
    expect(ghost(empty.v)).toBeNull();
    expect(empty.nothing).toHaveBeenCalled();
    expect(nothing).not.toHaveBeenCalled();
  });

  it('a deferred provider answers after the debounce, and a keystroke aborts it', async () => {
    let aborted = 0;
    let asked = 0;
    const model: SuggestionProvider = {
      id: 'model',
      deferred: true,
      suggest: (_req, signal) => new Promise((resolve) => {
        asked++;
        const t = setTimeout(() => resolve(' and more'), 40);
        signal.addEventListener('abort', () => { clearTimeout(t); aborted++; resolve(null); });
      }),
    };
    const { v } = editor('Start', { providers: [model] });
    await typeText(v, ' ok');
    expect(asked).toBe(0); // debounced
    await new Promise((r) => setTimeout(r, 15));
    expect(asked).toBe(1);
    await typeText(v, 'a'); // aborts the question in flight
    expect(aborted).toBe(1);
    expect(ghost(v)).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(ghost(v)).toBe(' and more');
    expect(v.state.field(ghostField)!.pos).toBe(v.state.doc.length);
    expect(v.state.doc.toString()).toBe('Start oka');
  });
});

describe('the setting', () => {
  it('is one automatic switch, on by default, in Completion', () => {
    expect(settings.map((d) => d.id)).toEqual([SUGGEST_SETTINGS.words, 'suggest.model']); // Galley: V2 (WP43) adds the model's row
    const def = settings[0];
    expect(def.id).toBe(SUGGEST_SETTINGS.words);
    expect(def.default).toBe(true);
    expect(def.automatic).toBe(true);
    expect(def.section).toBe('completion');
    expect(def.control).toEqual({ kind: 'switch' });
  });

  it('turned off, the editor gets nothing but inert key chains', () => {
    const ctx = { setting: () => false } as never;
    expect(feature.editor!.extension!(ctx)).toEqual([]);
    expect(feature.editor!.modes).toEqual(['source']);
  });
});
