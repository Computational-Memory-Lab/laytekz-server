/**
 * Laytekz V2 server feature manifest (WP01, frozen): every server feature, in
 * registration order. Only the integrator edits this list; a package fills its
 * own features/<id>/server.ts. Nothing imports it until app.ts calls
 * registerFeatures (features/host.ts, WP03).
 */
import type { ServerFeature } from './types.js';
import escapeFeature from './escape/server.js';
import automathFeature from './automath/server.js';
import pairsFeature from './pairs/server.js';
import envcloseFeature from './envclose/server.js';
import suggestFeature from './suggest/server.js';
import mathPreviewFeature from './mathPreview/server.js';
import tablesFeature from './tables/server.js';
import citationsFeature from './citations/server.js';
import crossrefsFeature from './crossrefs/server.js';
import linksFeature from './links/server.js';
import referencesFeature from './references/server.js';
import librariesFeature from './libraries/server.js';
import renameFeature from './rename/server.js';
import outputsFeature from './outputs/server.js';
import wordcountFeature from './wordcount/server.js';
import petFeature from './pet/server.js';
import highlighterFeature from './highlighter/server.js';
import statsFeature from './stats/server.js';
import agentsFeature from './agents/server.js';
import webShellFeature from './webShell/server.js';
import pdfCommentsFeature from './pdfComments/server.js';
import refManagersFeature from './refManagers/server.js';
import probeFeature from './_probe/server.js';

export const SERVER_FEATURES: readonly ServerFeature[] = [
  escapeFeature,
  automathFeature,
  pairsFeature,
  envcloseFeature,
  suggestFeature,
  mathPreviewFeature,
  tablesFeature,
  citationsFeature,
  crossrefsFeature,
  linksFeature,
  referencesFeature,
  librariesFeature,
  renameFeature,
  outputsFeature,
  wordcountFeature,
  petFeature,
  highlighterFeature,
  statsFeature,
  agentsFeature,
  webShellFeature,
  pdfCommentsFeature,
  refManagersFeature,
  probeFeature,
];
