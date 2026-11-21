import { Facet } from '@codemirror/state';

/** What the envclose feature's compartment was built with (its switches and the mode). */
export interface EnvCloseConfig {
  /** The feature runs in this editor. */
  on: boolean;
  close: boolean;
  linked: boolean;
  tabStops: boolean;
  /** Visual mode: Enter is Visual's own there. */
  visual: boolean;
}

export const NO_ENVCLOSE: EnvCloseConfig = { on: false, close: false, linked: false, tabStops: false, visual: false };

export const envCloseConfig = Facet.define<EnvCloseConfig, EnvCloseConfig>({
  combine: (v) => v[v.length - 1] ?? NO_ENVCLOSE,
});

/** The rule names the closer's automatic edits carry (autoEditMark, declined spots). */
export const CLOSE_RULE = 'envclose.close';
export const ARGS_RULE = 'envclose.args';
