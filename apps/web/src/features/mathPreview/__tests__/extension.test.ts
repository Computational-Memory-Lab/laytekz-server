import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { showTooltip, type EditorView } from '@codemirror/view';
import { at, inDoc } from '../../../editor/texContext/__tests__/helpers';
import { DEFAULT_PREVIEW_OPTIONS, caretPreviewField, closePreview, mathPreviewExtension, pinPreview, previewPinned } from '../extension';
import feature from '../index';
import type { EditorFeatureCtx } from '../../types';

const SRC = inDoc('Text $x^2$ and \\[ \\frac{a}{b} \\] end.');
const inInline = SRC.indexOf('x^2') + 1;
const inDisplay = SRC.indexOf('\\frac') + 3;
const outside = SRC.indexOf('Text') + 2;

/** Enough of an EditorView for the commands: the state and dispatch. */
function fakeView(state: EditorState) {
  const v = {
    state,
    dispatch(spec: TransactionSpec) { v.state = v.state.update(spec).state; },
  };
  return v as unknown as EditorView & { state: EditorState };
}

function setup(ext: Extension, caret = inInline) {
  const { state } = at(SRC, [ext]);
  return fakeView(state.update({ selection: EditorSelection.cursor(caret) }).state);
}

const tips = (s: EditorState) => s.facet(showTooltip).filter(Boolean);
const move = (v: EditorView, pos: number) => v.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select' });

describe('the caret preview (setting on)', () => {
  const ext = mathPreviewExtension({ ...DEFAULT_PREVIEW_OPTIONS, caret: true });

  it('shows one tooltip inside a formula and none outside', () => {
    const v = setup(ext);
    expect(tips(v.state)).toHaveLength(1);
    expect(tips(v.state)[0]!.pos).toBe(SRC.indexOf('$x^2$'));
    move(v, outside);
    expect(tips(v.state)).toHaveLength(0);
    move(v, inDisplay);
    expect(tips(v.state)).toHaveLength(1);
  });

  it('follows typing inside the formula, and leaves the document to the typist', () => {
    const v = setup(ext);
    const before = v.state.doc.toString();
    v.dispatch({ changes: { from: inInline + 2, insert: '+y' }, selection: EditorSelection.cursor(inInline + 4), userEvent: 'input.type' });
    expect(v.state.field(caretPreviewField).target?.source).toBe('x^2+y');
    expect(v.state.doc.toString()).toBe(before.slice(0, inInline + 2) + '+y' + before.slice(inInline + 2));
  });

  it('Escape closes it until the caret leaves the formula', () => {
    const v = setup(ext);
    expect(closePreview(v)).toBe(true);
    expect(tips(v.state)).toHaveLength(0);
    move(v, inInline + 1);
    expect(tips(v.state), 'still in the same formula').toHaveLength(0);
    move(v, outside);
    move(v, inInline);
    expect(tips(v.state), 'back after leaving').toHaveLength(1);
    move(v, outside);
    expect(closePreview(v), 'nothing open: the key goes on').toBe(false);
  });

  it('a collaborator\'s edit elsewhere keeps it, and never makes a change of its own', () => {
    const v = setup(ext);
    const at0 = v.state.field(caretPreviewField).target!.from;
    v.dispatch({ changes: { from: 0, insert: '% hi\n' } }); // a remote change: no user event
    expect(v.state.field(caretPreviewField).target?.from).toBe(at0 + 5);
    expect(v.state.doc.toString().startsWith('% hi\n')).toBe(true);
  });
});

describe('the pinned preview (caret setting off)', () => {
  const ext = mathPreviewExtension(DEFAULT_PREVIEW_OPTIONS);

  it('opens only on the command, follows the caret within the formula and closes when it leaves', () => {
    const v = setup(ext);
    expect(tips(v.state)).toHaveLength(0);
    expect(pinPreview(v)).toBe(true);
    expect(previewPinned(v.state)).toBe(true);
    expect(tips(v.state)).toHaveLength(1);
    v.dispatch({ changes: { from: inInline + 2, insert: 'z' }, selection: EditorSelection.cursor(inInline + 3), userEvent: 'input.type' });
    expect(v.state.field(caretPreviewField).target?.source).toBe('x^2z');
    move(v, outside);
    expect(tips(v.state)).toHaveLength(0);
    move(v, inInline);
    expect(tips(v.state), 'a pin ends when the caret leaves').toHaveLength(0);
  });

  it('Escape or the command again closes it; outside a formula the command declines', () => {
    const v = setup(ext);
    pinPreview(v);
    expect(closePreview(v)).toBe(true);
    expect(tips(v.state)).toHaveLength(0);
    pinPreview(v);
    expect(pinPreview(v)).toBe(true);
    expect(previewPinned(v.state)).toBe(false);
    move(v, outside);
    expect(pinPreview(v)).toBe(false);
  });
});

describe('the feature module', () => {
  const ctx = (values: Record<string, unknown>) => ({
    projectId: 'p', branch: 'main', filePath: 'main.tex', rootFile: 'main.tex',
    setting: <T>(id: string) => values[id] as T,
  }) as unknown as EditorFeatureCtx;

  it('installs nothing when the main switch is off', () => {
    expect(feature.editor!.extension!(ctx({ 'mathPreview.hover': false }))).toEqual([]);
  });

  it('installs the preview when on, rebuilt by its own settings only', () => {
    const ext = feature.editor!.extension!(ctx({ 'mathPreview.hover': true, 'mathPreview.caret': true, 'mathPreview.delay': 150 }));
    const { state } = at(SRC, [ext]);
    expect(state.field(caretPreviewField, false)).toBeTruthy();
    expect(feature.editor!.deps).toEqual(expect.arrayContaining(['mathPreview.hover', 'mathPreview.caret', 'mathPreview.delay']));
    expect(feature.keybindings![0]).toMatchObject({ id: 'mathPreview.pin', default: null, scope: 'editor' });
  });
});
