/**
 * Laytekz V2 server feature contracts (WP01, frozen). Only the integrator
 * changes this file; a package that needs a change files a request
 * (docs/galley-v2/README.md). Type-only apart from the constants.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type * as Y from 'yjs';
import type { PublicUser } from '../auth.js';
import type { CommitAuthor } from '../gitops.js';
import type { ProjectMeta } from '../db/types.js';

/** The same list as apps/web/src/features/types.ts (scripts/v2/check-contracts.mjs compares them). */
export const FEATURE_IDS = [
  'escape', 'automath', 'pairs', 'envclose', 'suggest', 'mathPreview', 'tables', 'citations', 'crossrefs',
  'links', 'references', 'libraries', 'rename', 'outputs', 'wordcount', 'pet', 'highlighter', 'stats',
  'agents', 'webShell', 'pdfComments', 'refManagers', '_probe',
] as const;
export type FeatureId = typeof FEATURE_IDS[number];

/** A key in `ProjectMeta.ext`. Every key must have one: PATCH refuses unknown
 *  keys, and publicMeta drops them. */
export interface ProjectSettingDef {
  /** The client's SettingDef id for the same value ('<featureId>.<name>'). */
  id: string;
  validate(v: unknown): boolean;
  /** PATCH /api/projects/:id/settings may set or unset it (members only). */
  clientWritable: boolean;
  /** Sent to clients (GET /api/projects/:id and /settings). Default true; a
   *  value that must never leave the server sets false. No secret is ever
   *  stored in `ext`, either way: V1's publicMeta would expose it. */
  clientVisible?: boolean;
  /** Copied by "Make a copy" (store.copyProject). Default false. */
  copyWithProject?: boolean;
}

export interface ServerFeature {
  id: FeatureId;
  /** Called once at boot, after registerRoutes, so every global guard (origin
   *  check, session, rate limits) already covers these routes. */
  register?(app: FastifyInstance, kit: RouteKit): void | Promise<void>;
  projectSettings?: readonly ProjectSettingDef[];
  /** Merged into GET /api/capabilities under keys the feature names. */
  capabilities?(req: FastifyRequest): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Feature writes under /api/projects/:id are closed to bearer tokens and
   *  to viewers unless listed here as 'METHOD /route/pattern'
   *  ('POST /api/projects/:id/references/insert'). Each entry is justified in
   *  the package's notes. */
  tokenWrites?: readonly string[];
  viewerWrites?: readonly string[];
  /** After a collab doc's snapshot is applied, before any client sees it. */
  onDocLoad?(doc: Y.Doc, name: string): void;
}

export interface RouteKit {
  user(req: FastifyRequest): PublicUser | null;
  author(req: FastifyRequest): CommitAuthor | undefined;
  /** Anyone who may open the project (links, viewers, tokens with access); replies 403/404 itself and resolves null. */
  requireAccess(req: FastifyRequest, reply: FastifyReply): Promise<ProjectMeta | null>;
  /** Owner or collaborator; `action` names what was refused ("add references"). Never a showcase. */
  requireMember(req: FastifyRequest, reply: FastifyReply, action: string): Promise<ProjectMeta | null>;
  requireOwner(req: FastifyRequest, reply: FastifyReply, action: string): Promise<ProjectMeta | null>;
  readExt<T>(meta: ProjectMeta, id: string): T | undefined;
  /** Validates each key against the features' ProjectSettingDefs (throws on an unknown or invalid one), writes, bumps the rev and signals 'settings'. */
  writeExt(projectId: string, set: Record<string, unknown>, unset?: string[]): Promise<ProjectMeta>;
  /** collab.signalBranch: sets `key` to `value` in the branch's files-signal map ('*': every loaded branch). */
  signal(projectId: string, branch: string | '*', key: string, value: unknown): void;
  /** A token bucket per name and caller; false when this request is over the limit. */
  limiter(name: string, o: { burst: number; perSecond: number }): (req: FastifyRequest) => boolean;
}

/** GET /api/capabilities (apps/web/src/features/types.ts mirrors it). */
export interface Capabilities {
  rev: string;
  accounts: boolean;
  prefs: boolean;
  mcp: boolean;
  oauthRegistration: boolean;
  [feature: string]: unknown;
}

// ---- collab.ts primitives (WP03 builds them; consumers come in later waves) ----

/** collab.branchChangeEvents' payload: a branch's files changed; `paths` null means the whole tree (a git operation). */
export interface BranchChange { projectId: string; branch: string; paths: readonly string[] | null; version: number }

export interface BranchChangesEmitter {
  on(event: 'change', fn: (c: BranchChange) => void): unknown;
  off(event: 'change', fn: (c: BranchChange) => void): unknown;
}

export type DocLoadHook = (doc: Y.Doc, name: string) => void;

// ---- Wire contracts shared with the web app (apps/web/src/settings/types.ts mirrors them) ----

export interface AccountPrefsResponse { prefs: Record<string, unknown>; rev: number; updatedAt: string | null }
export interface AccountPrefsPatch { set?: Record<string, unknown>; unset?: string[]; keepExisting?: boolean }
export interface AccountPrefsPut { prefs: Record<string, unknown> }
export interface ProjectSettingsResponse { values: Record<string, unknown>; rev: number }
export interface ProjectSettingsPatch { set?: Record<string, unknown>; unset?: string[] }

export const PREF_KEY_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){1,3}$/;
export const PREF_LIMITS = { keysPerRequest: 64, keysStored: 300, valueBytes: 2048, valueDepth: 3, totalBytes: 32768 } as const;
/** The `connections` row's provider for account preferences. */
export const PREFS_PROVIDER = 'laytekz-preferences';
/** The branch-signal key a project settings write bumps (value: the new rev). */
export const PROJECT_SETTINGS_SIGNAL = 'settings';
/** The branch-signal key and value for files moved on the server (WP28
 *  sends it; the web page host emits its `filesMoved` event from it). */
export const FILES_MOVED_SIGNAL = 'moves';
export interface FilesMovedSignal { moves: [string, string][]; by: string | null; at: number }
/** Where the project settings revision is kept inside `ProjectMeta.ext` (never a client key). */
export const EXT_REV_KEY = '_rev';
