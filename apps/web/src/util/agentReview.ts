import type { AgentActivity } from '../api';
import { dayAgo, shortDate } from './dates';

export type AgentBatch = Omit<AgentActivity, 'sessionActive'>;

/** Galley: V2 (WP42). The agents the server names in history (gitops.AGENT_AUTHORS), the default first. */
export const AGENT_AUTHORS: readonly string[] = ['Claude', 'Codex'];
const DEFAULT_AGENT = AGENT_AUTHORS[0];
export const isAgentAuthor = (name: string | null | undefined): boolean => !!name && AGENT_AUTHORS.includes(name);

/** Committer names with no person behind them: the product's, then upstream's (gitops.SERVER_COMMIT_NAMES). */
export const SERVER_COMMIT_NAMES: readonly string[] = ['Laytekz', 'Aldine'];

const sameMark = (a: AgentBatch['since'], b: AgentBatch['since']) =>
  (a?.head ?? '') === (b?.head ?? '') && (a?.at ?? '') === (b?.at ?? '');

/**
 * One review prompt is on screen at a time, so a newer batch replaces the
 * prompt for an older one. Acknowledging the replacement moves the mark past
 * both, so it has to carry both. `commits` stays newest first and capped at
 * `limit`; the counts are a floor where the capped lists cannot tell overlap.
 */
export function mergeAgentBatches(older: AgentBatch, newer: AgentBatch, limit: number): AgentBatch {
  // Counted from the same mark, the newer answer already holds the older batch.
  if (sameMark(older.since, newer.since)) return newer;
  const listed = new Set(newer.commits.map((c) => c.hash));
  const extra = older.commits.filter((c) => !listed.has(c.hash));
  const commits = [...newer.commits, ...extra].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const files = new Set(commits.flatMap((c) => c.files));
  return {
    since: older.since,
    head: newer.head,
    commits: commits.slice(0, limit),
    commitCount: newer.commitCount + older.commitCount - (older.commits.length - extra.length),
    fileCount: Math.max(files.size, older.fileCount, newer.fileCount),
    truncated: older.truncated || newer.truncated,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * What the Revert confirmation says: whose commits go (Claude's), when they
 * were made, and whose name the undoing commit carries.
 */
export function revertSummary(r: { commits: number; files: number; branch: string; dates: string[]; author: string | null; agent?: string }, now = Date.now()): string {
  const times = r.dates.map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  let when = '';
  if (times.length) {
    const first = new Date(times[0]).toISOString(), last = new Date(times[times.length - 1]).toISOString();
    const a = dayAgo(first, now), b = dayAgo(last, now);
    when = a === b ? ` ${b}` : ` between ${shortDate(first, now)} and ${shortDate(last, now)}`;
  }
  const by = r.author ? `under your name, ${r.author}` : 'under your name';
  // Galley: V2 (WP42): the agent's own name ("Codex made").
  return `This undoes ${plural(r.commits, 'commit')} ${r.agent || DEFAULT_AGENT} made on ${r.branch}${when}, in ${plural(r.files, 'file')}. `
    + `It adds a new commit ${by}; the history keeps both, and Undo brings the changes back.`;
}

/** "Claude (for Ada)": who asked, from the commits' requester trailers; the
 *  server names the presence the same way (collab.ts agentDisplayName).
 *  Galley: V2 (WP42): `agent` names the agent ("Codex (for Ada)"). */
export function agentName(requesters: Iterable<string | undefined>, agent: string = DEFAULT_AGENT): string {
  const names = [...new Set([...requesters].filter((n): n is string => !!n))];
  return names.length ? `${agent} (for ${names.join(', ')})` : agent;
}

/** Who a set of agent commits is by: "Codex", "Claude and Codex"; Claude when
 *  none says (a server from before the label). */
export function agentLabel(agents: Iterable<string | undefined>): string {
  const named = AGENT_AUTHORS.filter((a) => [...agents].includes(a));
  return named.length ? named.join(' and ') : DEFAULT_AGENT;
}

/** The name the review toast opens with: "Codex (for Ada) edited 2 files". */
export function agentBatchName(commits: Iterable<{ onBehalfOf?: string; agent?: string }>): string {
  const list = [...commits];
  return agentName(list.map((c) => c.onBehalfOf), agentLabel(list.map((c) => c.agent)));
}
