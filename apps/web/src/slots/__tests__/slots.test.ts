import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, lazy } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { slotItems } from '../items';
import type { SlotItem, SlotProps } from '../types';
import type { AppCtx, FeatureModule } from '../../features/types';

afterEach(() => { vi.restoreAllMocks(); });

const Nothing = () => null;
const item = (id: string, slot: SlotItem['slot'], order: number, extra: Partial<SlotItem> = {}): SlotItem => ({ id, slot, order, render: Nothing, ...extra });
const props: SlotProps = { page: null, app: {} as AppCtx };

describe('slotItems', () => {
  it('lists one slot items by order, ties in manifest order', () => {
    const modules: FeatureModule[] = [
      { id: 'tables', slots: [item('tables.tool', 'editor.tools', 100), item('tables.later', 'editor.tools', 400)] },
      { id: 'stats', slots: [item('stats.tool', 'editor.tools', 200), item('stats.chip', 'editor.status', 100)] },
      { id: 'citations', slots: [item('citations.tool', 'editor.tools', 400)] },
      { id: 'highlighter', slots: [item('highlighter.tool', 'editor.tools', 300)] },
    ];
    expect(slotItems(modules, 'editor.tools').map((i) => i.id)).toEqual(['tables.tool', 'stats.tool', 'highlighter.tool', 'tables.later', 'citations.tool']);
    expect(slotItems(modules, 'editor.status').map((i) => i.id)).toEqual(['stats.chip']);
    expect(slotItems(modules, 'pdf.overlay')).toEqual([]);
  });

  it('leaves out an item whose `when` is false or throws, given props to ask it with', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const when = vi.fn((p: SlotProps) => p.page === null);
    const modules: FeatureModule[] = [{
      id: 'pet',
      slots: [
        item('pet.yes', 'editor.overlay', 1, { when }),
        item('pet.no', 'editor.overlay', 2, { when: () => false }),
        item('pet.boom', 'editor.overlay', 3, { when: () => { throw new Error('no'); } }),
      ],
    }];
    expect(slotItems(modules, 'editor.overlay', props).map((i) => i.id)).toEqual(['pet.yes']);
    expect(when).toHaveBeenCalledWith(props);
    expect(warn).toHaveBeenCalledOnce();
    // without props nothing is asked: the sidebar lists every panel item
    expect(slotItems(modules, 'editor.overlay').map((i) => i.id)).toEqual(['pet.yes', 'pet.no', 'pet.boom']);
  });

  it('shows an id once', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const modules: FeatureModule[] = [
      { id: 'pet', slots: [item('same', 'home.toolbar', 1)] },
      { id: 'agents', slots: [item('same', 'home.toolbar', 0)] },
    ];
    expect(slotItems(modules, 'home.toolbar')).toHaveLength(1);
    expect(slotItems(modules, 'home.toolbar')[0].order).toBe(1);
  });
});

describe('<Slot>', () => {
  it('renders the installed modules items in order with no wrapper, and nothing for a failing or loading one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { installFeatures } = await import('../../features/host');
    const { Slot } = await import('../Slot');
    const Tag = (label: string) => function TagItem({ page }: SlotProps) { return createElement('span', { 'data-page': page ? page.projectId : 'none' }, label); };
    const Boom = () => { throw new Error('boom'); };
    const Never = lazy(() => new Promise<{ default: () => null }>(() => {}));
    installFeatures([
      { id: 'wordcount', slots: [item('wordcount.status', 'pdf.status', 100, { render: Tag('count') })] },
      { id: 'pet', slots: [item('pet.boom', 'pdf.status', 50, { render: Boom }), item('pet.later', 'pdf.status', 200, { render: Tag('later') })] },
      { id: 'stats', slots: [item('stats.lazy', 'pdf.status', 150, { render: Never }), item('stats.other', 'pdf.actions', 1, { render: Tag('other') })] },
      { id: '_probe', slots: [item('_probe.tag', 'pdf.status', 300, { render: Tag('probe') })] },
    ]);
    const html = renderToStaticMarkup(createElement(Slot, { name: 'pdf.status', page: null }));
    // the probe stays out unless localStorage asks for it
    expect(html).toBe('<span data-page="none">count</span><span data-page="none">later</span>');
    expect(renderToStaticMarkup(createElement(Slot, { name: 'pdf.overlay', page: null }))).toBe('');
  });
});
