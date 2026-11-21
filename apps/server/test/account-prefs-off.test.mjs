/**
 * Without accounts (AUTH_ENABLED unset, the default) there are no account
 * preferences: every /api/account/preferences call is a 404, and
 * GET /api/capabilities says so (accounts and prefs false), with MCP and
 * OAuth registration as the environment sets them. Through buildApp.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from './assert.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-account-prefs-off-')));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
process.env.ALDINE_MCP = '1';
for (const k of ['AUTH_ENABLED', 'ALDINE_PUBLIC_URL', 'ALDINE_BASE_PATH', 'DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_OAUTH_REGISTRATION', 'ALDINE_TEST_HOOKS']) delete process.env[k];
fs.mkdirSync(process.env.WEB_DIST, { recursive: true });
fs.writeFileSync(path.join(process.env.WEB_DIST, 'index.html'), '<!doctype html><html><head></head><body><script src="./assets/index-abc123.js"></script></body></html>');

const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

for (const method of ['GET', 'PATCH', 'PUT']) {
  const r = await app.inject({ method, url: '/api/account/preferences', ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, payload: '{"set":{}}' }) });
  eq(r.statusCode, 404, `${method} without accounts: 404`);
}
const c = (await app.inject({ method: 'GET', url: '/api/capabilities' })).json();
eq([c.accounts, c.prefs, c.mcp, c.oauthRegistration], [false, false, true, false], 'no accounts, no preference sync; MCP as set; OAuth registration needs accounts');
eq(typeof c.rev === 'string' && /^[0-9a-f]{12}$/.test(c.rev), true, `rev names the web build (${c.rev})`);
const again = (await app.inject({ method: 'GET', url: '/api/capabilities' })).json();
eq(again.rev, c.rev, 'and stays the same while this build runs');

console.log('account-prefs-off: all assertions passed');
await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
