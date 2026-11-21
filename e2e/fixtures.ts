import { test as base, expect } from '@playwright/test';

/**
 * localStorage key that makes every `automatic` setting (the V2 typing aids
 * that change text as you type) default to off. Equal to TEST_DEFAULTS_KEY in
 * apps/web/src/settings/types.ts; repeated so the suites load no app code.
 */
export const TEST_DEFAULTS_KEY = 'aldine.settings.testDefaults';

export interface SuiteOptions {
  /**
   * localStorage[TEST_DEFAULTS_KEY] in every browser context a test opens,
   * its `page` and any `browser.newContext()`: 'automatic-off' (the default)
   * keeps the V1 specs, which type exact LaTeX, free of automatic edits. A
   * spec of an automatic feature opts out with
   * `test.use({ settingsTestDefaults: null })`.
   */
  settingsTestDefaults: 'automatic-off' | null;
}

/**
 * Shared test base for the suites, so a page-wide setup has one place to go.
 * Galley: V2's automatic settings default to off here (settingsTestDefaults).
 * The key reaches every context through the storageState option, which
 * Playwright also applies to contexts a test creates itself; a test that
 * passes its own storageState sets the key itself.
 */
export const test = base.extend<SuiteOptions>({
  settingsTestDefaults: ['automatic-off', { option: true }],
  storageState: async ({ storageState, baseURL, settingsTestDefaults }, use) => {
    if (!settingsTestDefaults || !baseURL || storageState !== undefined) { await use(storageState); return; }
    const origin = new URL(baseURL).origin;
    await use({ cookies: [], origins: [{ origin, localStorage: [{ name: TEST_DEFAULTS_KEY, value: settingsTestDefaults }] }] });
  },
});

export { expect };
