import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createEmitter } from '../../events';
import type { EditorPageCtx, PageEvents } from '../../types';
import type { RenameClient } from '../client';
import { followPeers, interceptFileRename, interceptProjectRename, resetOwnMoves, type PreviewChoice, type RenameDeps } from '../flow';
import type { ApplyBody, ApplyResult, RenamePlan } from '../plan';

const paperPlan: RenamePlan = {
  renames: [
    { from: 'paper.tex', to: 'thesis.tex', kind: 'requested', checked: true },
    { from: 'paper.bib', to: 'thesis.bib', kind: 'sibling', checked: true },
  ],
  edits: [
    { id: 'e1', file: 'paper.tex', line: 4, kind: 'code', before: '\\addbibresource{paper.bib}', after: '\\addbibresource{thesis.bib}', checked: true, follows: 'paper.bib' },
    { id: 'e2', file: 'notes.tex', line: 2, kind: 'code', before: '\\input{paper}', after: '\\input{thesis}', checked: true, follows: 'paper.tex' },
    { id: 'e3', file: 'notes.tex', line: 9, kind: 'comment', before: '% \\input{paper}', after: '% \\input{thesis}', checked: false, follows: 'paper.tex' },
  ],
  settings: [{ label: 'Main document', from: 'paper.tex', to: 'thesis.tex' }],
  unresolved: [],
  warnings: [],
};
const plainPlan: RenamePlan = { renames: [{ from: 'a.tex', to: 'b.tex', kind: 'requested', checked: true }], edits: [], settings: [], unresolved: [], warnings: [] };

interface Toast { text: string; kind?: string; action?: { label: string; run(): void } }

function harness(o: { plan?: unknown; planError?: unknown; settings?: Record<string, unknown>; choice?: PreviewChoice; manual?: boolean; canEdit?: boolean } = {}) {
  const events = createEmitter<PageEvents>();
  const toasts: Toast[] = [];
  let active: string | null = 'paper.tex';
  const opened: string[] = [];
  const applied: ApplyBody[] = [];
  const settings: Record<string, unknown> = { 'rename.references': 'ask', 'rename.siblings': true, 'rename.title': true, ...o.settings };
  const confirmAnswer = { value: true };
  const page = {
    projectId: 'p1', branch: 'main',
    canEdit: () => o.canEdit !== false, showcase: () => false,
    project: () => ({ manualCommits: o.manual === true }),
    user: () => ({ name: 'Me' }),
    activeFile: () => active,
    openFile: (p: string) => { opened.push(p); active = p; },
    refreshFiles: vi.fn(async () => {}),
    refreshProject: vi.fn(async () => {}),
    toast: (text: string, kind?: string, action?: Toast['action']) => { toasts.push({ text, kind, action }); },
    confirm: vi.fn(async () => confirmAnswer.value),
    events,
  } as unknown as EditorPageCtx;
  const client = {
    plan: vi.fn(async () => { if (o.planError) throw o.planError; return o.plan ?? paperPlan; }),
    apply: vi.fn(async (_id: string, body: ApplyBody): Promise<ApplyResult> => {
      applied.push(body);
      const moves: [string, string][] = [[body.from, body.to], ...body.renames.map((r) => [r.from, r.to] as [string, string])];
      // the server's moves signal reaches the page before the reply
      events.emit('filesMoved', { moves, by: 'Me' });
      return { ok: true, renamed: moves.length, edited: body.edits.length, skipped: 0, files: body.edits.length ? 2 : 0, moves, ...(o.manual ? { undo: 'tok' } : { commit: 'abc1234' }), newRoot: 'thesis.tex' };
    }),
    titlePlan: vi.fn(async () => ({ offer: true, edits: [{ id: 't1', file: 'main.tex', line: 5, before: '\\title{Old}', after: '\\title{New}', checked: true }] })),
    titleApply: vi.fn(async () => ({ ok: true, edited: 1, commit: 'def5678' })),
    revert: vi.fn(async () => ({ ok: true, newRoot: 'paper.tex' })),
    undo: vi.fn(async () => ({ ok: true, restored: ['paper.tex'], skipped: [] })),
    renameProject: vi.fn(async () => ({})),
  } satisfies RenameClient;
  const preview = vi.fn(async () => o.choice ?? ({ kind: 'cancel' } as PreviewChoice));
  const deps: RenameDeps = {
    client,
    setting: <T,>(id: string) => settings[id] as T,
    setSetting: (id, v) => { settings[id] = v; },
    preview,
    now: () => Date.now(),
    followAfterMs: 10,
  };
  return { page, client, deps, preview, toasts, applied, settings, opened, events, confirmAnswer, setActive: (p: string | null) => { active = p; } };
}

const req = { from: 'paper.tex', to: 'thesis.tex', via: 'tree' as const };
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => resetOwnMoves());

describe('renaming a file', () => {
  it('leaves a rename nothing refers to to the page', async () => {
    const h = harness({ plan: plainPlan });
    expect(await interceptFileRename({ from: 'a.tex', to: 'b.tex', via: 'drag' }, h.page, h.deps)).toBe('default');
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.client.apply).not.toHaveBeenCalled();
  });

  it('leaves it to the page when the plan cannot be had (a taken name, an older server, a viewer)', async () => {
    const taken = harness({ planError: Object.assign(new Error('A file named "thesis.tex" already exists'), { status: 409 }) });
    expect(await interceptFileRename(req, taken.page, taken.deps)).toBe('default');
    expect(taken.toasts).toEqual([]);
    const old = harness({ plan: { ok: true } });
    expect(await interceptFileRename(req, old.page, old.deps)).toBe('default');
    const viewer = harness({ canEdit: false });
    expect(await interceptFileRename(req, viewer.page, viewer.deps)).toBe('default');
    expect(viewer.client.plan).not.toHaveBeenCalled();
  });

  it('says why references were not checked in a project too large to scan', async () => {
    const h = harness({ planError: Object.assign(new Error('This project holds too much text to check its references — rename only the file'), { status: 413 }) });
    expect(await interceptFileRename(req, h.page, h.deps)).toBe('default');
    expect(h.toasts[0].text).toMatch(/Only the file is renamed/);
  });

  it('asks first, and a cancel changes nothing', async () => {
    const h = harness({ choice: { kind: 'cancel' } });
    expect(await interceptFileRename(req, h.page, h.deps)).toBe('handled');
    expect(h.preview).toHaveBeenCalledOnce();
    expect(h.client.apply).not.toHaveBeenCalled();
  });

  it('applies what the preview chose, says what changed, and Undo reverts the one commit', async () => {
    const h = harness({ choice: { kind: 'apply', selection: { renames: new Set(['paper.bib']), edits: new Set(['e1', 'e2']) }, always: false } });
    expect(await interceptFileRename(req, h.page, h.deps)).toBe('handled');
    expect(h.applied[0]).toEqual({ branch: 'main', from: 'paper.tex', to: 'thesis.tex', renames: [{ from: 'paper.bib', to: 'thesis.bib' }], edits: ['e1', 'e2'] });
    expect(h.toasts[0].text).toBe('Renamed paper.tex to thesis.tex and 1 other file, and updated 2 references in 2 files');
    expect(h.toasts[0].action?.label).toBe('Undo');
    expect(h.page.refreshProject).toHaveBeenCalled(); // the main document moved
    h.toasts[0].action!.run();
    await flush();
    expect(h.client.revert).toHaveBeenCalledWith('p1', 'main', ['abc1234'], 'Undo the rename of paper.tex');
    expect(h.toasts.at(-1)?.text).toBe('Put back paper.tex and everything the rename changed');
  });

  it('undoes through the image when the project commits by hand', async () => {
    const h = harness({ manual: true, choice: { kind: 'only' } });
    await interceptFileRename(req, h.page, h.deps);
    expect(h.applied[0]).toMatchObject({ renames: [], edits: [] });
    h.toasts[0].action!.run();
    await flush();
    expect(h.client.undo).toHaveBeenCalledWith('p1', 'main', 'tok');
  });

  it('remembers "Always update references without asking"', async () => {
    const h = harness({ choice: { kind: 'apply', selection: { renames: new Set(), edits: new Set(['e2']) }, always: true } });
    await interceptFileRename(req, h.page, h.deps);
    expect(h.settings['rename.references']).toBe('always');
  });

  it('in "always" mode applies the suggested choices without asking', async () => {
    const h = harness({ settings: { 'rename.references': 'always' } });
    expect(await interceptFileRename(req, h.page, h.deps)).toBe('handled');
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.applied[0]).toMatchObject({ renames: [{ from: 'paper.bib', to: 'thesis.bib' }], edits: ['e1', 'e2'] });
  });

  it('in "always" mode still shows a rename the server would refuse', async () => {
    const h = harness({ settings: { 'rename.references': 'always' }, plan: { ...paperPlan, warnings: [{ kind: 'invalid-root', message: 'bad', blocking: true }] } });
    await interceptFileRename(req, h.page, h.deps);
    expect(h.preview).toHaveBeenCalledOnce();
  });

  it('in "Never" mode renames the file alone, then offers to update what still uses the old name', async () => {
    const h = harness({ settings: { 'rename.references': 'never' }, choice: { kind: 'apply', selection: { renames: new Set(), edits: new Set(['e2']) }, always: false } });
    expect(await interceptFileRename(req, h.page, h.deps)).toBe('handled');
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.applied[0]).toMatchObject({ renames: [], edits: [] });
    expect(h.toasts[0].text).toBe('Renamed paper.tex to thesis.tex. 1 reference still uses the old name');
    expect(h.toasts[0].action?.label).toBe('Update');
    h.toasts[0].action!.run();
    await flush();
    expect(h.client.revert).toHaveBeenCalledOnce();
    expect(h.preview).toHaveBeenCalledOnce();
    expect(h.applied[1]).toMatchObject({ edits: ['e2'] });
  });

  it('in "Never" mode with nothing left on the old name renames as before', async () => {
    const h = harness({ settings: { 'rename.references': 'never' }, plan: { ...paperPlan, edits: [paperPlan.edits[2]] } });
    expect(await interceptFileRename(req, h.page, h.deps)).toBe('default');
  });

  it('with the sibling offer off, sends no sibling', async () => {
    const h = harness({ settings: { 'rename.references': 'always', 'rename.siblings': false } });
    await interceptFileRename(req, h.page, h.deps);
    expect(h.applied[0]).toMatchObject({ renames: [], edits: ['e2'] });
  });

  it('follows the files itself when the moves signal never comes', async () => {
    const h = harness({ settings: { 'rename.references': 'always', 'rename.siblings': false } });
    h.client.apply.mockImplementationOnce(async (_id, body) => ({ ok: true, renamed: 1, edited: 1, skipped: 0, files: 1, moves: [[body.from, body.to]], commit: 'x' }));
    await interceptFileRename(req, h.page, h.deps);
    await flush();
    expect(h.opened).toEqual(['thesis.tex']);
    expect(h.page.refreshFiles).toHaveBeenCalled();
  });
});

describe('a collaborator', () => {
  it('is told who renamed the file they have open, and file spots follow', async () => {
    const h = harness();
    const spots: [string, string][] = [];
    const off = followPeers(h.page, h.deps, { rename: (a, b) => { spots.push([a, b]); } }, (p) => `p1::main::${p}`);
    h.setActive('intro.tex');
    h.events.emit('filesMoved', { moves: [['intro.tex', 'introduction.tex']], by: 'Ada' });
    expect(h.toasts.map((t) => t.text)).toEqual(['Ada renamed intro.tex to introduction.tex']);
    expect(spots).toEqual([['p1::main::intro.tex', 'p1::main::introduction.tex']]);
    h.events.emit('filesMoved', { moves: [['other.tex', 'else.tex']], by: 'Ada' });
    expect(h.toasts).toHaveLength(1);
    off();
  });

  it('is not told about their own rename', async () => {
    const h = harness({ settings: { 'rename.references': 'always' } });
    followPeers(h.page, h.deps, { rename: () => {} }, (p) => p);
    await interceptFileRename(req, h.page, h.deps);
    expect(h.toasts.map((t) => t.text).filter((t) => /renamed paper/.test(t))).toEqual([]);
  });
});

describe('renaming the project', () => {
  it('asks when the title still holds the old name, and changes both', async () => {
    const h = harness();
    expect(await interceptProjectRename({ from: 'Old', to: 'New' }, h.page, h.deps)).toBe('handled');
    expect(h.page.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Also change the document title?', confirmLabel: 'Change title too', cancelLabel: 'Only rename the project' }));
    expect(h.client.renameProject).toHaveBeenCalledWith('p1', 'New');
    expect(h.client.titleApply).toHaveBeenCalledWith('p1', { branch: 'main', from: 'Old', to: 'New', edits: ['t1'] });
    expect(h.toasts[0].action?.label).toBe('Undo');
  });

  it('"Only rename the project" keeps the title', async () => {
    const h = harness();
    h.confirmAnswer.value = false;
    expect(await interceptProjectRename({ from: 'Old', to: 'New' }, h.page, h.deps)).toBe('handled');
    expect(h.client.renameProject).toHaveBeenCalled();
    expect(h.client.titleApply).not.toHaveBeenCalled();
  });

  it('leaves it to the page when nothing matches, the offer is off, or there is no editor page', async () => {
    const none = harness();
    none.client.titlePlan.mockResolvedValueOnce({ offer: false, edits: [] });
    expect(await interceptProjectRename({ from: 'Old', to: 'New' }, none.page, none.deps)).toBe('default');
    expect(none.page.confirm).not.toHaveBeenCalled();
    const off = harness({ settings: { 'rename.title': false } });
    expect(await interceptProjectRename({ from: 'Old', to: 'New' }, off.page, off.deps)).toBe('default');
    expect(off.client.titlePlan).not.toHaveBeenCalled();
    const home = harness();
    expect(await interceptProjectRename({ from: 'Old', to: 'New' }, null, home.deps)).toBe('default');
  });

  it('a refused project rename goes back to the page, which says why', async () => {
    const h = harness();
    h.client.renameProject.mockRejectedValueOnce(new Error('forbidden'));
    expect(await interceptProjectRename({ from: 'Old', to: 'New' }, h.page, h.deps)).toBe('default');
    expect(h.client.titleApply).not.toHaveBeenCalled();
  });
});
