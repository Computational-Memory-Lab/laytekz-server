import { describe, it, expect } from 'vitest';
import { samePage, stepsBack } from '../leaveGuard';

// Galley: V2 settings routes
describe('samePage', () => {
  it('counts the editor and its settings page as one page, so Back between them asks nothing', () => {
    expect(samePage('/p/abc/settings/editor-text', '/p/abc')).toBe(true);
    expect(samePage('/p/abc', '/p/abc/settings')).toBe(true);
    expect(samePage('/p/abc/settings/typing', '/p/abc/settings/project')).toBe(true);
  });

  it('tells two projects, the project list and other pages apart', () => {
    expect(samePage('/p/abc', '/p/abd')).toBe(false);
    expect(samePage('/', '/p/abc')).toBe(false);
    expect(samePage('/p/abc', '/')).toBe(false);
    expect(samePage('/admin', '/admin')).toBe(true);
    expect(samePage('/settings', '/')).toBe(false);
  });

  it('looks past the base path the instance is served under', () => {
    expect(samePage('/internal/p/x/p/abc/settings', '/internal/p/x/p/abc', '/internal/p/x')).toBe(true);
    expect(samePage('/internal/p/x/p/abc', '/internal/p/x/p/abd', '/internal/p/x')).toBe(false);
  });
});

describe('stepsBack', () => {
  it('undoes a Back with a step forward and a Forward with a step back', () => {
    expect(stepsBack(5, 4)).toBe(1);
    expect(stepsBack(5, 2)).toBe(3);
    expect(stepsBack(5, 6)).toBe(-1);
  });

  it('gives up on entries the router did not number, and on no move at all', () => {
    expect(stepsBack(undefined, 4)).toBeNull();
    expect(stepsBack(5, null)).toBeNull();
    expect(stepsBack(5, 5)).toBeNull();
  });
});
