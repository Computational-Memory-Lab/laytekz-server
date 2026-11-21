/**
 * The rename routes (WP28) and the undo routes the rename uses, through the
 * app's one request helper. Kept apart from the flow so its tests can replace it.
 */
import { api, apiRequest } from '../../api';
import type { ApplyBody, ApplyResult } from './plan';

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export interface RenameClient {
  plan(projectId: string, branch: string, from: string, to: string): Promise<unknown>;
  apply(projectId: string, body: ApplyBody): Promise<ApplyResult>;
  titlePlan(projectId: string, branch: string, from: string, to: string): Promise<unknown>;
  titleApply(projectId: string, body: { branch: string; from: string; to: string; edits: string[] }): Promise<{ ok: boolean; commit?: string; edited: number; undo?: string | null }>;
  /** Reverts the commits (a rename's commit puts names, text and the main document back). */
  revert(projectId: string, branch: string, hashes: string[], message: string): Promise<{ ok: boolean; newRoot?: string }>;
  /** Restores an undo image (projects that commit by hand). */
  undo(projectId: string, branch: string, token: string): Promise<{ ok: boolean; restored?: string[]; skipped?: string[]; newRoot?: string }>;
  renameProject(projectId: string, name: string): Promise<unknown>;
}

export const renameClient: RenameClient = {
  plan: (projectId, branch, from, to) => apiRequest(`${base(projectId)}/file/rename-plan?${qs({ branch, from, to })}`),
  apply: (projectId, body) => apiRequest(`${base(projectId)}/file/rename-apply`, post(body)),
  titlePlan: (projectId, branch, from, to) => apiRequest(`${base(projectId)}/title-plan`, post({ branch, from, to })),
  titleApply: (projectId, body) => apiRequest(`${base(projectId)}/title-apply`, post(body)),
  revert: (projectId, branch, hashes, message) => apiRequest(`${base(projectId)}/revert`, post({ branch, hashes, message })),
  undo: (projectId, branch, token) => apiRequest(`${base(projectId)}/undo`, post({ branch, token })),
  renameProject: (projectId, name) => api.patchProject(projectId, { name }),
};
