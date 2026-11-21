/**
 * Settings page addresses (WP02 settings-core). The page lives at
 * /settings/<section>#<setting id> and, over a project's editor, at
 * /p/<id>/settings/<section>#<setting id>; /settings/desktop-app is the
 * desktop shell's own settings window, which the web page shows as the
 * 'desktop' section. Paths here are inside the app, before withBase().
 */
import { DESKTOP_APP_PATH, type SectionId, type SettingsTarget } from './types';
import { SECTIONS, settingDef } from './registry';

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && SECTION_IDS.has(v);
}

/** The page for `t`: its section (the setting's own when only a setting is given) and the setting as the hash. */
export function settingsPath(t?: SettingsTarget | null, projectId?: string | null): string {
  const section = t?.section ?? (t?.setting ? settingDef(t.setting)?.section : undefined);
  const prefix = projectId ? `/p/${encodeURIComponent(projectId)}/settings` : '/settings';
  return `${prefix}${section ? `/${section}` : ''}${t?.setting ? `#${encodeURIComponent(t.setting)}` : ''}`;
}

export interface SettingsLocation {
  /** The project the page is opened over; null on /settings. */
  projectId: string | null;
  /** Undefined: the first section (no segment, or one that names no section). */
  section?: SectionId;
  setting?: string;
  /** The path was /settings/desktop-app. */
  desktopApp: boolean;
}

const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

/** What a settings address asks for; null when `pathname` is not a settings page. */
export function parseSettingsPath(pathname: string, hash = ''): SettingsLocation | null {
  const m = /^(?:\/p\/([^/]+))?\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return null;
  const projectId = m[1] ? decode(m[1]) : null;
  if (m[1] && !projectId) return null;
  const segment = m[2] ? decode(m[2]) : null;
  const desktopApp = segment === DESKTOP_APP_PATH;
  const section = desktopApp ? 'desktop' : isSectionId(segment) ? segment : undefined;
  const setting = hash.length > 1 && hash.startsWith('#') ? decode(hash.slice(1)) ?? undefined : undefined;
  return { projectId, ...(section ? { section } : {}), ...(setting ? { setting } : {}), desktopApp };
}
