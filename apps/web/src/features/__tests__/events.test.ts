import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../events';
import type { PageEvents } from '../types';

afterEach(() => { vi.restoreAllMocks(); });

describe('createEmitter', () => {
  it('delivers each event to its own listeners, in the order they subscribed', () => {
    const e = createEmitter<PageEvents>();
    const seen: string[] = [];
    e.on('activeFile', (p) => seen.push(`a1:${p.path}`));
    e.on('docChanged', (p) => seen.push(`d:${p.path}:${p.local}`));
    e.on('activeFile', (p) => seen.push(`a2:${p.path}`));
    e.emit('activeFile', { path: 'main.tex' });
    e.emit('docChanged', { path: 'main.tex', local: true });
    expect(seen).toEqual(['a1:main.tex', 'a2:main.tex', 'd:main.tex:true']);
  });

  it('stops delivering after the returned function runs, and only for that subscription', () => {
    const e = createEmitter<PageEvents>();
    const fn = vi.fn();
    const off1 = e.on('filesChanged', fn);
    e.on('filesChanged', fn);
    e.emit('filesChanged', {});
    expect(fn).toHaveBeenCalledTimes(2);
    off1();
    off1();
    e.emit('filesChanged', {});
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('logs a listener that throws and still runs the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = createEmitter<PageEvents>();
    const after = vi.fn();
    e.on('visibility', () => { throw new Error('boom'); });
    e.on('visibility', after);
    expect(() => e.emit('visibility', { visible: false })).not.toThrow();
    expect(after).toHaveBeenCalledWith({ visible: false });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('runs over a snapshot: a listener added or removed during an emit counts from the next one', () => {
    const e = createEmitter<PageEvents>();
    const late = vi.fn();
    let offSecond = () => {};
    e.on('commentsChanged', () => { e.on('commentsChanged', late); offSecond(); });
    const second = vi.fn();
    offSecond = e.on('commentsChanged', second);
    e.emit('commentsChanged', {});
    expect(second).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
    e.emit('commentsChanged', {});
    expect(second).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledOnce();
  });

  it('emitting an event nobody listens to does nothing', () => {
    const e = createEmitter<PageEvents>();
    expect(() => e.emit('rosterChanged', {})).not.toThrow();
  });
});
