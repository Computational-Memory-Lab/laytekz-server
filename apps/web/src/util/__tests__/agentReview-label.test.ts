// Galley: V2 (WP42): edits made by Codex are labelled Codex, not Claude.
import { describe, expect, it } from 'vitest';
import { agentBatchName, agentLabel, agentName, isAgentAuthor, revertSummary, SERVER_COMMIT_NAMES } from '../agentReview';

describe('agent label', () => {
  it('knows both agents and nobody else', () => {
    expect(isAgentAuthor('Claude')).toBe(true);
    expect(isAgentAuthor('Codex')).toBe(true);
    expect(isAgentAuthor('Ada')).toBe(false);
    expect(isAgentAuthor('codex')).toBe(false);
    expect(isAgentAuthor(undefined)).toBe(false);
  });

  it('names the agent and for whom', () => {
    expect(agentName([])).toBe('Claude');
    expect(agentName(['Ada'])).toBe('Claude (for Ada)');
    expect(agentName(['Ada', undefined, 'Ada'], 'Codex')).toBe('Codex (for Ada)');
  });

  it('labels a batch by the agents its commits name', () => {
    expect(agentLabel([])).toBe('Claude');
    expect(agentLabel([undefined])).toBe('Claude');
    expect(agentLabel(['Codex', 'Codex'])).toBe('Codex');
    expect(agentLabel(['Codex', 'Claude'])).toBe('Claude and Codex');
    expect(agentLabel(['Somebody'])).toBe('Claude');
  });

  it('opens the review toast with the batch’s agent', () => {
    expect(agentBatchName([{ agent: 'Codex' }])).toBe('Codex');
    expect(agentBatchName([{ agent: 'Codex', onBehalfOf: 'Ada' }, { agent: 'Codex', onBehalfOf: 'Grace' }])).toBe('Codex (for Ada, Grace)');
    // A server from before the label sends no `agent`: Claude, as before.
    expect(agentBatchName([{ onBehalfOf: 'Ada' }])).toBe('Claude (for Ada)');
  });

  it('says which agent made the commits a revert undoes', () => {
    expect(revertSummary({ commits: 1, files: 1, branch: 'main', dates: [], author: null, agent: 'Codex' })).toMatch(/^This undoes 1 commit Codex made on main, in 1 file\./);
    expect(revertSummary({ commits: 1, files: 1, branch: 'main', dates: [], author: null })).toMatch(/Claude made/);
  });

  it('treats the server’s own name, old and new, as no person', () => {
    expect(SERVER_COMMIT_NAMES).toEqual(['Laytekz', 'Aldine']);
  });
});
