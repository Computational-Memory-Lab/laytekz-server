import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isProductName, PRODUCT_NAME, UPSTREAM_URL } from '../product';

/**
 * Galley: the product's name lives in three places that cannot import one
 * another (product.ts here, the server's product.ts, and index.html, which
 * the browser reads before any script). They must agree.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const constant = (src: string, name: string) => new RegExp(`export const ${name} = '([^']*)'`).exec(src)?.[1];

describe('product name', () => {
  it('is the same on the server, in index.html and here', () => {
    const server = read('../../../server/src/product.ts');
    expect(constant(server, 'PRODUCT_NAME')).toBe(PRODUCT_NAME);
    expect(constant(server, 'UPSTREAM_URL')).toBe(UPSTREAM_URL);
    expect(/<title>([^<]*)<\/title>/.exec(read('../../index.html'))?.[1]).toBe(PRODUCT_NAME);
  });

  it('counts an operator name that repeats it as no name', () => {
    expect(isProductName(PRODUCT_NAME)).toBe(true);
    expect(isProductName(` ${PRODUCT_NAME.toUpperCase()} `)).toBe(true);
    expect(isProductName('Kiel University')).toBe(false);
    expect(isProductName(null)).toBe(false);
    expect(isProductName('')).toBe(false);
  });
});
