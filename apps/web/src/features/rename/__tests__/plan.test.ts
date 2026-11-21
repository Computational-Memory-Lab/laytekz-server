import { describe, it, expect } from 'vitest';
import {
  applyBody, chosenEdits, danglingNote, dialogTitle, doneMessage, editEnabled, editsByFile, initialSelection, leftMessage, needsDialog,
  onlyBody, onlyLabel, primaryLabel, readPlan, readTitlePlan, referencesLeft, remapPath, reverseMoves, sameMoves, siblingNote, titleDiff,
  toggleEdit, toggleRename, viewPlan, type RenamePlan,
} from '../plan';

/** paper.tex → thesis.tex, as WP28's planner answers it for a root with a same-name .bib. */
const paperPlan = (): RenamePlan => ({
  renames: [
    { from: 'paper.tex', to: 'thesis.tex', kind: 'requested', checked: true },
    { from: 'paper.bib', to: 'thesis.bib', kind: 'sibling', checked: true },
    { from: 'paper.pdf', to: 'thesis.pdf', kind: 'sibling', checked: false },
    { from: 'paper.sty', to: 'thesis.sty', kind: 'sibling', checked: true, disabled: true, reason: 'A file named "thesis.sty" already exists' },
  ],
  edits: [
    { id: 'e1', file: 'paper.tex', line: 4, kind: 'code', before: '\\addbibresource{paper.bib}', after: '\\addbibresource{thesis.bib}', checked: true, follows: 'paper.bib' },
    { id: 'e2', file: 'ch/intro.tex', line: 1, kind: 'directive', before: '% !TEX root = ../paper.tex', after: '% !TEX root = ../thesis.tex', checked: true, follows: 'paper.tex' },
    { id: 'e3', file: 'notes.tex', line: 9, kind: 'comment', before: '% \\input{paper}', after: '% \\input{thesis}', checked: false, follows: 'paper.tex' },
    { id: 'e4', file: 'ch/intro.tex', line: 0, kind: 'code', before: '\\documentclass[../paper.tex]{subfiles}', after: '\\documentclass[../thesis.tex]{subfiles}', checked: true, follows: 'paper.tex' },
  ],
  settings: [{ label: 'Main document', from: 'paper.tex', to: 'thesis.tex' }],
  unresolved: [],
  warnings: [],
});

const plain = (): RenamePlan => ({
  renames: [{ from: 'a.tex', to: 'b.tex', kind: 'requested', checked: true }],
  edits: [], settings: [], unresolved: [], warnings: [],
});

describe('reading the server\'s plan', () => {
  it('accepts the frozen shape and drops what it does not know', () => {
    const plan = readPlan({ ...paperPlan(), extra: 1 });
    expect(plan?.renames).toHaveLength(4);
    expect(plan?.edits.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(plan?.renames[3]).toMatchObject({ disabled: true, reason: 'A file named "thesis.sty" already exists' });
  });

  it('is null for anything else, so the page renames as before', () => {
    expect(readPlan(null)).toBeNull();
    expect(readPlan({ ok: true })).toBeNull();
    expect(readPlan({ renames: [], edits: [] }), 'no requested row').toBeNull();
    expect(readPlan({ renames: [{ from: 'a', to: 'b', kind: 'requested' }], edits: [{ id: 1 }] })).toBeNull();
  });

  it('reads a title plan, offering only when there is an edit', () => {
    expect(readTitlePlan({ offer: true, edits: [{ id: 't', file: 'main.tex', line: 5, before: '\\title{Old}', after: '\\title{New}', checked: true }] })?.offer).toBe(true);
    expect(readTitlePlan({ offer: true, edits: [] })?.offer).toBe(false);
    expect(readTitlePlan({})).toBeNull();
  });
});

describe('whether to ask', () => {
  it('asks when a sibling could move or a reference would change', () => {
    expect(needsDialog(paperPlan())).toBe(true);
    const onlySibling = { ...plain(), renames: [...plain().renames, { from: 'a.bib', to: 'b.bib', kind: 'sibling' as const, checked: true }] };
    expect(needsDialog(onlySibling)).toBe(true);
  });

  it('does not ask when nothing else would change, the main document setting included', () => {
    expect(needsDialog(plain())).toBe(false);
    expect(needsDialog({ ...plain(), settings: [{ label: 'Main document', from: 'a.tex', to: 'b.tex' }] })).toBe(false);
    expect(needsDialog({ ...plain(), warnings: [{ kind: 'large', message: 'big.tex is too large', blocking: false }] })).toBe(false);
    const disabledOnly = { ...plain(), renames: [...plain().renames, { from: 'a.bib', to: 'b.bib', kind: 'sibling' as const, checked: true, disabled: true }] };
    expect(needsDialog(disabledOnly)).toBe(false);
  });

  it('asks to explain a refusal, and to show what needs attention', () => {
    expect(needsDialog({ ...plain(), warnings: [{ kind: 'invalid-root', message: 'bad name', blocking: true }] })).toBe(true);
    expect(needsDialog({ ...plain(), unresolved: [{ file: 'main.tex', line: 3, text: '\\input{\\dir/a}' }] })).toBe(true);
  });

  it('with the sibling offer off, leaves out siblings and the references that follow them', () => {
    const v = viewPlan(paperPlan(), { siblings: false });
    expect(v.renames.map((r) => r.from)).toEqual(['paper.tex']);
    expect(v.edits.map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
    expect(viewPlan(plain(), { siblings: false })).toEqual(plain());
  });

  it('counts the references a plain rename leaves on the old name, comments aside', () => {
    expect(referencesLeft(paperPlan())).toBe(2);
    expect(referencesLeft(plain())).toBe(0);
  });
});

describe('the preview\'s boxes', () => {
  it('start as the server suggests: paper.bib checked, comments unchecked, disabled rows off', () => {
    const plan = paperPlan();
    const sel = initialSelection(plan);
    expect([...sel.renames]).toEqual(['paper.bib']);
    expect([...sel.edits].sort()).toEqual(['e1', 'e2', 'e4']);
    expect(sel.edits.has('e3'), 'a reference in a comment starts unchecked').toBe(false);
  });

  it('let a sibling\'s references follow its box', () => {
    const plan = paperPlan();
    let sel = toggleRename(plan, initialSelection(plan), 'paper.bib', false);
    expect(sel.renames.has('paper.bib')).toBe(false);
    expect(sel.edits.has('e1')).toBe(false);
    expect(editEnabled(plan, sel, plan.edits[0])).toBe(false);
    expect(toggleEdit(plan, sel, 'e1', true), 'cannot tick a reference whose file stays').toBe(sel);
    sel = toggleRename(plan, sel, 'paper.bib', true);
    expect(sel.edits.has('e1')).toBe(true);
    expect(toggleRename(plan, sel, 'paper.sty', true), 'a disabled sibling stays off').toBe(sel);
  });

  it('warn under an unticked reference to the renamed file, not under a comment', () => {
    const plan = paperPlan();
    const sel = toggleEdit(plan, initialSelection(plan), 'e2', false);
    expect(danglingNote(plan, sel, plan.edits[1])).toBe('will point at a file that no longer exists');
    expect(danglingNote(plan, sel, plan.edits[2])).toBeNull();
    expect(danglingNote(plan, sel, plan.edits[3])).toBeNull();
  });

  it('name the buttons after what they do', () => {
    const plan = paperPlan();
    const sel = initialSelection(plan);
    expect(primaryLabel(plan, sel)).toBe('Rename 2 files and update 3 references');
    expect(primaryLabel(plan, toggleRename(plan, sel, 'paper.bib', false))).toBe('Rename paper.tex and update 2 references');
    expect(primaryLabel(plan, { renames: new Set(), edits: new Set() })).toBe('Rename paper.tex');
    expect(primaryLabel(plan, { renames: new Set(['paper.bib']), edits: new Set() })).toBe('Rename 2 files');
    expect(onlyLabel(plan)).toBe('Rename only paper.tex');
    expect(dialogTitle(plan)).toBe('Rename paper.tex to thesis.tex?');
    expect(dialogTitle({ ...plain(), renames: [{ from: 'plot.tex', to: 'figures/plot.tex', kind: 'requested', checked: true }] })).toBe('Move plot.tex to figures?');
    expect(dialogTitle({ ...plain(), renames: [{ from: 'ch/a.tex', to: 'b.tex', kind: 'requested', checked: true }] })).toBe('Rename ch/a.tex to b.tex?');
  });

  it('label siblings and group references by file in line order', () => {
    const plan = paperPlan();
    expect(siblingNote(plan.renames[1])).toBe('same name as the main document');
    expect(siblingNote(plan.renames[3])).toBe('A file named "thesis.sty" already exists');
    expect(siblingNote({ from: 'paper.xmpdata', to: 'thesis.xmpdata', kind: 'sibling', checked: true })).toContain('pdfx');
    expect(editsByFile(plan).map((g) => [g.file, g.edits.map((e) => e.id)])).toEqual([
      ['paper.tex', ['e1']], ['ch/intro.tex', ['e4', 'e2']], ['notes.tex', ['e3']],
    ]);
  });
});

describe('what is sent', () => {
  it('sends the chosen siblings and references only', () => {
    const plan = paperPlan();
    const sel = toggleEdit(plan, initialSelection(plan), 'e3', true);
    expect(applyBody(plan, sel, 'main')).toEqual({
      branch: 'main', from: 'paper.tex', to: 'thesis.tex',
      renames: [{ from: 'paper.bib', to: 'thesis.bib' }],
      edits: ['e1', 'e2', 'e3', 'e4'],
    });
    const noBib = toggleRename(plan, sel, 'paper.bib', false);
    expect(applyBody(plan, noBib, 'draft').edits).toEqual(['e2', 'e3', 'e4']);
    expect(chosenEdits(plan, noBib).map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
  });

  it('"Rename only" sends the file alone', () => {
    expect(onlyBody(paperPlan(), 'main')).toEqual({ branch: 'main', from: 'paper.tex', to: 'thesis.tex', renames: [], edits: [] });
  });

  it('"always" applies the suggested defaults', () => {
    const plan = paperPlan();
    expect(applyBody(plan, initialSelection(plan), 'main').edits).toEqual(['e1', 'e2', 'e4']);
  });
});

describe('the words after a rename', () => {
  const res = { ok: true, commit: 'abc1234', renamed: 2, edited: 5, skipped: 0, files: 3, moves: [['paper.tex', 'thesis.tex'], ['paper.bib', 'thesis.bib']] as [string, string][] };
  it('say what changed', () => {
    expect(doneMessage(res)).toBe('Renamed paper.tex to thesis.tex and 1 other file, and updated 5 references in 3 files');
    expect(doneMessage({ ...res, moves: [res.moves[0]], edited: 1, files: 1 })).toBe('Renamed paper.tex to thesis.tex and updated 1 reference in 1 file');
    expect(doneMessage({ ...res, moves: [['a.tex', 'ch/a.tex']], edited: 0 })).toBe('Renamed a.tex to ch/a.tex');
    expect(doneMessage({ ...res, skipped: 1 })).toMatch(/1 reference changed since the preview and was left alone$/);
    expect(leftMessage({ ...res, moves: [res.moves[0]], edited: 0 }, 3)).toBe('Renamed paper.tex to thesis.tex. 3 references still use the old name');
  });

  it('show the title change on one line', () => {
    expect(titleDiff({ offer: true, edits: [{ id: 't', file: 'main.tex', line: 5, before: '  \\title{Old}', after: '  \\title{New}', checked: true }] })).toBe('\\title{Old}  →  \\title{New}');
  });
});

describe('paths after moves', () => {
  it('follow files and folders', () => {
    expect(remapPath('ch/a.tex', [['ch', 'parts']])).toBe('parts/a.tex');
    expect(remapPath('chapter.tex', [['ch', 'parts']])).toBe('chapter.tex');
    expect(remapPath('paper.tex', [['paper.tex', 'thesis.tex']])).toBe('thesis.tex');
  });

  it('compare in any order, and reverse for an undo', () => {
    expect(sameMoves([['a', 'b'], ['c', 'd']], [['c', 'd'], ['a', 'b']])).toBe(true);
    expect(sameMoves([['a', 'b']], [['a', 'c']])).toBe(false);
    expect(reverseMoves([['a', 'b'], ['c', 'd']])).toEqual([['d', 'c'], ['b', 'a']]);
  });
});
