/**
 * <Slot> (WP06 page-host): every enabled feature's items for `name`, by
 * order, each inside its own error boundary and Suspense, so an item that
 * throws or is still loading renders nothing and never takes the page down.
 * Items render with no wrapper element: the headers' CSS (flex children,
 * `.pdf-status + .pdf-words`) sees them exactly as if the page drew them.
 */
import { Component, Suspense, type JSX, type ReactNode } from 'react';
import type { EditorPageCtx } from '../features/types';
import { appCtx, useFeatureModules } from '../features/host';
import { slotItems } from './items';
import type { SlotId, SlotItem, SlotProps } from './types';

class SlotBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(err: unknown): void {
    console.warn(`[laytekz] slot item '${this.props.id}' failed`, err);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** One item, isolated: what the sidebar uses for a panel's body, and Slot for each item. */
export function SlotItemView({ item, page }: { item: SlotItem; page: EditorPageCtx | null }): JSX.Element {
  const Render = item.render;
  return (
    <SlotBoundary id={item.id}>
      <Suspense fallback={null}>
        <Render page={page} app={appCtx} />
      </Suspense>
    </SlotBoundary>
  );
}

export function Slot(p: { name: SlotId; page: EditorPageCtx | null }): JSX.Element {
  const modules = useFeatureModules();
  const props: SlotProps = { page: p.page, app: appCtx };
  return <>{slotItems(modules, p.name, props).map((item) => <SlotItemView key={item.id} item={item} page={p.page} />)}</>;
}
