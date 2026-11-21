import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Sha256 } from '../sha256';

const hex = (data: Uint8Array) => new Sha256().update(data).hex();
const text = (s: string) => new TextEncoder().encode(s);

describe('incremental SHA-256', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(hex(text(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(text('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('gives the same digest however the input is split into chunks', () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const data = new Uint8Array(randomBytes(size));
      const want = createHash('sha256').update(data).digest('hex');
      expect(hex(data), `${size} bytes in one piece`).toBe(want);
      const h = new Sha256();
      let at = 0;
      let step = 1;
      while (at < data.length) {
        h.update(data.subarray(at, at + step));
        at += step;
        step = (step * 7 + 3) % 97 || 1;
      }
      expect(h.hex(), `${size} bytes in odd chunks`).toBe(want);
    }
  });

  it('refuses more input after the digest', () => {
    const h = new Sha256();
    h.hex();
    expect(() => h.update(text('x'))).toThrow();
    expect(h.hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
