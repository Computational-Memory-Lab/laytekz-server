import type { FeatureModule } from '../types';
import { apiRequest } from '../../api';
import { getSetting } from '../../settings/store';
import { CHECK_EVERY_MS, UPDATE_SETTING, createVersionCheck, pageRevision } from './versionCheck';
import AdminWaiting from './AdminWaiting';

/**
 * F6 web readiness (WP45), web side: the "Laytekz was updated" notice
 * (versionCheck.ts), started once per tab on every page. The sign-in card's
 * About and desktop links live in components/ProductCredit.tsx (api.ts).
 */
const feature: FeatureModule = {
  id: 'webShell',
  // The "N waiting" chip for administrators (draws nothing for anyone else, or when nobody waits).
  slots: [{ id: 'webShell.adminWaiting', slot: 'home.toolbar', order: 100, when: (p) => !!p.app.user(), render: AdminWaiting }],
  boot(app) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const vc = createVersionCheck({
      own: pageRevision(),
      fetchRev: async () => {
        const caps = await apiRequest<{ rev?: unknown }>('/api/capabilities', { cache: 'no-store' });
        return typeof caps?.rev === 'string' ? caps.rev : '';
      },
      enabled: () => { try { return getSetting<boolean>(UPDATE_SETTING) !== false; } catch { return true; } },
      notify: (text, action) => app.toast(text, 'info', action),
      reload: () => window.location.reload(),
      now: () => Date.now(),
    });
    const onVisible = () => { if (document.visibilityState === 'visible') void vc.check(); };
    const onOnline = () => { void vc.check(true); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void vc.check(true); }, CHECK_EVERY_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  },
};

export default feature;
