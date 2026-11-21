import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { compiledField, compiledRange, settleResult, synctexLines, takeRequestSnapshot, takeResultSnapshot } from '../compiled';
import { sha256, textHash } from '../hash';
import { errorOn, shownRun } from '../index';

const DOC = [
  '\\documentclass{article}', // 1
  '\\begin{document}', // 2
  'Some text.', // 3
  '\\begin{equation}', // 4
  '  a + b = c', // 5
  '\\end{equation}', // 6
  'More text \\[ x \\] here.', // 7
  '\\end{document}', // 8
].join('\n');

const eqFrom = DOC.indexOf('\\begin{equation}');
const eqTo = DOC.indexOf('\\end{equation}') + '\\end{equation}'.length;

function adopted(doc = DOC, use: 'result' | 'request' = 'result'): EditorState {
  let s = EditorState.create({ doc, extensions: [compiledField] });
  const run = (spec: TransactionSpec) => { s = s.update(spec).state; };
  if (use === 'request') run({ effects: takeRequestSnapshot.of(null) });
  run({ effects: takeResultSnapshot.of(1) });
  run({ effects: settleResult.of({ token: 1, compileId: 7, use }) });
  return s;
}

describe('compiled text', () => {
  it('finds an untouched formula in the typeset text', () => {
    const r = compiledRange(adopted(), eqFrom, eqTo);
    expect(r).toEqual({ kind: 'ok', compileId: 7, firstLine: 4, lastLine: 6, textBefore: false, textAfter: false });
  });

  it('keeps the typeset lines when lines are inserted above, even at the formula\'s first character', () => {
    let s = adopted();
    s = s.update({ changes: { from: eqFrom, insert: 'New line one.\nNew line two.\n' }, userEvent: 'input.type' }).state;
    const from = s.doc.toString().indexOf('\\begin{equation}');
    const to = s.doc.toString().indexOf('\\end{equation}') + 14;
    expect(compiledRange(s, from, to)).toMatchObject({ kind: 'ok', firstLine: 4, lastLine: 6 });
  });

  it('says changed when an edit reaches inside, local or remote', () => {
    const local = adopted().update({ changes: { from: DOC.indexOf('a + b'), insert: '2' }, userEvent: 'input.type' }).state;
    expect(compiledRange(local, eqFrom, eqTo + 1).kind).toBe('changed');
    // a collaborator's edit arrives as a transaction with no user event
    const remote = adopted().update({ changes: { from: DOC.indexOf('b = c'), to: DOC.indexOf('b = c') + 1 } }).state;
    expect(compiledRange(remote, eqFrom, eqTo - 1).kind).toBe('changed');
  });

  it('notes text sharing the delimiters\' lines', () => {
    const from = DOC.indexOf('\\[');
    const to = DOC.indexOf('\\]') + 2;
    expect(compiledRange(adopted(), from, to)).toMatchObject({ kind: 'ok', firstLine: 7, lastLine: 7, textBefore: true, textAfter: true });
    const comment = adopted(DOC.replace('\\end{equation}', '\\end{equation} % note'));
    expect(compiledRange(comment, eqFrom, eqTo)).toMatchObject({ textAfter: false });
  });

  it('knows nothing until a run is settled, and forgets on a run without proof', () => {
    const bare = EditorState.create({ doc: DOC, extensions: [compiledField] });
    expect(compiledRange(bare, eqFrom, eqTo).kind).toBe('none');
    const none = adopted().update({ effects: settleResult.of({ token: 2, compileId: 8, use: null }) }).state;
    expect(compiledRange(none, eqFrom, eqTo).kind).toBe('none');
  });

  it('maps edits made between the typeset request and its result', () => {
    let s = EditorState.create({ doc: DOC, extensions: [compiledField] });
    s = s.update({ effects: takeRequestSnapshot.of(null) }).state;
    s = s.update({ changes: { from: 0, insert: '% top\n' } }).state;
    s = s.update({ effects: takeResultSnapshot.of(3) }).state;
    s = s.update({ effects: settleResult.of({ token: 3, compileId: 9, use: 'request' }) }).state;
    const from = s.doc.toString().indexOf('\\begin{equation}');
    expect(compiledRange(s, from, from + (eqTo - eqFrom))).toMatchObject({ kind: 'ok', compileId: 9, firstLine: 4, lastLine: 6 });
  });

  it('picks the SyncTeX lines', () => {
    expect(synctexLines({ firstLine: 4, lastLine: 6, textBefore: false, textAfter: false })).toEqual({ first: 5, last: 6, single: false });
    expect(synctexLines({ firstLine: 4, lastLine: 6, textBefore: false, textAfter: true })).toEqual({ first: 5, last: 5, single: false });
    expect(synctexLines({ firstLine: 7, lastLine: 7, textBefore: false, textAfter: false })).toEqual({ first: 7, last: 7, single: true });
    expect(synctexLines({ firstLine: 7, lastLine: 7, textBefore: true, textAfter: false })).toBeNull();
  });
});

describe('text hash', () => {
  it('matches the server\'s hash', async () => {
    // pinned in the server's collab-primitives test: what flushBranchDocsHashed gives for "é\n"
    expect(await textHash('é\n')).toBe('edd3a863872a0423');
    expect(await textHash('One\r\nTwo\r\n')).toBe(await textHash('One\nTwo\n'));
  });

  it('computes SHA-256 in JavaScript where SubtleCrypto is missing', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70_001]) {
      const bytes = new Uint8Array(randomBytes(n));
      expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});

describe('the run shown', () => {
  const base = { ok: true, pdf: 'x', pdfUrl: '/api/projects/p/output?t=5', compileId: 5, log: '', errors: [], durationMs: 1 };
  it('stands only with its proof', () => {
    expect(shownRun({ ...base, sources: { 'main.tex': 'abc' } } as never)?.compileId).toBe(5);
    expect(shownRun(base)).toBeNull();
    expect(shownRun({ ...base, pdfStale: true, sources: {} } as never)).toBeNull();
    expect(shownRun({ ...base, pdfUrl: null, sources: {} } as never)).toBeNull();
    expect(shownRun(null)).toBeNull();
  });

  it('notices a TeX error on the formula\'s lines', () => {
    const errors = [{ type: 'error' as const, line: 5, message: 'Undefined control sequence', file: './chapters/a.tex' }];
    expect(errorOn(errors, 'chapters/a.tex', 4, 6)).toBe(true);
    expect(errorOn(errors, 'paper/chapters/a.tex', 4, 6)).toBe(true);
    expect(errorOn(errors, 'chapters/a.tex', 6, 8)).toBe(false);
    expect(errorOn(errors, 'main.tex', 4, 6)).toBe(false);
    expect(errorOn([{ type: 'warning', line: 5, message: 'w' }], 'main.tex', 4, 6)).toBe(false);
  });
});
