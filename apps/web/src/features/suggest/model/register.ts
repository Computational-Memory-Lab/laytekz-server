/**
 * Registers the model provider once per tab (WP43). Importing this module
 * loads no model and downloads nothing: the provider answers null until
 * "Smarter suggestions" is on and the model is stored, and the runtime chunk
 * is imported only when the first suggestion needs it.
 */
import { getSetting } from '../../../settings/store';
import { registerSuggestionProvider } from '../provider';
import { createModelProvider } from './modelProvider';
import { modelManager } from './manager';
import { MODEL_SETTING } from './settings';

let registered = false;

export function registerModelProvider(): void {
  if (registered) return;
  registered = true;
  registerSuggestionProvider(createModelProvider({
    enabled: () => getSetting<boolean>(MODEL_SETTING) === true,
    runtime: (signal) => modelManager().runtime(signal),
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  }));
}

registerModelProvider();
