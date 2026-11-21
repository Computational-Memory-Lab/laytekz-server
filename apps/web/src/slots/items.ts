/**
 * Which slot items show where (WP06 page-host): pure, so it is tested without
 * a DOM. Items sort by `order`; ties keep manifest order (and a module's own
 * order). An item whose `when` throws is left out, like one whose `when` is
 * false. A second item with an id already shown is dropped.
 */
import type { FeatureModule } from '../features/types';
import type { SlotId, SlotItem, SlotProps } from './types';

export function slotItems(modules: readonly FeatureModule[], slot: SlotId, props?: SlotProps): SlotItem[] {
  const picked: { item: SlotItem; i: number }[] = [];
  const ids = new Set<string>();
  for (const m of modules) {
    for (const item of m.slots ?? []) {
      if (!item || item.slot !== slot) continue;
      if (ids.has(item.id)) { console.warn(`[laytekz] slot item '${item.id}' is defined twice; the second is left out`); continue; }
      if (props && item.when) {
        try {
          if (!item.when(props)) continue;
        } catch (err) {
          console.warn(`[laytekz] slot item '${item.id}' failed its check`, err);
          continue;
        }
      }
      ids.add(item.id);
      picked.push({ item, i: picked.length });
    }
  }
  return picked.sort((a, b) => a.item.order - b.item.order || a.i - b.i).map((p) => p.item);
}
