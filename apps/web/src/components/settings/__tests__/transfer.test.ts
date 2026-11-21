import { describe, expect, it } from 'vitest';
import type { AnySettingDef } from '../../../settings/types';
import { buildExport, describeValue, isPortable, planImport, TRANSFER_FORMAT } from '../transfer';

const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const num = (v: unknown): v is number => typeof v === 'number' && v >= 10 && v <= 24;
const theme = (v: unknown): v is string => v === 'system' || v === 'light' || v === 'dark';
const defs: AnySettingDef[] = [
  { id: 'appearance.theme', section: 'appearance', label: 'Theme', scope: 'account', default: 'system', validate: theme, key: 'aldine.theme',
    control: { kind: 'segmented', options: [{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] } },
  { id: 'editor.fontSize', section: 'editor-text', label: 'Font size', scope: 'account', default: 13.5, validate: num, control: { kind: 'slider', min: 10, max: 24, step: 0.5, unit: 'px' } },
  { id: 'editor.vim', section: 'editor-behaviour', label: 'Vim keybindings', scope: 'account', default: false, validate: bool, control: { kind: 'switch' } },
  { id: 'labs.agentPresence', section: 'labs', label: 'Agent edit highlights', scope: 'device', default: false, validate: bool, control: { kind: 'switch' } },
  { id: 'editor.mode', section: 'editor-behaviour', label: 'Editor mode', scope: 'device', default: 'source', validate: (v): v is string => typeof v === 'string', control: { kind: 'switch' } },
  { id: 'account.sync', section: 'account', label: 'Keep my settings in my account', scope: 'device', default: true, validate: bool, control: { kind: 'switch' } },
  { id: 'wordcount.rule', section: 'wordcount', label: 'Count', scope: 'project', default: 'main', validate: (v): v is string => typeof v === 'string', control: { kind: 'text' } },
];
const lookup = (id: string) => defs.find((d) => d.id === id);

describe('settings export', () => {
  it('writes the non-default account and device settings only', () => {
    const values: Record<string, unknown> = {
      'appearance.theme': 'dark', 'editor.fontSize': 13.5, 'editor.vim': true, 'labs.agentPresence': false,
      'editor.mode': 'visual', 'account.sync': false, 'wordcount.rule': 'all',
    };
    const file = buildExport(defs, (id) => values[id], (d) => d.default, new Date('2026-11-21T10:00:00Z'));
    expect(file).toEqual({ format: TRANSFER_FORMAT, version: 1, exportedAt: '2026-11-21T10:00:00.000Z', settings: { 'appearance.theme': 'dark', 'editor.vim': true } });
  });

  it('never carries project settings, the toolbar state or the sync switch', () => {
    expect(isPortable(lookup('wordcount.rule')!)).toBe(false);
    expect(isPortable(lookup('editor.mode')!)).toBe(false);
    expect(isPortable(lookup('account.sync')!)).toBe(false);
    expect(isPortable(lookup('editor.vim')!)).toBe(true);
  });
});

describe('settings import', () => {
  const current: Record<string, unknown> = { 'appearance.theme': 'system', 'editor.fontSize': 13.5, 'editor.vim': true, 'labs.agentPresence': false };
  const value = (id: string) => current[id];
  const file = (settings: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ format: TRANSFER_FORMAT, version: 1, exportedAt: 'x', settings, ...extra });

  it('lists what changes, skips invalid values, ignores unknown and project ids', () => {
    const plan = planImport(file({
      'appearance.theme': 'dark', 'editor.fontSize': 99, 'editor.vim': true, 'nope.thing': 1, 'wordcount.rule': 'all', 'editor.mode': 'visual',
    }), lookup, value);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.changes).toEqual([{ id: 'appearance.theme', label: 'Theme', from: 'system', to: 'dark' }]);
    expect(plan.invalid).toEqual(['editor.fontSize']);
    expect(plan.ignored.sort()).toEqual(['editor.mode', 'nope.thing', 'wordcount.rule']);
    expect(plan.same).toBe(1);
  });

  it('refuses what is not a settings file, and files from a newer version', () => {
    expect(planImport('not json', lookup, value)).toHaveProperty('error');
    expect(planImport(JSON.stringify({ format: 'other', settings: {} }), lookup, value)).toHaveProperty('error');
    expect(planImport(file({}, { version: 2 }), lookup, value)).toHaveProperty('error');
    expect(planImport(file([]), lookup, value)).toHaveProperty('error');
  });

  it('round-trips an export', () => {
    const exported = buildExport(defs, (id) => ({ ...current, 'appearance.theme': 'light', 'editor.fontSize': 16 })[id], (d) => d.default);
    const plan = planImport(JSON.stringify(exported), lookup, value);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.changes.map((c) => [c.id, c.to])).toEqual([['appearance.theme', 'light'], ['editor.fontSize', 16]]);
  });

  it('names values the way the page does', () => {
    expect(describeValue(lookup('appearance.theme'), 'system')).toBe('Match system');
    expect(describeValue(lookup('editor.fontSize'), 15)).toBe('15 px');
    expect(describeValue(lookup('editor.vim'), true)).toBe('On');
    expect(describeValue(undefined, { a: 1, b: 2 })).toBe('2 changes');
  });
});
