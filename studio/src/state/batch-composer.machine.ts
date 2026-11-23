import type { PlanResponse, PreflightReport } from '@studio-api';

export type BatchStage = 'catalog' | 'matrix' | 'review';
export type MatrixView = 'matrix' | 'list';

export const cellKey = (agent: string, contest: string) => JSON.stringify([agent, contest]);
export const parseCell = (key: string) => JSON.parse(key) as [string, string];

export interface BatchDraft {
  agents: string[];
  contests: string[];
  cells: string[];
}

export interface BatchComposerState {
  stage: BatchStage;
  view: MatrixView;
  selectedAgents: string[];
  selectedContests: string[];
  selectedCells: string[];
  repeats: number;
  concurrency: number;
  plan: PlanResponse | null;
  preflight: PreflightReport | null;
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
  | { type: 'PLAN_READY'; plan: PlanResponse }
  | { type: 'SET_PREFLIGHT'; preflight: PreflightReport | null };

export function createInitialBatchComposerState(draft: BatchDraft): BatchComposerState {
  return {
    stage: 'catalog',
    view: 'matrix',
    selectedAgents: [...new Set(draft.agents)],
    selectedContests: [...new Set(draft.contests)],
    selectedCells: [...new Set(draft.cells)],
    repeats: 1,
    concurrency: 1,
    plan: null,
    preflight: null,
  };
}

function invalidatePlan(state: BatchComposerState): BatchComposerState {
  return {
    ...state,
    plan: null,
    preflight: null,
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
      return { ...state, repeats: event.repeats, plan: null, preflight: null };

    case 'SET_CONCURRENCY':
      return { ...state, concurrency: event.concurrency };

    case 'TOGGLE_AGENT': {
      const base = invalidatePlan(state);
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
      const base = invalidatePlan(state);
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
      const base = invalidatePlan(state);
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
      const base = invalidatePlan(state);
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
      const base = invalidatePlan(state);
      const key = cellKey(event.agent, event.contest);
      const exists = base.selectedCells.includes(key);
      return {
        ...base,
        selectedCells: exists ? base.selectedCells.filter(k => k !== key) : [...base.selectedCells, key],
      };
    }

    case 'TOGGLE_CELL_GROUP': {
      const base = invalidatePlan(state);
      const current = new Set(base.selectedCells);
      const allSelected = event.keys.length > 0 && event.keys.every(k => current.has(k));
      for (const k of event.keys) {
        if (allSelected) current.delete(k);
        else current.add(k);
      }
      return { ...base, selectedCells: [...current] };
    }

    case 'SET_CELLS': {
      const base = invalidatePlan(state);
      return { ...base, selectedCells: [...new Set(event.keys)] };
    }

    case 'RECONCILE_AGENTS': {
      const nextAgents = state.selectedAgents.filter(p => event.validPaths.has(p));
      const nextCells = state.selectedCells.filter(k => event.validPaths.has(parseCell(k)[0]));
      if (nextAgents.length === state.selectedAgents.length && nextCells.length === state.selectedCells.length) {
        return state;
      }
      return { ...invalidatePlan(state), selectedAgents: nextAgents, selectedCells: nextCells };
    }

    case 'RECONCILE_CONTESTS': {
      const nextContests = state.selectedContests.filter(p => event.validPaths.has(p));
      const nextCells = state.selectedCells.filter(k => event.validPaths.has(parseCell(k)[1]));
      if (nextContests.length === state.selectedContests.length && nextCells.length === state.selectedCells.length) {
        return state;
      }
      return { ...invalidatePlan(state), selectedContests: nextContests, selectedCells: nextCells };
    }

    case 'FILTER_INCOMPATIBLE': {
      const nextCells = state.selectedCells.filter(k => event.compatibleMap.get(k) !== false);
      if (nextCells.length === state.selectedCells.length) return state;
      return { ...state, selectedCells: nextCells };
    }

    case 'ADD_PENDING': {
      const nextCells = new Set(state.selectedCells);
      if (event.kind === 'agent') {
        const nextAgents = state.selectedAgents.includes(event.path)
          ? state.selectedAgents
          : [...state.selectedAgents, event.path];
        for (const contest of state.selectedContests) {
          if (!event.validOpposite || event.validOpposite.has(contest)) {
            nextCells.add(cellKey(event.path, contest));
          }
        }
        return {
          ...state,
          stage: 'catalog',
          plan: null,
          preflight: null,
          selectedAgents: nextAgents,
          selectedCells: [...nextCells],
        };
      }
      const nextContests = state.selectedContests.includes(event.path)
        ? state.selectedContests
        : [...state.selectedContests, event.path];
      for (const agent of state.selectedAgents) {
        if (!event.validOpposite || event.validOpposite.has(agent)) {
          nextCells.add(cellKey(agent, event.path));
        }
      }
      return {
        ...state,
        stage: 'catalog',
        plan: null,
        preflight: null,
        selectedContests: nextContests,
        selectedCells: [...nextCells],
      };
    }

    case 'PLAN_READY':
      return { ...state, plan: event.plan, preflight: null, stage: 'review' };

    case 'SET_PREFLIGHT':
      return { ...state, preflight: event.preflight };
  }
}
