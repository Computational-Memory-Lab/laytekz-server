import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * WP25: the connector setup names Codex and points to the desktop console.
 * (The access-token command for accounts-on servers with closed registration
 * needs a signed-in server; this suite runs with auth off.)
 */
test.describe('Connect Claude Code and Codex (V2)', () => {
  test('Codex commands and the desktop hint', async ({ page, request, baseURL }) => {
    const id = await createProject(request, 'Connect Codex');
    try {
      await openProject(page, id);
      await page.getByTestId('palette-open').click();
      await page.keyboard.type('connect claude');
      await page.getByTestId('palette-item-connect-claude').click();
      await expect(page.getByTestId('connect-claude')).toBeVisible();
      // auth off on this server: the static token is only ever named
      await expect(page.getByTestId('agent-codex-command')).toHaveText(
        `export LAYTEKZ_TOKEN=<ALDINE_MCP_TOKEN>\ncodex mcp add laytekz --url ${baseURL}/mcp --bearer-token-env-var LAYTEKZ_TOKEN`,
      );
      await expect(page.getByTestId('agent-desktop-hint')).toContainText('▶ Codex');
      await expect(page.getByTestId('connect-claude')).not.toContainText('aldine-e2e-mcp');
      await page.getByTestId('connect-done').click();
    } finally {
      await cleanup(request, id);
    }
  });
});
