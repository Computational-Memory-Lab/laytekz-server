import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import probe from '../_probe';
import { settings as probeSettings } from '../_probe/settings';
import { commandAllowed, createEditorPageCtx, type PageCtxSource } from '../pageCtx';
import type { SlotId } from '../../slots/types';
import type { TypedInput } from '../../editor/core/types';

afterEach(() => { vi.restoreAllMocks(); });

const ALL_SLOTS: SlotId[] = [
  'toolbar.main', 'editor.status', 'editor.tools', 'editor.banners', 'pdf.status', 'pdf.actions', 'pdf.overlay',
  'files.footer', 'sidebar.panels', 'editor.overlay', 'home.toolbar', 'home.accountMenu', 'phone.moreSheet',
];

/** One keystroke typed at the end of `text`. */
function typed(text: string, char: string): TypedInput {
  const before = EditorState.create({ doc: text, selection: { anchor: text.length } });
  const after = before.update({ changes: { from: text.length, insert: char }, selection: { anchor: text.length + 1 } }).state;
  return { char, from: text.length, to: text.length, before, after };
}

const fakeView = (doc: string, head = 0) => ({ state: EditorState.create({ doc, selection: { anchor: head } }), dispatch: vi.fn() }) as unknown as EditorView & { dispatch: ReturnType<typeof vi.fn> };

describe('the e2e probe', () => {
  it('puts an item in every slot, after the real ones, and a pinned and an unpinned panel', () => {
    const slots = probe.slots ?? [];
    expect(new Set(slots.map((s) => s.slot))).toEqual(new Set(ALL_SLOTS));
    expect(slots.every((s) => s.order >= 10_000)).toBe(true);
    const panels = slots.filter((s) => s.slot === 'sidebar.panels');
    expect(panels.map((p) => !!p.panel?.pinned)).toEqual([true, false]);
    expect(slots.every((s) => s.id.startsWith('_probe.'))).toBe(true);
  });

  it('contributes to every extension point the module type has', () => {
    for (const key of ['editor', 'commands', 'keybindings', 'slots', 'contextMenu', 'pdfContextMenu', 'pinnedPanels', 'readOnlyRules', 'interceptors', 'activate', 'boot'] as const) {
      expect(probe[key], key).toBeTruthy();
    }
    const e = probe.editor!;
    for (const key of ['extension', 'keyChains', 'modClick', 'autoEditRules', 'completionSources', 'completionFilter', 'afterFormat'] as const) {
      expect(e[key], key).toBeTruthy();
    }
  });

  it('has an unbound page keybinding for its command, which viewers and showcases do not get', () => {
    expect(probe.keybindings).toEqual([expect.objectContaining({ id: '_probe.hello', default: null, scope: 'page', command: '_probe.hello' })]);
    const page = createEditorPageCtx('p', 'main', () => ({ toast: vi.fn() }) as unknown as PageCtxSource);
    const [cmd] = probe.commands!(page);
    expect(cmd.id).toBe('_probe.hello');
    expect(commandAllowed(cmd, { showcase: false, viewer: false }, page)).toBe(true);
    expect(commandAllowed(cmd, { showcase: false, viewer: true }, page)).toBe(false);
    expect(commandAllowed(cmd, { showcase: true, viewer: false }, page)).toBe(false);
  });

  it('makes %probe-> into %probe→ in one edit, and leaves everything else alone', () => {
    const [rule] = probe.editor!.autoEditRules!;
    expect(rule.settingId).toBe('_probe.autoEdit');
    const t = typed('x %probe-', '>');
    const edit = rule.run(t)!;
    const after = t.after.update({ changes: edit.changes, selection: edit.selection }).state;
    expect(after.doc.toString()).toBe('x %probe→');
    expect(after.selection.main.head).toBe('x %probe→'.length);
    expect(rule.run(typed('a->', '>'))).toBeNull();
    expect(rule.run(typed('%probe-', '<'))).toBeNull();
    expect(rule.run(typed('', '>'))).toBeNull();
  });

  it('offers \\probecompletion after \\probec', () => {
    const source = probe.editor!.completionSources![0]({} as never);
    const state = EditorState.create({ doc: 'see \\probec' });
    const r = source(new CompletionContext(state, state.doc.length, false));
    expect(r && 'options' in r ? r.options.map((o) => o.label) : r).toEqual(['\\probecompletion']);
    const none = EditorState.create({ doc: 'see \\section' });
    expect(source(new CompletionContext(none, none.doc.length, false))).toBeNull();
  });

  it('follows \\probelink with mod-click, and nothing else', () => {
    const [h] = probe.editor!.modClick!;
    const view = fakeView('see \\probelink here');
    expect(h.target(view, 7)).toEqual({ from: 4, to: 14, title: 'Follow the probe link' });
    expect(h.target(view, 1)).toBeNull();
    expect(h.target(fakeView('plain text'), 3)).toBeNull();
  });

  it('answers Mod-ArrowRight only on a %probe-chain line', () => {
    const [chain] = probe.editor!.keyChains!;
    expect(chain.key).toBe('Mod-ArrowRight');
    const on = fakeView('%probe-chain', 3);
    expect(chain.run(on)).toBe(true);
    expect(on.dispatch).toHaveBeenCalledWith(expect.objectContaining({ changes: { from: 12, insert: ' ok' } }));
    const off = fakeView('%probe-chain then', 3);
    expect(chain.run(off)).toBe(false);
    expect(off.dispatch).not.toHaveBeenCalled();
  });

  it('makes probe-readonly.tex read-only and takes over renames to *.probe-intercept', async () => {
    const page = createEditorPageCtx('p', 'main', () => ({ toast: vi.fn() }) as unknown as PageCtxSource);
    const [rule] = probe.readOnlyRules!;
    expect(rule.reason('sub/probe-readonly.tex', page)).toBe('Probe: this file is read-only.');
    expect(rule.reason('probe-readonly.tex.bak', page)).toBeNull();
    expect(await probe.interceptors!.fileRename!({ from: 'a.tex', to: 'a.probe-intercept', via: 'tree' }, page)).toBe('handled');
    expect(await probe.interceptors!.fileRename!({ from: 'a.tex', to: 'b.tex', via: 'tree' }, page)).toBe('default');
    expect(await probe.interceptors!.projectRename!({ from: 'A', to: 'Probe intercept' }, null)).toBe('handled');
    expect(await probe.interceptors!.projectRename!({ from: 'A', to: 'B' }, null)).toBe('default');
  });

  it('keeps its one setting on the device and off the settings page', () => {
    expect(probeSettings).toEqual([expect.objectContaining({ id: '_probe.autoEdit', scope: 'device', default: true })]);
    // not `automatic`: the off-switch audit is for what a user can turn on
    expect(probeSettings[0].automatic).toBeFalsy();
    expect(probeSettings[0].visible!({} as never)).toBe(false);
  });
});
