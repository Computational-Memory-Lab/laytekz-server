import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState, Text, type StateEffect } from '@codemirror/state';
import { EditorView, gutterLineClass } from '@codemirror/view';
import { foldState, indentUnit } from '@codemirror/language';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>(), broken: false }));
vi.mock('../../../settings/store', () => ({
  getSetting: (id: string) => {
    if (store.broken) throw new Error('Not implemented yet: settings/store getSetting');
    return store.values.has(id) ? store.values.get(id) : undefined;
  },
  subscribeSetting: () => {
    if (store.broken) throw new Error('Not implemented yet: settings/store subscribeSetting');
    return () => {};
  },
}));

import {
  EDITOR_SETTING_IDS, EditorSettingsSlots, detectIndent, indentUnitFor, readEditorSettings, readSetting, watchSettings,
  type EditorSettingValues,
} from '../editorSettings';
import { EDITOR_SETTINGS } from '../editorSettingDefs';
import { SETTINGS, REGISTRY_PROBLEMS } from '../../../settings/registry';
import { PREF_KEY_RE } from '../../../settings/types';

const V1: EditorSettingValues = {
  lineNumbers: true, foldGutter: true, activeLine: true, whitespace: false, indent: '2', wrap: true, wrapIndent: true, completion: 'typing',
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store.values.clear();
  store.broken = false;
});

describe('the editor setting definitions', () => {
  it('are registered without problems, as account preferences, defaulting to the V1 editor', () => {
    expect(REGISTRY_PROBLEMS.filter((p) => p.includes('editorSettingDefs'))).toEqual([]);
    for (const def of EDITOR_SETTINGS) {
      expect(SETTINGS.get(def.id)).toBe(def);
      expect(def.scope).toBe('account');
      expect(def.id).toMatch(PREF_KEY_RE);
      expect(def.validate(def.default)).toBe(true);
      expect(def.automatic).toBeFalsy();
    }
    expect(Object.values(EDITOR_SETTING_IDS).sort()).toEqual(EDITOR_SETTINGS.map((d) => d.id).sort());
    store.broken = true;
    expect(readEditorSettings()).toEqual(V1);
  });

  it('validate what they are given', () => {
    const indent = SETTINGS.get(EDITOR_SETTING_IDS.indent)!;
    expect(['detect', '2', '4', 'tab'].every((v) => indent.validate(v))).toBe(true);
    expect(indent.validate(2)).toBe(false);
    expect(SETTINGS.get(EDITOR_SETTING_IDS.wrap)!.validate('true')).toBe(false);
    expect(SETTINGS.get(EDITOR_SETTING_IDS.completion)!.validate('always')).toBe(false);
  });
});

describe('reading settings', () => {
  it('takes the store\'s value, and the default for a value the definition refuses or while the store throws', () => {
    store.values.set(EDITOR_SETTING_IDS.wrap, false);
    expect(readSetting(EDITOR_SETTING_IDS.wrap)).toBe(false);
    store.values.set(EDITOR_SETTING_IDS.wrap, 'no');
    expect(readSetting(EDITOR_SETTING_IDS.wrap)).toBe(true);
    store.broken = true;
    expect(readSetting(EDITOR_SETTING_IDS.indent)).toBe('2');
    expect(readSetting('nobody.knows')).toBeUndefined();
  });

  it('watches nothing while the store cannot', () => {
    store.broken = true;
    const off = watchSettings([EDITOR_SETTING_IDS.wrap], () => {});
    expect(() => off()).not.toThrow();
  });
});

describe('detecting a file\'s indentation', () => {
  const doc = (lines: string[]) => lines.join('\n');

  it('finds two spaces, four spaces and tabs', () => {
    expect(detectIndent(doc(['\\begin{itemize}', '  \\item a', '  \\begin{enumerate}', '    \\item b', '  \\end{enumerate}', '\\end{itemize}']))).toBe('  ');
    expect(detectIndent(doc(['\\begin{itemize}', '    \\item a', '    \\begin{enumerate}', '        \\item b', '    \\end{enumerate}', '\\end{itemize}']))).toBe('    ');
    expect(detectIndent(doc(['\\begin{itemize}', '\t\\item a', '\t\\item b', '\\end{itemize}']))).toBe('\t');
    expect(detectIndent(Text.of(['a', '    b', '    c', 'd']))).toBe('    ');
  });

  it('says nothing for a file with too little indentation to go by', () => {
    expect(detectIndent('')).toBeNull();
    expect(detectIndent(doc(['\\section{A}', 'Text.', '', 'More text.']))).toBeNull();
    expect(detectIndent(doc(['Text', '  one line']))).toBeNull();
  });

  it('ignores blank lines between indented ones', () => {
    expect(detectIndent(doc(['a', '    b', '', '    c', '        d', '    e']))).toBe('    ');
  });

  it('maps the choice to a unit, leaving two spaces to CodeMirror as V1 did', () => {
    const four = doc(['a', '    b', '    c', '        d']);
    expect(indentUnitFor('2', four)).toBeNull();
    expect(indentUnitFor('4', null)).toBe('    ');
    expect(indentUnitFor('tab', null)).toBe('\t');
    expect(indentUnitFor('detect', four)).toBe('    ');
    expect(indentUnitFor('detect', doc(['a', '  b', '  c', '    d']))).toBeNull();
    expect(indentUnitFor('detect', null)).toBeNull();
  });
});

describe('the settings compartments', () => {
  function editor(values: EditorSettingValues, mode: 'source' | 'visual' = 'source', doc: string | null = null) {
    const slots = new EditorSettingsSlots(values, mode, doc);
    let state = EditorState.create({
      doc: doc ?? '',
      extensions: [
        slots.slot('numbers'), slots.slot('activeLineGutter'), slots.slot('whitespace'), slots.slot('fold'),
        slots.slot('activeLine'), slots.slot('wrap'), slots.slot('indent'), mode === 'source' ? slots.sourceMode() : [],
      ],
    });
    return {
      slots,
      get state() { return state; },
      apply(effects: StateEffect<unknown>[]) { state = state.update({ effects }).state; return effects.length; },
    };
  }
  const wraps = (s: EditorState) => s.facet(EditorView.contentAttributes).some((a) => (typeof a === 'function' ? null : a)?.class === 'cm-lineWrapping');

  it('holds the V1 editor with the defaults', () => {
    const t = editor(V1);
    expect(wraps(t.state)).toBe(true);
    expect(t.state.facet(indentUnit)).toBe('  ');
    expect(t.state.field(foldState, false)).toBeDefined();
    expect(t.state.facet(gutterLineClass).length).toBe(1);
  });

  it('reconfigures only the compartments whose value changed', () => {
    const t = editor(V1);
    expect(t.apply(t.slots.update({ values: { ...V1 } }))).toBe(0);
    expect(t.apply(t.slots.update({ values: { ...V1, wrap: false } }))).toBe(2); // wrapping and the wrapped-line indent
    expect(wraps(t.state)).toBe(false);
    expect(t.apply(t.slots.update({ values: { ...V1, wrap: false, indent: '4' } }))).toBe(1);
    expect(t.state.facet(indentUnit)).toBe('    ');
    expect(t.apply(t.slots.update({ values: { ...V1, wrap: false, indent: 'tab', activeLine: false, foldGutter: false } }))).toBe(4);
    expect(t.state.facet(indentUnit)).toBe('\t');
    expect(t.state.field(foldState, false)).toBeUndefined();
    expect(t.state.facet(gutterLineClass).length).toBe(0);
  });

  it('always wraps in Visual mode, and leaves the wrapped-line indent to the Source content', () => {
    const t = editor({ ...V1, wrap: false });
    expect(wraps(t.state)).toBe(false);
    expect(t.apply(t.slots.update({ mode: 'visual' }))).toBe(1);
    expect(wraps(t.state)).toBe(true);
    expect(t.apply(t.slots.update({ values: { ...V1, wrap: false, wrapIndent: false } }))).toBe(0);
    expect(t.apply(t.slots.update({ mode: 'source' }))).toBe(1);
    expect(wraps(t.state)).toBe(false);
  });

  it('detects the indentation once the text is there', () => {
    const t = editor({ ...V1, indent: 'detect' });
    expect(t.state.facet(indentUnit)).toBe('  ');
    expect(t.apply(t.slots.update({ doc: Text.of(['a', '\tb', '\tc', 'd']) }))).toBe(1);
    expect(t.state.facet(indentUnit)).toBe('\t');
    expect(t.apply(t.slots.update({ doc: Text.of(['a', '\tb', '\tc', 'd', 'e']) }))).toBe(0);
  });
});
