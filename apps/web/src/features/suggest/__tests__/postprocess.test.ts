import { describe, expect, it } from 'vitest';
import { postprocess } from '../postprocess';

describe('postprocess', () => {
  it('1: cuts at a line break or a stop token', () => {
    expect(postprocess(' the results\nmore', 'We report', '')).toBe(' the results');
    expect(postprocess(' the results<|endoftext|>junk', 'We report', '')).toBe(' the results');
    expect(postprocess(' the results<|file_sep|>x', 'We report', '')).toBe(' the results');
  });

  it('2: drops an overlap with the suffix', () => {
    expect(postprocess('ld}', '\\textbf{bo', '} and')).toBe('ld');
    expect(postprocess(' of the data).', 'the mean (', ').')).toBe(' of the data');
  });

  it('3: cuts before \\begin and \\end', () => {
    expect(postprocess(' as shown \\begin{figure}', 'This is', '')).toBe(' as shown');
    expect(postprocess(' done \\end{itemize}', 'This is', '')).toBe(' done');
  });

  it('4: keeps groups balanced, allowing one closer of a group opened before the caret', () => {
    expect(postprocess('ld} text', '\\textbf{bo', '')).toBe('ld}');
    expect(postprocess(' \\emph{open and', 'Some', '')).toBeNull();
    expect(postprocess(' see \\cite{a} and \\emph{b', 'We', '')).toBe(' see \\cite{a} and');
    expect(postprocess(') more', 'no group here', '')).toBeNull();
  });

  it('5: keeps the count of $ even', () => {
    expect(postprocess(' where $x$ is $y', 'Let', '')).toBe(' where $x$ is');
    expect(postprocess(' costs \\$5 each', 'It', '')).toBe(' costs \\$5 each');
  });

  it('6: stops after the first sentence end', () => {
    expect(postprocess(' the effect was large. Then we', 'We found that', '')).toBe(' the effect was large.');
    expect(postprocess(' e.g.x and more', 'Some', '')).toBe(' e.g.x and more');
  });

  it('7: trims, drops trivial or repeated text, caps the length', () => {
    expect(postprocess(' a   ', 'x', '')).toBeNull();
    expect(postprocess('  ', 'x', '')).toBeNull();
    expect(postprocess(' the same words again', 'we said the same words again', '')).toBeNull();
    const long = ' ' + Array.from({ length: 30 }, () => 'word').join(' ');
    const out = postprocess(long, 'Start', '')!;
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('word')).toBe(true);
  });
});
