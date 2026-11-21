import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyLook, lookOf, resolveTheme, type LookTarget } from '../apply';
import { SETTINGS } from '../registry';

/** The registry's defaults, with `over` on top. */
function values(over: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {};
  for (const d of SETTINGS.values()) all[d.id] = d.default;
  Object.assign(all, over);
  return (id: string) => all[id];
}

function target(): LookTarget & { props: Map<string, string> } {
  const props = new Map<string, string>();
  return {
    props,
    dataset: {},
    style: { fontSize: '', setProperty: (k, v) => { props.set(k, v); }, removeProperty: (k) => { props.delete(k); } },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('what the settings ask of <html>', () => {
  it('asks nothing at the defaults, so the page looks exactly as before', () => {
    const look = lookOf(values());
    expect(look.fontSize).toBe('');
    expect(Object.values(look.attrs).every((v) => v === null)).toBe(true);
    expect(Object.values(look.vars).every((v) => v === null)).toBe(true);
    const t = target();
    applyLook(t, look);
    expect(t.dataset).toEqual({});
    expect(t.props.size).toBe(0);
    expect(t.style.fontSize).toBe('');
  });

  it('turns each setting into its attribute or variable', () => {
    const look = lookOf(values({
      'appearance.scale': 125, 'appearance.contrast': 'more', 'appearance.motion': 'reduce', 'pdf.dark': 'invert',
      'editor.font': 'Fira Code', 'editor.fontSize': 15, 'editor.lineHeight': 1.8, 'editor.ligatures': true,
      'visual.fontSize': 19, 'visual.width': 'full',
    }));
    expect(look).toEqual({
      fontSize: '125%',
      attrs: { contrast: 'more', motion: 'reduce', pdfDark: 'invert', ligatures: 'on' },
      vars: {
        '--editor-font': '"Fira Code", var(--font-mono)', '--editor-font-size': '15px', '--editor-line-height': '1.8',
        '--visual-font-size': '19px', '--visual-width': 'none',
      },
    });
  });

  it('turns ligatures off only for a chosen font (the system fonts have none)', () => {
    expect(lookOf(values({ 'editor.font': 'JetBrains Mono' })).attrs.ligatures).toBe('off');
    expect(lookOf(values()).attrs.ligatures).toBeNull();
    expect(lookOf(values({ 'editor.ligatures': true })).attrs.ligatures).toBe('on');
  });

  it('never puts an unsafe font name into CSS', () => {
    expect(lookOf(values({ 'editor.font': 'x"; } body { display: none' })).vars['--editor-font']).toBeNull();
  });

  it('removes what a setting set once it is back at its default', () => {
    const t = target();
    applyLook(t, lookOf(values({ 'appearance.scale': 90, 'pdf.dark': 'dim', 'editor.fontSize': 12 })));
    expect(t.dataset.pdfDark).toBe('dim');
    expect(t.style.fontSize).toBe('90%');
    expect(t.props.get('--editor-font-size')).toBe('12px');
    applyLook(t, lookOf(values()));
    expect(t.dataset).toEqual({});
    expect(t.style.fontSize).toBe('');
    expect(t.props.size).toBe(0);
  });
});

describe('startApply', () => {
  it('paints the theme and the look at once, and again on every change', async () => {
    vi.resetModules();
    const t = target();
    const meta = { content: '', setAttribute(_: string, v: string) { this.content = v; } };
    const root = { ...t, dataset: t.dataset, style: t.style };
    vi.stubGlobal('document', { documentElement: root, querySelector: () => meta });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
    const { startApply, paintedTheme } = await import('../apply');
    const current: Record<string, unknown> = { 'appearance.theme': 'system', 'pdf.dark': 'paper' };
    const subs: { ids: string[]; fn: () => void }[] = [];
    startApply((id) => current[id] ?? values()(id), (ids, fn) => { subs.push({ ids, fn }); return () => {}; });
    expect(root.dataset.theme).toBe('dark');
    expect(meta.content).toBe('#1c1c1e');
    expect(paintedTheme()).toBe('dark');
    current['appearance.theme'] = 'light';
    current['pdf.dark'] = 'dim';
    for (const s of subs) s.fn();
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.pdfDark).toBe('dim');
  });

  it('resolves "Match system" from the system and leaves an explicit choice alone', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
