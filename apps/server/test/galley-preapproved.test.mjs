/**
 * Galley: the pre-approved list (galley-preapproved.ts): what counts as an
 * entry, address and domain matching, and that a save replaces the list and
 * an outside edit of the file is picked up.
 *
 * Env must be set before any src import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-preapproved-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN']) delete process.env[k];

const { parseEntries, isPreApproved, setPreApproved, preApproved } = await import('../src/galley-preapproved.ts');
const { metaDir } = await import('../src/config.ts');

{
  const r = parseEntries('Email address,Nickname,Role\n"Ada@Example.org",Ada,owner\n<bob@lab.example.org>; @Uni.example  ada@example.org');
  eq(r.entries, ['ada@example.org', 'bob@lab.example.org', '@uni.example'], 'a pasted member list keeps the addresses and domains, once each');
  eq(r.invalid, [], 'words without an @ are skipped, not refused');
  eq(parseEntries('ada@ @@x.org a@b').invalid.length, 3, 'malformed entries are reported');
}

check(!isPreApproved('ada@example.org'), 'nobody is approved before a list exists');
eq(preApproved().entries, [], 'the empty list');

setPreApproved('ada@example.org\n@uni.example', 'test');
check(isPreApproved('Ada@Example.org'), 'a listed address, whatever its case');
check(isPreApproved('someone@uni.example'), 'an address at a listed domain');
check(!isPreApproved('someone@sub.uni.example'), 'a subdomain is a different domain');
check(!isPreApproved('eve@example.org') && !isPreApproved('') && !isPreApproved(null) && !isPreApproved('@uni.example'), 'everyone else waits');
eq(preApproved().updatedBy, 'test', 'who saved it');

let threw = false;
try { setPreApproved('ada@example.org\nnot@valid', 'test'); } catch { threw = true; }
check(threw && preApproved().entries.length === 2, 'a bad entry saves nothing');

// An edit made on the server itself (or by a script) applies without a restart.
const file = path.join(metaDir, 'preapproved.json');
fs.writeFileSync(file, JSON.stringify({ entries: ['carol@example.org'] }));
fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
check(isPreApproved('carol@example.org') && !isPreApproved('ada@example.org'), 'the file is read again when it changes');

fs.writeFileSync(file, '{ not json');
fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
check(!isPreApproved('carol@example.org'), 'an unreadable list approves nobody');

setPreApproved('', 'test');
check(!isPreApproved('carol@example.org'), 'clearing the list');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('galley-preapproved: all assertions passed');
