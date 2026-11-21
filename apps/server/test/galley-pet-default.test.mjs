/**
 * Galley: the bundled pet (features/pet/server.ts withDefaultPet): used when
 * ALDINE_INSTANCE_PET is unset, replaced by the operator's own image, and
 * switched off with `none`. The bundled files pass the same checks as an
 * operator's image (asset.ts loadPet).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, eq } from './assert.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-pet-default-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');

const { withDefaultPet } = await import('../src/features/pet/server.ts');
const { loadPet } = await import('../src/features/pet/asset.ts');

const bundled = loadPet(withDefaultPet({}));
eq(bundled.warnings, [], 'the bundled images load without warnings');
check(bundled.pet && bundled.pet.type === 'image/png' && bundled.pet.h >= 128, 'the bundled pet is a sharp enough PNG');
check(!!bundled.silhouette, 'with its silhouette');

const own = path.join(tmp, 'own.png');
fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../assets/pet/pet-silhouette.png'), own);
const mine = loadPet(withDefaultPet({ ALDINE_INSTANCE_PET: own }));
check(mine.pet && mine.pet.v !== bundled.pet.v && !mine.silhouette, 'an operator image replaces the bundled pet, silhouette included');

const off = loadPet(withDefaultPet({ ALDINE_INSTANCE_PET: 'None' }));
check(!off.pet && !off.silhouette && off.warnings.length === 0, '`none` means no pet, quietly');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('galley-pet-default: all assertions passed');
