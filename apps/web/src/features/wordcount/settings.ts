import type { AnySettingDef } from '../../settings/types';
import { validStoredRule } from './validate';

/** The 'wordcount.*' settings (WP27). Pure data: import types only, never the store or UI code. */
export const settings: readonly AnySettingDef[] = [
  {
    id: 'wordcount.show',
    section: 'wordcount',
    label: 'Word count in the header',
    hint: 'Shows the count in the preview’s header, or in the editor’s header when only the editor shows. Click it for the breakdown.',
    keywords: 'words length limit count',
    scope: 'device',
    key: 'aldine.wordCount.show',
    default: true,
    validate: (v: unknown): v is boolean => typeof v === 'boolean',
    control: { kind: 'switch' },
    palette: true,
    order: 10,
  },
  {
    id: 'wordcount.rule',
    section: 'wordcount',
    label: 'Word count rule for this project',
    hint: 'What counts toward the total, shared with everyone on the project. By default the main text: no title page, abstract, statements, appendices, supplementary material, references, captions or tables. In-text citations are estimated.',
    keywords: 'words target limit abstract supplementary tables captions references journal',
    scope: 'project',
    default: null,
    validate: validStoredRule,
    control: { kind: 'custom', load: () => import('./RuleEditor').then((m) => ({ default: m.ProjectRuleControl })) },
    order: 20,
  },
  {
    id: 'wordcount.accountRule',
    section: 'wordcount',
    label: 'Your default word count rule',
    hint: 'Used by every project that has no rule of its own.',
    keywords: 'words target limit default',
    scope: 'account',
    default: null,
    validate: (v: unknown): v is null => v === null,
    control: { kind: 'custom', load: () => import('./RuleEditor').then((m) => ({ default: m.AccountRuleControl })) },
    visible: (env) => env.accounts && env.signedIn,
    order: 30,
  },
];
