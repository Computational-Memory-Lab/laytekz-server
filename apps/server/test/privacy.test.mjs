/**
 * Galley: the privacy page (privacy.ts) at <base path>/privacy: served to
 * anyone, script-free, in the sign-in pages' shell, naming the product, and
 * pointing deletion requests at the support contact when there is one.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aldine-privacy-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_SSO_ONLY = '1';
process.env.ALDINE_BASE_PATH = '/x';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_PUBLIC_URL', 'ALDINE_SUPPORT', 'ALDINE_INSTANCE_NAME']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<!doctype html><title>Laytekz</title>\n');

const { privacyPage } = await import('../src/privacy.ts');
const { initDb } = await import('../src/db/index.ts');
await initDb();
const { buildApp } = await import('../src/app.ts');
const app = await buildApp();

{
  const r = await app.inject({ method: 'GET', url: '/x/privacy' });
  eq(r.statusCode, 200, 'served without signing in');
  check(String(r.headers['content-type']).startsWith('text/html'), 'as a page');
  check(!/<script/i.test(r.body) && String(r.headers['content-security-policy']).includes("default-src 'none'"), 'script-free');
  eq(r.headers['x-frame-options'], 'DENY', 'never framed');
  check(r.body.includes('<title>Privacy · Laytekz</title>'), `titled with the product (${r.body.slice(0, 300)})`);
  check(r.body.includes('<main class="wide">'), 'the reading width');
  check(r.body.includes('Laytekz is a LaTeX editor') && !r.body.includes('{{'), 'placeholders filled in');
  check(r.body.includes('ask the person who invited you to this site'), 'no support contact: the person who invited you');
  check(r.body.includes('href="/x/" data-testid="privacy-back">Back to Laytekz</a>'), 'a way back under the base path');
  check(!r.body.includes('Aldine'), 'no upstream name on the page');
}

check(privacyPage({ kind: 'email', value: 'help@example.org' }, '/').includes('write to <a href="mailto:help@example.org">help@example.org</a>'), 'an email contact');
check(privacyPage({ kind: 'url', value: 'https://help.example.org/?a=1&b="2"' }, '/').includes('<a href="https://help.example.org/?a=1&#38;b=&#34;2&#34;">the support page</a>'), 'a support page, escaped');

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('privacy: ALL PASSED');
