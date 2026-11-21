import { describe, expect, it } from 'vitest';
import { parseSourceUrl, SOURCE_URL, SOURCE_IS_DEPLOYMENT, UPSTREAM_SOURCE_URL, DEFAULT_SOURCE_URL } from '../../source';

describe('source link', () => {
  it('reads what the server stamped, and nothing it should not', () => {
    expect(parseSourceUrl('https://git.example.org/galley')).toBe('https://git.example.org/galley');
    expect(parseSourceUrl('/source.tar.gz')).toBe('/source.tar.gz');
    expect(parseSourceUrl('/x/source.tar.gz')).toBe('/x/source.tar.gz');
    expect(parseSourceUrl(null)).toBeNull();
    expect(parseSourceUrl('')).toBeNull();
    expect(parseSourceUrl('javascript:alert(1)')).toBeNull();
    expect(parseSourceUrl('//evil.example/x')).toBeNull();
    expect(parseSourceUrl('https://x.example/a b')).toBeNull();
  });

  it('is upstream\'s repository without a stamp', () => {
    expect(SOURCE_URL).toBe(DEFAULT_SOURCE_URL);
    expect(DEFAULT_SOURCE_URL).toBe('https://github.com/Computational-Memory-Lab/laytekz-server');
    expect(SOURCE_URL).not.toBe(UPSTREAM_SOURCE_URL);
    expect(SOURCE_IS_DEPLOYMENT).toBe(false);
  });
});
