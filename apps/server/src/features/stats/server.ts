import type { ServerFeature } from '../types.js';
import { isStatsStyleDiff, STATS_STYLE_SETTING } from './style.js';

/**
 * F16 statistics, server side (WP33): the project's house style. Stored in
 * ProjectMeta.ext['stats.style'] as the differences from APA 7 only; members
 * change it through PATCH /api/projects/:id/settings, and "Make a copy"
 * keeps it so a copied paper formats the same way.
 */
const feature: ServerFeature = {
  id: 'stats',
  projectSettings: [
    { id: STATS_STYLE_SETTING, validate: isStatsStyleDiff, clientWritable: true, copyWithProject: true },
  ],
};

export default feature;
