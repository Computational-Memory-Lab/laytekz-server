import { describe, expect, it } from 'vitest';
import { hintFor } from '../errorHints';

describe('hintFor: a statistics trigger left in the source (WP38)', () => {
  it('names the trigger and says to press Tab', () => {
    expect(hintFor('Undefined control sequence. — \\pval')).toMatch(/^\\pval is a Laytekz statistic, not a LaTeX command: .*press Tab/);
  });

  it('finds \\bayes10 from the token TeX stopped at', () => {
    expect(hintFor('Undefined control sequence. — \\bayes')).toMatch(/^\\bayes10 is a Laytekz statistic/);
  });

  it('keeps the general hint for other commands', () => {
    expect(hintFor('Undefined control sequence. — \\foo')).toMatch(/A command isn’t defined/);
    expect(hintFor('Undefined control sequence.')).toMatch(/A command isn’t defined/);
  });
});
