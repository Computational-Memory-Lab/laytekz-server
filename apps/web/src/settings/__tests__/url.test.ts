import { describe, expect, it } from 'vitest';
import { isSectionId, parseSettingsPath, settingsPath } from '../url';
import { DESKTOP_APP_PATH } from '../types';

describe('settings addresses', () => {
  it('builds the page for a target, on its own or over a project', () => {
    expect(settingsPath()).toBe('/settings');
    expect(settingsPath(null, 'p1')).toBe('/p/p1/settings');
    expect(settingsPath({ section: 'typing' })).toBe('/settings/typing');
    expect(settingsPath({ setting: 'appearance.theme' })).toBe('/settings/appearance#appearance.theme');
    expect(settingsPath({ section: 'editor-text', setting: 'editor.font' }, 'a b')).toBe('/p/a%20b/settings/editor-text#editor.font');
    expect(settingsPath({ setting: 'nobody.here' })).toBe('/settings#nobody.here');
  });

  it('reads an address back', () => {
    expect(parseSettingsPath('/settings')).toEqual({ projectId: null, desktopApp: false });
    expect(parseSettingsPath('/settings/', '')).toEqual({ projectId: null, desktopApp: false });
    expect(parseSettingsPath('/settings/typing', '#typing.explain')).toEqual({ projectId: null, section: 'typing', setting: 'typing.explain', desktopApp: false });
    expect(parseSettingsPath('/p/p1/settings/project')).toEqual({ projectId: 'p1', section: 'project', desktopApp: false });
    expect(parseSettingsPath('/settings/nowhere')).toEqual({ projectId: null, desktopApp: false });
    expect(parseSettingsPath(`/settings/${DESKTOP_APP_PATH}`)).toEqual({ projectId: null, section: 'desktop', desktopApp: true });
    expect(parseSettingsPath('/p/p1')).toBeNull();
    expect(parseSettingsPath('/settings/typing/extra')).toBeNull();
    expect(parseSettingsPath('/p/%E0%A4%A/settings')).toBeNull();
  });

  it('round-trips every section', () => {
    for (const s of ['account', 'appearance', 'editor-text', 'pdf', 'labs', 'project'] as const) {
      expect(isSectionId(s)).toBe(true);
      expect(parseSettingsPath(settingsPath({ section: s }, 'x'))?.section).toBe(s);
    }
    expect(isSectionId('desktop-app')).toBe(false);
  });
});
