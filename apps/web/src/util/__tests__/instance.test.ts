import { describe, expect, it } from 'vitest';
import { parseInstance, supportHref } from '../../instance';
import { documentTitle } from '../documentTitle';

describe('instance operator', () => {
  it('reads what the server stamped, and nothing it did not', () => {
    const i = parseInstance(JSON.stringify({ name: 'Kiel University', logo: 'abc123', logoDark: 'def456', url: 'https://uni-kiel.de/', support: { kind: 'email', value: 'it@uni-kiel.de' } }));
    expect(i).toEqual({ name: 'Kiel University', logo: 'abc123', logoDark: 'def456', url: 'https://uni-kiel.de/', support: { kind: 'email', value: 'it@uni-kiel.de' } });
    expect(supportHref(i!.support!)).toBe('mailto:it@uni-kiel.de');
    expect(parseInstance(null)).toBeNull();
    expect(parseInstance('not json')).toBeNull();
    expect(parseInstance(JSON.stringify({ name: null, logo: null, support: null }))).toBeNull();
    const hostile = parseInstance(JSON.stringify({ name: 'X', url: 'javascript:alert(1)', logo: '../x', support: { kind: 'url', value: 'javascript:alert(1)' } }));
    expect(hostile).toEqual({ name: 'X', logo: null, logoDark: null, url: null, support: null });
  });

  it('adds the operator after the product name in the tab title, never instead', () => {
    expect(documentTitle('Projects', null)).toBe('Projects – Laytekz');
    expect(documentTitle('Projects', 'Kiel University')).toBe('Projects – Laytekz · Kiel University');
    expect(documentTitle(null, 'Kiel University')).toBe('Laytekz · Kiel University');
    expect(documentTitle(null, null)).toBe('Laytekz');
  });

  it('treats an operator named like the product as no operator', () => {
    expect(documentTitle('Projects', 'Laytekz')).toBe('Projects – Laytekz');
    expect(documentTitle('Projects', ' laytekz ')).toBe('Projects – Laytekz');
    expect(parseInstance(JSON.stringify({ name: 'Laytekz' }))).toBeNull();
    expect(parseInstance(JSON.stringify({ name: 'Laytekz', support: { kind: 'email', value: 'help@example.org' } })))
      .toEqual({ name: null, logo: null, logoDark: null, url: null, support: { kind: 'email', value: 'help@example.org' } });
  });
});
