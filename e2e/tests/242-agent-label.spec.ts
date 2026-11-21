import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

/**
 * Galley: V2 (WP42). Edits made by Codex are labelled Codex: an MCP client
 * that sends `X-Laytekz-Agent: codex` (as the desktop app's ▶ Codex does)
 * shows as Codex in presence, in the review prompt ("Codex edited 1 file")
 * and in History, and Revert undoes its edit. The playwright config cuts the
 * agent presence TTL to 5 s.
 */

const MCP_TOKEN = process.env.ALDINE_MCP_TOKEN || 'aldine-e2e-mcp';
const BASE = process.env.ALDINE_URL || `http://localhost:${process.env.E2E_PORT || 3100}`;
const MAIN = '\\documentclass{article}\n\\begin{document}\nResults improve steadily across trials.\n\\end{document}\n';

async function connect(agent: string): Promise<Client> {
  const client = new Client({ name: 'laytekz-e2e-codex', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}`, 'x-laytekz-agent': agent } } },
  ));
  return client;
}

test('an edit sent as Codex reads “Codex edited 1 file”, and Revert undoes it', async ({ page, request }) => {
  test.setTimeout(180_000);
  const id = await createProject(request, 'Codex Label');
  const client = await connect('codex');
  try {
    await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: MAIN } });
    await openProject(page, id);

    const res = await client.callTool({ name: 'edit_file', arguments: {
      project: id, path: 'main.tex',
      edits: [{ quote: 'Results improve steadily across trials.', replacement: 'Results improve steadily across trials. CODEX-SENTENCE.' }],
      message: 'Add a sentence as Codex',
    } });
    expect(res.isError).toBeFalsy();
    await expect(page.getByTestId('presence-agent')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('presence-agent')).toHaveAttribute('title', /Codex/);

    await expect(page.getByTestId('agent-session-review')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.toast', { hasText: 'edited 1 file' })).toContainText('Codex edited 1 file');

    const log = await (await request.get(`/api/projects/${id}/log?branch=main`)).json();
    expect(log.find((c: { message: string }) => c.message === 'Add a sentence as Codex')?.author).toBe('Codex');

    await page.getByTestId('agent-session-review').click();
    await expect(page.getByTestId('agent-review-modal')).toContainText('CODEX-SENTENCE');
    await page.getByTestId('agent-revert').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.locator('.cm-content')).not.toContainText('CODEX-SENTENCE', { timeout: 15_000 });
    await expect(page.locator('.cm-content')).toContainText('Results improve steadily across trials.');
  } finally {
    await client.close().catch(() => {});
    await cleanup(request, id);
  }
});
