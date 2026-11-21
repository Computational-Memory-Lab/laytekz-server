/**
 * Galley: the pre-approved list at sign-in (auth.ts with
 * galley-preapproved.ts), under ALDINE_SIGNUP=approval and single sign-on:
 * a listed address or domain gets an active account, everyone else waits, a
 * waiting account that is listed later gets in at its next sign-in, a listed
 * account is not an administrator, and an account an administrator disabled
 * stays disabled.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-preapproved-signin-'));
Object.assign(process.env, {
  AUTH_ENABLED: '1',
  ALDINE_SSO_ONLY: '1',
  ALDINE_SIGNUP: 'approval',
  ALDINE_ADMIN_EMAILS: 'boss@example.org',
  DATA_DIR: path.join(tmp, 'data'),
  META_DIR: path.join(tmp, 'meta'),
  CACHE_DIR: path.join(tmp, 'cache'),
});
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'SMTP_HOST']) delete process.env[k];

const { initDb, db } = await import('../src/db/index.ts');
await initDb();
const auth = await import('../src/auth.ts');
const { isAdmin } = await import('../src/authz.ts');
const { setPreApproved } = await import('../src/galley-preapproved.ts');

const signIn = (email, n) => auth.findOrCreateOAuth({ email, name: email.split('@')[0], subject: `google:${n}` }, 'google');
const waits = async (email, n) => {
  try { await signIn(email, n); return false; } catch (err) { return err instanceof auth.AwaitingApprovalError; }
};

check(await waits('eve@example.org', 1), 'with an empty list a new account waits');

setPreApproved('ada@example.org\n@lab.example', 'test');
const ada = await signIn('ada@example.org', 2);
check(!!ada?.id && !(await db().getUser(ada.id)).disabledAt, 'a listed address gets an active account at once');
check(!isAdmin(ada), 'and is an ordinary account, not an administrator');
const member = await signIn('someone@lab.example', 3);
check(!!member?.id && !(await db().getUser(member.id)).disabledAt, 'so does an address at a listed domain');
check(await waits('eve@example.org', 1), 'someone not on the list still waits');
check(await waits('mallory@elsewhere.example', 4), 'and so does a new stranger');

setPreApproved('ada@example.org\n@lab.example\neve@example.org', 'test');
const eve = await signIn('eve@example.org', 1);
check(!!eve?.id && !(await db().getUser(eve.id)).disabledAt, 'a waiting account that is listed later gets in at its next sign-in');

await auth.disableAccount(ada.id, false);
let refused = '';
try { await signIn('ada@example.org', 2); } catch (err) { refused = err.message; }
eq(refused, auth.ACCOUNT_DISABLED, 'an account an administrator disabled stays disabled, listed or not');

setPreApproved('', 'test');
check(await waits('newcomer@lab.example', 5), 'clearing the list brings the wait back for new accounts');
check(!!(await signIn('someone@lab.example', 3))?.id, 'accounts approved earlier keep working');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('galley-preapproved-signin: all assertions passed');
