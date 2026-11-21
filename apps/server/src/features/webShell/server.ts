import type { ServerFeature } from '../types.js';
import { config } from '../../config.js';
import { currentInstance } from '../../instance.js';
import { SIGNUP_MODE, AUTH_ENABLED } from '../../auth.js';
import { sourceUrl } from '../../galley-source.js';
import { PAGE_CSP, aboutPage, desktopUrl, securityTxt } from './pages.js';

/**
 * F6 web readiness (WP45), server side:
 * - GET <base>/about: the public "about this site" page (server-rendered, script-free);
 * - GET /.well-known/security.txt: the support contact (404 without one);
 * - capability `desktopUrl`: GALLEY_DESKTOP_URL when it is https, for the
 *   sign-in card's download link (public: signed-out visitors see it).
 */
const feature: ServerFeature = {
  id: 'webShell',
  register(app) {
    app.get('/about', async (_req, reply) => reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', PAGE_CSP)
      .send(aboutPage({
        instance: currentInstance(),
        basePath: config.basePath,
        approval: AUTH_ENABLED && SIGNUP_MODE === 'approval',
        desktop: desktopUrl(),
        source: sourceUrl(),
      })));
    app.get('/.well-known/security.txt', async (_req, reply) => {
      const body = securityTxt(currentInstance().support, config.publicUrl ? `${new URL(config.publicUrl).origin}/.well-known/security.txt` : null);
      if (!body) return reply.code(404).header('cache-control', 'no-store').send({ error: 'not found' });
      return reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(body);
    });
  },
  capabilities: () => {
    const url = desktopUrl();
    return url ? { desktopUrl: url } : {};
  },
};

export default feature;
