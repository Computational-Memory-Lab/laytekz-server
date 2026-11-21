import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('../../../settings/store', () => ({ getSetting: (id: string) => settings.values[id] }));
const server = vi.hoisted(() => ({ setup: null as unknown }));
vi.mock('../../../api', () => ({ api: {}, apiRequest: async () => server.setup }));

import { citedKeys, documentFamily, panelCommand, toggleAt } from '../actions';
import { loadSetup, resetSetupCache } from '../refIndex';

const doc = (text: string) => EditorState.create({ doc: text });
const toggled = (marked: string, family: 'biblatex' | 'natbib' | 'apacite' | 'bibtex') => {
  const text = marked.replace('|', '');
  const r = toggleAt(text, marked.indexOf('|'), family);
  return 'error' in r ? r.error : text.slice(0, r.from) + r.insert + text.slice(r.to);
};

describe('the toggle replaces only the command name', () => {
  it('keeps keys and notes', () => {
    expect(toggled('see \\parencite[see][12]{a,|b}.', 'biblatex')).toBe('see \\textcite[see][12]{a,b}.');
    expect(toggled('\\citep[p.~3]{a}|', 'biblatex')).toBe('\\citet[p.~3]{a}');
    expect(toggled('\\cite<e.g.,>{a|}', 'apacite')).toBe('\\citeA<e.g.,>{a}');
  });

  it('says why when it cannot', () => {
    expect(toggled('no citation |here', 'biblatex')).toBe('Put the cursor in a citation to switch it.');
    expect(toggled('\\citeauthor{a|}', 'biblatex')).toBe('Only narrative and parenthetical citations switch.');
  });
});

describe('the document family and the panels\u2019 command', () => {
  beforeEach(() => {
    settings.values = {};
    server.setup = null;
    resetSetupCache();
  });

  it('plain BibTeX keeps \\cite; biblatex panels insert \\parencite', async () => {
    expect(panelCommand('p', 'main', doc('\\documentclass{article}\n\\begin{document}'))).toBe('cite');
    expect(panelCommand('p', 'main', doc('\\documentclass[man,biblatex]{apa7}'))).toBe('parencite');
    await new Promise((r) => setTimeout(r, 0));
    server.setup = { family: 'natbib', label: 'natbib · APA', bibFiles: [] };
    await loadSetup('p', 'main', true);
    expect(panelCommand('p', 'main', doc('\\section{x}'))).toBe('citep');
    expect(documentFamily('p', 'main', null)).toEqual({ family: 'natbib', label: 'natbib · APA' });
  });

  it('the switch off gives \\cite, and a family chosen in settings wins', () => {
    settings.values = { 'citations.panels': false };
    expect(panelCommand('p', 'main', doc('\\documentclass[biblatex]{apa7}'))).toBeNull();
    settings.values = { 'citations.family': 'apacite' };
    expect(documentFamily('p', 'main', doc('\\documentclass[biblatex]{apa7}')).family).toBe('apacite');
  });

  it('counts the keys cited in a file', () => {
    expect([...citedKeys('\\parencite{a,b} and \\textcite[3]{a} \\cite<see>{c}')]).toEqual([['a', 2], ['b', 1], ['c', 1]]);
  });
});
