import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { applyFilesMoved, citeCommandFor, docNameOf, movedPath, setCiteCommandResolver, type MoveTargets } from '../hooks';
import type { Spot } from '../../fileSpots';

const state = EditorState.create({ doc: '\\documentclass{apa7}' });
const removals: Array<() => void> = [];
const resolve = (fn: Parameters<typeof setCiteCommandResolver>[0]) => { removals.push(setCiteCommandResolver(fn)); };
afterEach(() => { for (const off of removals.splice(0)) off(); });

describe('the citation command', () => {
  it('is \\cite without a resolver', () => {
    expect(citeCommandFor(state, 'main.tex')).toBe('cite');
  });

  it('is the resolver\'s answer; a later resolver is asked first, and null passes on', () => {
    resolve(() => 'parencite');
    expect(citeCommandFor(state, 'main.tex')).toBe('parencite');
    resolve((_s, path) => (path.endsWith('.ltx') ? 'citep' : null));
    expect(citeCommandFor(state, 'ch1.ltx')).toBe('citep');
    expect(citeCommandFor(state, 'main.tex')).toBe('parencite');
  });

  it('skips a resolver that throws or answers something that is not a command name, and drops a leading backslash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolve(() => 'textcite');
    resolve(() => 'not a command}');
    resolve(() => { throw new Error('boom'); });
    expect(citeCommandFor(state, 'main.tex')).toBe('textcite');
    expect(warn).toHaveBeenCalledTimes(1);
    resolve(() => '\\autocite*');
    expect(citeCommandFor(state, 'main.tex')).toBe('autocite*');
    warn.mockRestore();
  });

  it('forgets a removed resolver', () => {
    const off = setCiteCommandResolver(() => 'citet');
    expect(citeCommandFor(state, 'main.tex')).toBe('citet');
    off();
    off();
    expect(citeCommandFor(state, 'main.tex')).toBe('cite');
  });
});

describe('moved files', () => {
  it('maps a moved file, a file in a moved folder, and nothing else', () => {
    const moves: [string, string][] = [['main.tex', 'thesis.tex'], ['figs', 'figures']];
    expect(movedPath('main.tex', moves)).toBe('thesis.tex');
    expect(movedPath('figs/a.png', moves)).toBe('figures/a.png');
    expect(movedPath('figsx/a.png', moves)).toBeNull();
    expect(movedPath('other.tex', moves)).toBeNull();
  });

  function targets(spots: Record<string, Spot>, parked: string[]) {
    const kept = new Map(Object.entries(spots));
    const closed: string[] = [];
    const t: MoveTargets = {
      spots: { get: (n) => kept.get(n) ?? null, set: (n, s) => { kept.set(n, s); } },
      closeParked: (keep) => {
        for (const name of [...parked]) if (!keep(name)) { parked.splice(parked.indexOf(name), 1); closed.push(name); }
      },
    };
    return { t, kept, closed, parked };
  }
  const spot: Spot = { anchor: 5, head: 5, top: 0, margin: 0 };

  it('copies a moved file\'s spot to its new name and closes its parked doc', () => {
    const n = (p: string) => docNameOf('p', 'main', p);
    const x = targets({ [n('main.tex')]: spot }, [n('main.tex'), n('other.tex'), docNameOf('q', 'main', 'main.tex')]);
    applyFilesMoved('p', 'main', [['main.tex', 'thesis.tex']], x.t);
    expect(x.kept.get(n('thesis.tex'))).toEqual(spot);
    expect(x.closed).toEqual([n('main.tex')]);
    expect(x.parked).toEqual([n('other.tex'), docNameOf('q', 'main', 'main.tex')]);
  });

  it('follows a folder\'s move for the parked docs under it, and never overwrites a spot the new name has', () => {
    const n = (p: string) => docNameOf('p', 'main', p);
    const other: Spot = { anchor: 1, head: 1, top: 0, margin: 0 };
    const x = targets({ [n('ch/a.tex')]: spot, [n('ch/b.tex')]: spot, [n('chapters/b.tex')]: other }, [n('ch/a.tex')]);
    applyFilesMoved('p', 'main', [['ch', 'chapters']], x.t);
    expect(x.kept.get(n('chapters/a.tex'))).toEqual(spot);
    expect(x.kept.get(n('chapters/b.tex'))).toEqual(other);
    expect(x.closed).toEqual([n('ch/a.tex')]);
  });

  it('does nothing for no moves', () => {
    const x = targets({}, ['p::main::a.tex']);
    applyFilesMoved('p', 'main', [], x.t);
    expect(x.parked).toEqual(['p::main::a.tex']);
  });
});
