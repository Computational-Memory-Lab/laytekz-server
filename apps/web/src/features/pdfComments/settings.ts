import type { AnySettingDef, SettingDef } from '../../settings/types';

/** The 'pdfComments.*' settings (feature 19, package WPX1). Pure data: import types only, never the store or UI code. */

export const PDF_COMMENTS_SETTING_IDS = {
  /** The Comment button beside a PDF selection, the PDF menu's "Comment on this text", and the comment shortcut over the PDF. */
  enabled: 'pdfComments.enabled',
  /** Choosing a comment in Review also scrolls the PDF preview to it. */
  revealInPdf: 'pdfComments.revealInPdf',
} as const;

const ids = PDF_COMMENTS_SETTING_IDS;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

const enabled: SettingDef<boolean> = {
  id: ids.enabled, section: 'pdf', label: 'Comment on text selected in the PDF',
  hint: 'Select text in the PDF preview, then choose Comment (or press the comment shortcut). The comment is placed on the matching text in the source and shows in Review.',
  keywords: 'pdf preview comment annotate selection review synctex source note',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, order: 500,
};

const revealInPdf: SettingDef<boolean> = {
  id: ids.revealInPdf, section: 'pdf', label: 'Show a comment in the PDF when you choose it in Review',
  hint: 'Choosing a comment in the Review panel also scrolls the PDF preview to the commented text, when the preview is beside the editor.',
  keywords: 'pdf preview comment review scroll jump synctex reveal',
  scope: 'account', default: true, validate: isBool, control: { kind: 'switch' }, order: 510,
};

export const settings: readonly AnySettingDef[] = [enabled as AnySettingDef, revealInPdf as AnySettingDef];
