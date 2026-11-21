/**
 * Laytekz V2 feature manifest (WP01, frozen): every feature module, in the
 * order hosts apply them (completion filters, slot ties, menus). Static on
 * purpose: nothing is included by surprise and everything typechecks. Only
 * the integrator edits this list; a package fills its own features/<id>/.
 * Nothing imports this file until the page host (WP06) does.
 */
import type { FeatureModule } from './types';
import escapeFeature from './escape';
import automathFeature from './automath';
import pairsFeature from './pairs';
import envcloseFeature from './envclose';
import suggestFeature from './suggest';
import mathPreviewFeature from './mathPreview';
import tablesFeature from './tables';
import citationsFeature from './citations';
import crossrefsFeature from './crossrefs';
import linksFeature from './links';
import referencesFeature from './references';
import librariesFeature from './libraries';
import renameFeature from './rename';
import outputsFeature from './outputs';
import wordcountFeature from './wordcount';
import petFeature from './pet';
import highlighterFeature from './highlighter';
import statsFeature from './stats';
import agentsFeature from './agents';
import webShellFeature from './webShell';
import pdfCommentsFeature from './pdfComments';
import refManagersFeature from './refManagers';
import probeFeature from './_probe';

export const FEATURES: readonly FeatureModule[] = [
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
