import type { PlanResponse } from '@studio-api';
import {
  batchComposerReducer,
  cellKey,
  createInitialBatchComposerState,
  sanitizeBatchDraft,
} from './batch-composer.machine';

const fakePlan: PlanResponse = {
  token: '11111111-1111-4111-8111-111111111111',
  jobs: [{ agent_id: 'a', agent_revision: 'r'.repeat(64), contest_id: 'c', data_version: 1 }],
};

describe('batchComposerReducer', () => {
  it('prunes deleted/invalid agents and contests from draft selections', () => {
    let s = createInitialBatchComposerState({
      agents: ['agents/a.toml', 'agents/deleted.toml'],
      contests: ['contests/c.json', 'contests/broken.json'],
      cells: [
        cellKey('agents/a.toml', 'contests/c.json'),
        cellKey('agents/deleted.toml', 'contests/broken.json'),
      ],
    });
    s = batchComposerReducer(s, { type: 'RECONCILE_AGENTS', validPaths: new Set(['agents/a.toml']) });
    s = batchComposerReducer(s, { type: 'RECONCILE_CONTESTS', validPaths: new Set(['contests/c.json']) });
    expect(s.selectedAgents).toEqual(['agents/a.toml']);
    expect(s.selectedContests).toEqual(['contests/c.json']);
    expect(s.selectedCells).toEqual([cellKey('agents/a.toml', 'contests/c.json')]);
  });

  it('discards stale PLAN_READY and invalidates existing plan when FILTER_INCOMPATIBLE removes cells', () => {
    let s = createInitialBatchComposerState({
      agents: ['agents/a.toml'],
      contests: ['contests/c.json'],
      cells: [cellKey('agents/a.toml', 'contests/c.json')],
    });
    const gen0 = s.selectionGen;
    // User toggles cell while plan request is in-flight
    s = batchComposerReducer(s, { type: 'TOGGLE_CELL', agent: 'agents/a.toml', contest: 'contests/c.json' });
    // Late plan response from gen0 MUST be ignored
    s = batchComposerReducer(s, { type: 'PLAN_READY', plan: fakePlan, gen: gen0 });
    expect(s.plan).toBeNull();
    expect(s.stage).not.toBe('review');

    // Re-select and accept plan at current gen
    s = batchComposerReducer(s, { type: 'TOGGLE_CELL', agent: 'agents/a.toml', contest: 'contests/c.json' });
    s = batchComposerReducer(s, { type: 'PLAN_READY', plan: fakePlan, gen: s.selectionGen });
    expect(s.plan).toEqual(fakePlan);
    expect(s.stage).toBe('review');

    // Incompatible filter removes the cell AND MUST invalidate the plan
    s = batchComposerReducer(s, {
      type: 'FILTER_INCOMPATIBLE',
      compatibleMap: new Map([[cellKey('agents/a.toml', 'contests/c.json'), false]]),
    });
    expect(s.selectedCells).toEqual([]);
    expect(s.plan).toBeNull();
    expect(s.stage).toBe('matrix');
  });

  it('sanitizes malformed sessionStorage draft entries safely without throwing', () => {
    const clean = sanitizeBatchDraft({
      agents: ['agents/a.toml', 123, ''],
      contests: ['contests/c.json'],
      cells: ['{broken-json', JSON.stringify(['only-one']), cellKey('agents/a.toml', 'contests/c.json'), cellKey('agents/ghost.toml', 'contests/c.json')],
    });
    expect(clean).toEqual({
      agents: ['agents/a.toml'],
      contests: ['contests/c.json'],
      cells: [cellKey('agents/a.toml', 'contests/c.json')],
    });
  });

  it('adds pending agent via URL param and pairs only against valid contests', () => {
    let s = createInitialBatchComposerState({
      agents: [],
      contests: ['contests/valid.json', 'contests/stale.json'],
      cells: [],
    });
    s = batchComposerReducer(s, {
      type: 'ADD_PENDING',
      kind: 'agent',
      path: 'agents/fresh.toml',
      validOpposite: new Set(['contests/valid.json']),
    });
    expect(s.selectedAgents).toEqual(['agents/fresh.toml']);
    expect(s.selectedCells).toEqual([cellKey('agents/fresh.toml', 'contests/valid.json')]);
  });
});
