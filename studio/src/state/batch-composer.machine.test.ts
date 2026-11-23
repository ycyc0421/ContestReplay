import {
  batchComposerReducer,
  cellKey,
  createInitialBatchComposerState,
} from './batch-composer.machine';

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
