import { describe, expect, it } from 'vitest';
import { documentClassOf, documentFontSize } from '../preamble';

describe('documentFontSize and documentClassOf (WP13)', () => {
  it('reads the size option of \\documentclass, 10 pt otherwise', () => {
    expect(documentFontSize('\\documentclass[11pt]{article}')).toBe(11);
    expect(documentFontSize('\\documentclass[a4paper, 12pt,twocolumn]{article}')).toBe(12);
    expect(documentFontSize('\\documentclass{article}')).toBe(10);
    expect(documentFontSize('% \\documentclass[12pt]{article}\n\\documentclass{report}')).toBe(10);
    expect(documentFontSize(null)).toBe(10);
  });

  it('names the class, ignoring commented-out lines', () => {
    expect(documentClassOf('\\documentclass[man,12pt]{apa7}\n\\usepackage{x}')).toBe('apa7');
    expect(documentClassOf('%\\documentclass{book}\n\\documentclass { article }')).toBe('article');
    expect(documentClassOf('no class here')).toBeNull();
  });
});
