/**
 * Visual mode (WP37): display math, tables and other constructs Visual draws
 * as one widget over several lines take no text tint, so a highlight that
 * covers one gets a bar in its colour beside the widget. A layer over the
 * text, like the collaborators' outlines: the widget's DOM is never touched,
 * and no source byte changes.
 */
import type { Extension } from '@codemirror/state';
import { layer, type EditorView, type LayerMarker } from '@codemirror/view';
import { atomicField } from '../../editor/visual/atomicField';
import { drawnColor, isPreset } from './model';
import { flatten } from './paint';
import { highlightField } from './extension';
import { visibleRuns } from './query';

class Bar implements LayerMarker {
  constructor(readonly left: number, readonly top: number, readonly height: number, readonly color: string) {}

  eq(o: LayerMarker): boolean {
    return o instanceof Bar && o.left === this.left && o.top === this.top && o.height === this.height && o.color === this.color;
  }

  draw(): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'highlight-block-bar');
    this.adjust(el);
    return el;
  }

  update(el: HTMLElement, prev: LayerMarker): boolean {
    if (!(prev instanceof Bar)) return false;
    this.adjust(el);
    return true;
  }

  private adjust(el: HTMLElement) {
    el.className = `cm-hl-bar cm-hl--${isPreset(this.color) ? this.color : 'custom'}`;
    el.style.left = `${this.left}px`;
    el.style.top = `${this.top}px`;
    el.style.height = `${this.height}px`;
    if (isPreset(this.color)) el.style.removeProperty('--hl');
    else el.style.setProperty('--hl', this.color);
  }
}

function bars(view: EditorView): Bar[] {
  const atoms = view.state.field(atomicField, false);
  if (!atoms) return [];
  const segs = flatten(visibleRuns(view.state));
  if (!segs.length) return [];
  const doc = view.state.doc;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const baseLeft = scroller.left - view.scrollDOM.scrollLeft;
  const baseTop = scroller.top - view.scrollDOM.scrollTop;
  const left = view.contentDOM.getBoundingClientRect().left - baseLeft + 2;
  const out: Bar[] = [];
  const { from: vFrom, to: vTo } = view.viewport;
  atoms.deco.between(vFrom, vTo, (from, to, d) => {
    if (!d.spec.widget && !d.spec.block) return;
    if (to <= from || doc.lineAt(from).number === doc.lineAt(to).number) return;
    const seg = segs.find((s) => s.from < to && s.to > from);
    if (!seg) return;
    const a = view.lineBlockAt(from);
    const b = view.lineBlockAt(to);
    // lineBlockAt measures from the document's top edge (view.documentTop on screen).
    const top = view.documentTop + a.top - baseTop;
    out.push(new Bar(left, top, Math.max(4, b.bottom - a.top), drawnColor(seg.run.color)));
  });
  return out;
}

/** Only in Visual mode (the feature's compartment is rebuilt on a mode change). */
export function visualBars(): Extension {
  return layer({
    above: false,
    class: 'cm-hl-bars',
    update: (u) => u.docChanged || u.geometryChanged || u.viewportChanged
      || u.state.field(highlightField, false) !== u.startState.field(highlightField, false)
      || u.state.field(atomicField, false) !== u.startState.field(atomicField, false),
    markers: bars,
  });
}
