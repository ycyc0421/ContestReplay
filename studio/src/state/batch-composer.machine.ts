import type { PlanResponse, PreflightReport } from '@studio-api';

export type BatchStage = 'catalog' | 'matrix' | 'review';
export type MatrixView = 'matrix' | 'list';

export const cellKey = (agent: string, contest: string) => JSON.stringify([agent, contest]);

export function parseCellSafe(key: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      parsed[0].length > 0 &&
      typeof parsed[1] === 'string' &&
      parsed[1].length > 0
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // malformed entry
  }
  return null;
}

export const parseCell = (key: string): [string, string] => parseCellSafe(key) ?? ['', ''];

export interface BatchDraft {
  agents: string[];
  contests: string[];
  cells: string[];
}

export function sanitizeBatchDraft(raw: unknown): BatchDraft {
  if (!raw || typeof raw !== 'object') return { agents: [], contests: [], cells: [] };
  const rec = raw as Partial<BatchDraft>;
  const agents = [...new Set((Array.isArray(rec.agents) ? rec.agents : []).filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const contests = [...new Set((Array.isArray(rec.contests) ? rec.contests : []).filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const agentSet = new Set(agents);
  const contestSet = new Set(contests);
  const cells: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rec.cells) ? rec.cells : []) {
    if (typeof item !== 'string') continue;
    const pair = parseCellSafe(item);
    if (!pair) continue;
    if (!agentSet.has(pair[0]) || !contestSet.has(pair[1])) continue;
    const canonical = cellKey(pair[0], pair[1]);
    if (!seen.has(canonical)) {
      seen.add(canonical);
      cells.push(canonical);
    }
  }
  return { agents, contests, cells };
}

export interface BatchComposerState {
  stage: BatchStage;
  view: MatrixView;
  selectedAgents: string[];
  selectedContests: string[];
  selectedCells: string[];
  repeats: number;
  concurrency: number;
  selectionGen: number;
  plan: PlanResponse | null;
  planGen: number | null;
  preflight: PreflightReport | null;
  preflightGen: number | null;
}

export type BatchComposerEvent =
  | { type: 'SET_STAGE'; stage: BatchStage }
  | { type: 'SET_VIEW'; view: MatrixView }
  | { type: 'SET_REPEATS'; repeats: number }
  | { type: 'SET_CONCURRENCY'; concurrency: number }
  | { type: 'TOGGLE_AGENT'; path: string }
  | { type: 'TOGGLE_CONTEST'; path: string }
  | { type: 'SELECT_AGENTS'; paths: string[] }
  | { type: 'SELECT_CONTESTS'; paths: string[] }
  | { type: 'TOGGLE_CELL'; agent: string; contest: string }
  | { type: 'TOGGLE_CELL_GROUP'; keys: string[] }
  | { type: 'SET_CELLS'; keys: string[] }
  | { type: 'RECONCILE_AGENTS'; validPaths: Set<string> }
  | { type: 'RECONCILE_CONTESTS'; validPaths: Set<string> }
  | { type: 'FILTER_INCOMPATIBLE'; compatibleMap: Map<string, boolean> }
  | { type: 'ADD_PENDING'; kind: 'agent' | 'contest'; path: string; validOpposite?: Set<string> }
  | { type: 'PLAN_READY'; plan: PlanResponse; gen: number }
  | { type: 'SET_PREFLIGHT'; preflight: PreflightReport | null; gen: number };

export function createInitialBatchComposerState(draft: BatchDraft): BatchComposerState {
  const clean = sanitizeBatchDraft(draft);
  return {
    stage: 'catalog',
    view: 'matrix',
    selectedAgents: clean.agents,
    selectedContests: clean.contests,
    selectedCells: clean.cells,
    repeats: 1,
    concurrency: 1,
    selectionGen: 0,
    plan: null,
    planGen: null,
    preflight: null,
    preflightGen: null,
  };
}

function invalidateSelection(state: BatchComposerState): BatchComposerState {
  return {
    ...state,
    selectionGen: state.selectionGen + 1,
    plan: null,
    planGen: null,
    preflight: null,
    preflightGen: null,
    stage: state.stage === 'review' ? 'matrix' : state.stage,
  };
}

export function batchComposerReducer(
  state: BatchComposerState,
  event: BatchComposerEvent,
): BatchComposerState {
  switch (event.type) {
    case 'SET_STAGE':
      return { ...state, stage: event.stage };

    case 'SET_VIEW':
      return { ...state, view: event.view };

    case 'SET_REPEATS':
      if (event.repeats === state.repeats) return state;
      return {
        ...invalidateSelection(state),
        repeats: event.repeats,
      };

    case 'SET_CONCURRENCY':
      return { ...state, concurrency: event.concurrency };

    case 'TOGGLE_AGENT': {
      const base = invalidateSelection(state);
      const exists = base.selectedAgents.includes(event.path);
      if (exists) {
        return {
          ...base,
          selectedAgents: base.selectedAgents.filter(p => p !== event.path),
          selectedCells: base.selectedCells.filter(k => parseCell(k)[0] !== event.path),
        };
      }
      const nextCells = new Set(base.selectedCells);
      for (const contest of base.selectedContests) nextCells.add(cellKey(event.path, contest));
      return {
        ...base,
        selectedAgents: [...base.selectedAgents, event.path],
        selectedCells: [...nextCells],
      };
    }

    case 'TOGGLE_CONTEST': {
      const base = invalidateSelection(state);
      const exists = base.selectedContests.includes(event.path);
      if (exists) {
        return {
          ...base,
          selectedContests: base.selectedContests.filter(p => p !== event.path),
          selectedCells: base.selectedCells.filter(k => parseCell(k)[1] !== event.path),
        };
      }
      const nextCells = new Set(base.selectedCells);
      for (const agent of base.selectedAgents) nextCells.add(cellKey(agent, event.path));
      return {
        ...base,
        selectedContests: [...base.selectedContests, event.path],
        selectedCells: [...nextCells],
      };
    }

    case 'SELECT_AGENTS': {
      const toAdd = event.paths.filter(p => !state.selectedAgents.includes(p));
      if (!toAdd.length) return state;
      const base = invalidateSelection(state);
      const nextCells = new Set(base.selectedCells);
      for (const agent of toAdd) {
        for (const contest of base.selectedContests) nextCells.add(cellKey(agent, contest));
      }
      return {
        ...base,
        selectedAgents: [...base.selectedAgents, ...toAdd],
        selectedCells: [...nextCells],
      };
    }

    case 'SELECT_CONTESTS': {
      const toAdd = event.paths.filter(p => !state.selectedContests.includes(p));
      if (!toAdd.length) return state;
      const base = invalidateSelection(state);
      const nextCells = new Set(base.selectedCells);
      for (const contest of toAdd) {
        for (const agent of base.selectedAgents) nextCells.add(cellKey(agent, contest));
      }
      return {
        ...base,
        selectedContests: [...base.selectedContests, ...toAdd],
        selectedCells: [...nextCells],
      };
    }

    case 'TOGGLE_CELL': {
      const base = invalidateSelection(state);
      const key = cellKey(event.agent, event.contest);
      const exists = base.selectedCells.includes(key);
      return {
        ...base,
        selectedCells: exists ? base.selectedCells.filter(k => k !== key) : [...base.selectedCells, key],
      };
    }

    case 'TOGGLE_CELL_GROUP': {
      const base = invalidateSelection(state);
      const current = new Set(base.selectedCells);
      const allSelected = event.keys.length > 0 && event.keys.every(k => current.has(k));
      for (const k of event.keys) {
        if (allSelected) current.delete(k);
        else current.add(k);
      }
      return { ...base, selectedCells: [...current] };
    }

    case 'SET_CELLS': {
      const base = invalidateSelection(state);
      return { ...base, selectedCells: [...new Set(event.keys)] };
    }

    case 'RECONCILE_AGENTS': {
      const nextAgents = state.selectedAgents.filter(p => event.validPaths.has(p));
      const nextCells = state.selectedCells.filter(k => event.validPaths.has(parseCell(k)[0]));
      if (nextAgents.length === state.selectedAgents.length && nextCells.length === state.selectedCells.length) {
        return state;
      }
      return { ...invalidateSelection(state), selectedAgents: nextAgents, selectedCells: nextCells };
    }

    case 'RECONCILE_CONTESTS': {
      const nextContests = state.selectedContests.filter(p => event.validPaths.has(p));
      const nextCells = state.selectedCells.filter(k => event.validPaths.has(parseCell(k)[1]));
      if (nextContests.length === state.selectedContests.length && nextCells.length === state.selectedCells.length) {
        return state;
      }
      return { ...invalidateSelection(state), selectedContests: nextContests, selectedCells: nextCells };
    }

    case 'FILTER_INCOMPATIBLE': {
      const nextCells = state.selectedCells.filter(k => event.compatibleMap.get(k) !== false);
      if (nextCells.length === state.selectedCells.length) return state;
      return { ...invalidateSelection(state), selectedCells: nextCells };
    }

    case 'ADD_PENDING': {
      const base = invalidateSelection(state);
      const nextCells = new Set(base.selectedCells);
      if (event.kind === 'agent') {
        const nextAgents = base.selectedAgents.includes(event.path)
          ? base.selectedAgents
          : [...base.selectedAgents, event.path];
        for (const contest of base.selectedContests) {
          if (!event.validOpposite || event.validOpposite.has(contest)) {
            nextCells.add(cellKey(event.path, contest));
          }
        }
        return {
          ...base,
          stage: 'catalog',
          selectedAgents: nextAgents,
          selectedCells: [...nextCells],
        };
      }
      const nextContests = base.selectedContests.includes(event.path)
        ? base.selectedContests
        : [...base.selectedContests, event.path];
      for (const agent of base.selectedAgents) {
        if (!event.validOpposite || event.validOpposite.has(agent)) {
          nextCells.add(cellKey(agent, event.path));
        }
      }
      return {
        ...base,
        stage: 'catalog',
        selectedContests: nextContests,
        selectedCells: [...nextCells],
      };
    }

    case 'PLAN_READY':
      if (event.gen !== state.selectionGen) return state;
      return { ...state, plan: event.plan, planGen: event.gen, preflight: null, preflightGen: null, stage: 'review' };

    case 'SET_PREFLIGHT':
      if (event.gen !== state.selectionGen) return state;
      return { ...state, preflight: event.preflight, preflightGen: event.gen };
  }
}
