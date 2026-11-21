import type { ServerFeature } from '../types.js';

/**
 * F17 cross-references, server side (WP15). The label index the
 * cross-reference picker and go to definition read is served by V1's
 * `GET /api/projects/:id/labels` in routes.ts, whose entries now carry
 * {label, file, line, from, kind, env, title?, envTitle?, duplicate?}
 * (indexes.labelIndex, labels.ts); a second route for the same path cannot be
 * registered here. This feature registers nothing of its own.
 */
const feature: ServerFeature = { id: 'crossrefs' };

export default feature;
