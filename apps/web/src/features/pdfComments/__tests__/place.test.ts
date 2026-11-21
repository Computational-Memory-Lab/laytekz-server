import { describe, it, expect } from 'vitest';
import { probePoint, sameSelectedText, shortQuote, sourcePlace } from '../place';

const files = [
  { path: 'main.tex', type: 'file' },
  { path: 'paper/main.tex', type: 'file' },
  { path: 'paper/ch1.tex', type: 'file' },
  { path: 'paper', type: 'dir' },
];

describe('sourcePlace', () => {
  it('prefers the exact project path over a suffix match', () => {
    expect(sourcePlace([{ input: 'paper/main.tex', line: 7 }], files)).toEqual({ file: 'paper/main.tex', line: 7, inProject: true });
    expect(sourcePlace([{ input: 'main.tex', line: 2 }], files)).toEqual({ file: 'main.tex', line: 2, inProject: true });
  });

  it('matches the paths compilers report, "/./" segments included', () => {
    expect(sourcePlace([{ input: '/data/projects/x/paper/./ch1.tex', line: '12' }], files)).toEqual({ file: 'paper/ch1.tex', line: 12, inProject: true });
    expect(sourcePlace([{ input: './main.tex', line: 3 }], files)?.file).toBe('main.tex');
  });

  it('says when the text comes from a file outside the project', () => {
    expect(sourcePlace([{ input: '/usr/share/texlive/article.cls', line: 400 }], files)).toEqual({ file: 'article.cls', line: 400, inProject: false });
  });

  it('gives null without a usable record', () => {
    expect(sourcePlace([], files)).toBeNull();
    expect(sourcePlace(undefined, files)).toBeNull();
    expect(sourcePlace([{ page: 1, x: 3 }], files)).toBeNull();
    expect(sourcePlace([{ input: 'main.tex', line: 0 }], files)).toBeNull();
  });
});

describe('helpers', () => {
  it('asks SyncTeX just inside the line box, half way down', () => {
    expect(probePoint({ left: 100, top: 50, right: 300, bottom: 60 })).toEqual({ x: 102, y: 55 });
    expect(probePoint({ left: 10, top: 0, right: 11, bottom: 10 })).toEqual({ x: 10.5, y: 5 });
  });

  it('compares selections by their words only', () => {
    expect(sameSelectedText('quick  brown\nfox', 'quick brown fox')).toBe(true);
    expect(sameSelectedText('quick', 'quack')).toBe(false);
    expect(sameSelectedText(' ', ' ')).toBe(false);
  });

  it('shortens long quotes for messages', () => {
    expect(shortQuote('a\n b')).toBe('a b');
    expect(shortQuote('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
