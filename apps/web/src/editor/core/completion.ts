/**
 * The code editor's completion list (WP05 editor-host): the core sources (the
 * V1 list, moved here with no behaviour change), the feature sources and
 * filters the editor host adds, and the "Show completions" setting. One
 * `autocompletion()` holds them all: an override ignores languageData, and
 * two overrides cannot be merged, so nothing else may add one.
 */
import { Compartment, type Extension, type StateEffect } from '@codemirror/state';
import { autocompletion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { citeCompletionSource, keyCommandCompletionSource, latexPackageCompletions, refCompletionSource } from '../latexExtras';
import { everydayCompletionSource, macroCompletionSource, pathCompletionSource } from '../completions';
import { packageCompletionSource } from './language';
import type { CompletionActivation } from './editorSettingDefs';

/** A feature's post-processing of every completion result (EditorContribution.completionFilter). */
export type CompletionFilter = (r: CompletionResult, cx: CompletionContext) => CompletionResult;

/**
 * The V1 sources, in V1's order. Every source is listed here: an override
 * ignores languageData, where the package registers its command list with a
 * \cite and \ref that insert the bare name.
 */
export function coreCompletionSources(projectId: string, branch: string, filePath: () => string): CompletionSource[] {
  return [
    latexPackageCompletions(packageCompletionSource()),
    keyCommandCompletionSource,
    everydayCompletionSource,
    macroCompletionSource(projectId, branch, filePath),
    pathCompletionSource(projectId, branch, filePath),
    citeCompletionSource(projectId, branch),
    refCompletionSource(projectId, branch, filePath),
  ];
}

/** `source` with `filters` applied, in order, to each result it gives. A
 *  filter that throws is skipped (reported once through `warn`). */
export function filteredSource(source: CompletionSource, filters: readonly CompletionFilter[], warn: (f: CompletionFilter, err: unknown) => void = () => {}): CompletionSource {
  if (!filters.length) return source;
  const apply = (r: CompletionResult | null, cx: CompletionContext): CompletionResult | null => {
    if (!r) return r;
    let out = r;
    for (const f of filters) {
      try {
        out = f(out, cx) ?? out;
      } catch (err) {
        warn(f, err);
      }
    }
    return out;
  };
  return (cx) => {
    const r = source(cx);
    return r instanceof Promise ? r.then((v) => apply(v, cx)) : apply(r, cx);
  };
}

/** The autocompletion extension for `sources` and the setting; 'off' leaves none. */
export function completionExtension(sources: readonly CompletionSource[], activation: CompletionActivation): Extension {
  if (activation === 'off') return [];
  return autocompletion(activation === 'request' ? { override: [...sources], activateOnTyping: false } : { override: [...sources] });
}

export interface CompletionParts {
  /** Appended after the core sources. */
  sources: readonly CompletionSource[];
  /** Applied to every source's results, core sources included. */
  filters: readonly CompletionFilter[];
}

/** The completion list's compartment, at the place V1 had autocompletion(). */
export class CompletionSlot {
  private readonly comp = new Compartment();
  private parts: CompletionParts = { sources: [], filters: [] };
  private activation: CompletionActivation;

  constructor(private readonly core: readonly CompletionSource[], activation: CompletionActivation, private readonly warn?: (f: CompletionFilter, err: unknown) => void) {
    this.activation = activation;
  }

  /** The sources the list asks now: the core ones, then the features', each through the filters. */
  sources(): CompletionSource[] {
    return [...this.core, ...this.parts.sources].map((s) => filteredSource(s, this.parts.filters, this.warn));
  }

  private build(): Extension {
    return completionExtension(this.sources(), this.activation);
  }

  get extension(): Extension {
    return this.comp.of(this.build());
  }

  /** Before the view exists: the parts the first `extension` holds. */
  init(parts: CompletionParts): void {
    this.parts = parts;
  }

  /** A reconfiguration when the activation or the feature parts changed, else null. */
  update(next: { activation?: CompletionActivation; parts?: CompletionParts }): StateEffect<unknown> | null {
    const activation = next.activation ?? this.activation;
    const parts = next.parts ?? this.parts;
    const same = activation === this.activation
      && sameList(parts.sources, this.parts.sources) && sameList(parts.filters, this.parts.filters);
    if (same) return null;
    this.activation = activation;
    this.parts = parts;
    return this.comp.reconfigure(this.build());
  }
}

const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
