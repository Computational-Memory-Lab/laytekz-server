import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from '../useMediaQuery';

afterEach(() => { vi.unstubAllGlobals(); });

function stub(systemReduces: boolean, attribute?: string) {
  vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q.includes('reduced-motion') && systemReduces, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal('document', { documentElement: { dataset: attribute ? { motion: attribute } : {} } });
}

describe('prefersReducedMotion', () => {
  it('follows the system', () => {
    stub(true);
    expect(prefersReducedMotion()).toBe(true);
    stub(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it('counts the "Reduce motion" setting as the system asking', () => {
    stub(false, 'reduce');
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false where nothing can be asked', () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});
