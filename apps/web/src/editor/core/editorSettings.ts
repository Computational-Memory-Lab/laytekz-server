/**
 * The code editor's settings as extensions (WP05 editor-host): gutters, the
 * active line, whitespace, indentation, wrapping. Each sits in a compartment
 * of its own at the place CodePane always had it, so a change reconfigures it
 * in place (never a remount) and the order of the gutters and of everything
 * between them is the V1 editor's. The definitions are editorSettingDefs.ts.
 */
import { Compartment, type Extension, type StateEffect, type Text } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, highlightWhitespace, lineNumbers } from '@codemirror/view';
import { foldGutter, indentUnit } from '@codemirror/language';
import { wrapIndent } from '../wrapIndent';
import { getSetting, subscribeSetting } from '../../settings/store';
import { settingDef } from '../../settings/registry';
import { EDITOR_SETTING_IDS, type CompletionActivation, type IndentChoice } from './editorSettingDefs';
import type { EditorMode } from '../../components/CodePane';

export { EDITOR_SETTING_IDS };
export type { CompletionActivation, IndentChoice };

const warned = new Set<string>();
function warnOnce(what: string, err: unknown): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[editor] ${what} is unavailable; using the defaults`, err);
}

/**
 * A setting's value from the settings store, checked against its definition;
 * the definition's default while the store cannot answer (a value it does
 * not know, or no store yet).
 */
export function readSetting<T>(id: string): T {
  const def = settingDef(id);
  try {
    const v = getSetting<T>(id);
    if (!def || def.validate(v)) return v;
  } catch (err) {
    warnOnce('the settings store', err);
  }
  return def?.default as T;
}

/** Calls `fn` after any of `ids` changes; a no-op while the store cannot tell. */
export function watchSettings(ids: readonly string[], fn: () => void): () => void {
  if (!ids.length) return () => {};
  try {
    return subscribeSetting([...ids], fn);
  } catch (err) {
    warnOnce('live settings', err);
    return () => {};
  }
}

export interface EditorSettingValues {
  lineNumbers: boolean;
  foldGutter: boolean;
  activeLine: boolean;
  whitespace: boolean;
  indent: IndentChoice;
  wrap: boolean;
  wrapIndent: boolean;
  completion: CompletionActivation;
}

/** Every editor setting, as `read` has it. */
export function readEditorSettings(read: <T>(id: string) => T = readSetting): EditorSettingValues {
  const I = EDITOR_SETTING_IDS;
  return {
    lineNumbers: read<boolean>(I.lineNumbers),
    foldGutter: read<boolean>(I.foldGutter),
    activeLine: read<boolean>(I.activeLine),
    whitespace: read<boolean>(I.whitespace),
    indent: read<IndentChoice>(I.indent),
    wrap: read<boolean>(I.wrap),
    wrapIndent: read<boolean>(I.wrapIndent),
    completion: read<CompletionActivation>(I.completion),
  };
}

/** The ids CodePane watches for this module. */
export const EDITOR_SETTING_ID_LIST: readonly string[] = Object.values(EDITOR_SETTING_IDS);

/** Lines read to detect a file's indentation. */
const DETECT_LINES = 2000;

/**
 * The unit a file indents with, from the leading whitespace of its lines:
 * '\t' when most indented lines start with a tab, else the commonest step
 * between the indentation of consecutive lines (2 to 8 spaces). null when
 * the file has too few indented lines to tell.
 */
export function detectIndent(doc: Text | string): string | null {
  const lines: string[] = [];
  if (typeof doc === 'string') {
    for (const l of doc.split('\n', DETECT_LINES)) lines.push(l);
  } else {
    const iter = doc.iterLines(1, Math.min(doc.lines, DETECT_LINES) + 1);
    for (let r = iter.next(); !r.done; r = iter.next()) lines.push(r.value);
  }
  let tabbed = 0, spaced = 0, prev = 0;
  const steps = new Map<number, number>();
  for (const line of lines) {
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.length === line.length) continue; // blank: says nothing, keeps the level
    if (lead.startsWith('\t')) { tabbed++; prev = -1; continue; }
    if (lead.includes('\t')) { prev = -1; continue; }
    const n = lead.length;
    if (n) spaced++;
    if (prev >= 0 && n !== prev) {
      const d = Math.abs(n - prev);
      if (d >= 2 && d <= 8) steps.set(d, (steps.get(d) ?? 0) + 1);
    }
    prev = n;
  }
  if (tabbed >= 2 && tabbed > spaced) return '\t';
  if (spaced < 2 || !steps.size) return null;
  let best = 0, count = 0;
  for (const [d, c] of steps) if (c > count || (c === count && d < best)) { best = d; count = c; }
  return ' '.repeat(best);
}

/** The indent unit for `choice`; null leaves CodeMirror's own (two spaces), as V1 did. */
export function indentUnitFor(choice: IndentChoice, doc: Text | string | null): string | null {
  switch (choice) {
    case '4': return '    ';
    case 'tab': return '\t';
    case 'detect': {
      const unit = doc == null ? null : detectIndent(doc);
      return unit === '  ' ? null : unit;
    }
    default: return null;
  }
}

type Slot = 'numbers' | 'activeLineGutter' | 'whitespace' | 'fold' | 'activeLine' | 'wrap' | 'wrapIndent' | 'indent';

/**
 * The settings' compartments. CodePane puts each `slot()` where V1 had the
 * extension (numbers: lineNumbers(), activeLineGutter, whitespace beside
 * highlightSpecialChars, fold: foldGutter(), activeLine, wrap:
 * EditorView.lineWrapping, indent anywhere) and `sourceMode()` as the mode
 * compartment's Source content (V1's wrapIndent there).
 */
export class EditorSettingsSlots {
  private readonly comps = new Map<Slot, Compartment>();
  private readonly keys = new Map<Slot, string>();
  private values: EditorSettingValues;
  private mode: EditorMode;
  private doc: Text | string | null;

  constructor(values: EditorSettingValues, mode: EditorMode, doc: Text | string | null = null) {
    this.values = values;
    this.mode = mode;
    this.doc = doc;
    for (const s of ['numbers', 'activeLineGutter', 'whitespace', 'fold', 'activeLine', 'wrap', 'wrapIndent', 'indent'] as const) {
      this.comps.set(s, new Compartment());
      this.keys.set(s, this.key(s));
    }
  }

  get current(): EditorSettingValues { return this.values; }

  /** What decides each slot's content: a slot is reconfigured only when its key changes. */
  private key(s: Slot): string {
    const v = this.values;
    switch (s) {
      case 'numbers': return String(v.lineNumbers);
      case 'activeLineGutter': case 'activeLine': return String(v.activeLine);
      case 'whitespace': return String(v.whitespace);
      case 'fold': return String(v.foldGutter);
      case 'wrap': return String(this.mode === 'visual' || v.wrap);
      case 'wrapIndent': return String(v.wrap && v.wrapIndent);
      case 'indent': return JSON.stringify(indentUnitFor(v.indent, this.doc));
    }
  }

  private content(s: Slot): Extension {
    const v = this.values;
    switch (s) {
      case 'numbers': return v.lineNumbers ? lineNumbers() : [];
      case 'activeLineGutter': return v.activeLine ? highlightActiveLineGutter() : [];
      case 'whitespace': return v.whitespace ? highlightWhitespace() : [];
      case 'fold': return v.foldGutter ? foldGutter() : [];
      case 'activeLine': return v.activeLine ? highlightActiveLine() : [];
      // Visual always wraps: its layout is built for it.
      case 'wrap': return this.mode === 'visual' || v.wrap ? EditorView.lineWrapping : [];
      case 'wrapIndent': return v.wrap && v.wrapIndent ? wrapIndent : [];
      case 'indent': {
        const unit = indentUnitFor(v.indent, this.doc);
        return unit == null ? [] : indentUnit.of(unit);
      }
    }
  }

  slot(s: Exclude<Slot, 'wrapIndent'>): Extension {
    return this.comps.get(s)!.of(this.content(s));
  }

  /** The mode compartment's content in Source mode. */
  sourceMode(): Extension {
    this.keys.set('wrapIndent', this.key('wrapIndent'));
    return this.comps.get('wrapIndent')!.of(this.content('wrapIndent'));
  }

  /**
   * New values, mode or text (the text matters to 'detect' only; pass it
   * once the doc has synced): the reconfigurations for the slots that changed.
   */
  update(next: { values?: EditorSettingValues; mode?: EditorMode; doc?: Text | string | null }): StateEffect<unknown>[] {
    if (next.values) this.values = next.values;
    if (next.mode) this.mode = next.mode;
    if (next.doc !== undefined) this.doc = next.doc;
    const effects: StateEffect<unknown>[] = [];
    for (const [s, comp] of this.comps) {
      // The Source content is rebuilt by sourceMode() when the mode compartment switches to it.
      if (s === 'wrapIndent' && this.mode !== 'source') continue;
      const key = this.key(s);
      if (key === this.keys.get(s)) continue;
      this.keys.set(s, key);
      effects.push(comp.reconfigure(this.content(s)));
    }
    return effects;
  }
}
