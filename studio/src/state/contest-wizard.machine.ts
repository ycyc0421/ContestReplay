import type { ContestPreviewResponse } from '@studio-api';
import {
  codeforcesWeightSignature,
  computeCodeforcesPointsKnown,
  validMaxPoints,
  type CodeforcesSourceState,
  type ProblemRow,
} from '@/features/configs/cf-points';

export type ProblemDraft = { id: string; maxPoints: number; answers: string };
export type MaterialArtifact = { path: string; name: string; size: number; sha256: string; kind: 'entrypoint' | 'attachment' };

export interface ContestWizardState {
  step: number;
  maxStep: number;
  materialMode: 'upload' | 'path';
  uploaded?: MaterialArtifact;
  problems: ProblemDraft[];
  remotePreview?: ContestPreviewResponse;
  confirmedWeightsSig?: string;
  cfNoticeSticky: boolean;
}

export type ContestWizardEvent =
  | { type: 'GO_TO_STEP'; step: number }
  | { type: 'SET_MATERIAL_MODE'; mode: 'upload' | 'path' }
  | { type: 'SET_UPLOADED'; material: MaterialArtifact }
  | { type: 'SET_PROBLEMS'; problems: ProblemDraft[]; nextCfWeightSig?: string }
  | { type: 'SYNC_CF_SIGNATURE'; currentCfWeightSig?: string }
  | { type: 'JUDGE_CHANGED'; judge: string; sourceJudge?: CodeforcesSourceState }
  | {
      type: 'APPLY_REMOTE_PREVIEW';
      judge: string;
      cfId: string;
      gym: boolean;
      existingProblemMap: Record<string, unknown>;
      result: ContestPreviewResponse;
      isEdit: boolean;
      initialProblemDrafts: ProblemDraft[];
      sourceJudge?: CodeforcesSourceState;
      sourceProblems?: ProblemRow[];
    }
  | { type: 'SET_CF_CONFIRMATION'; confirmed: boolean; currentSig?: string };

export function mergePreviewProblemMap(
  existingProblemMap: Record<string, unknown>,
  suggestedMap: Record<string, string> | undefined,
): Record<string, string> {
  const explicitEntries = Object.fromEntries(
    Object.entries(existingProblemMap).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  ) as Record<string, string>;
  const suggestions = suggestedMap ?? {};
  // Fill missing keys from suggestions while preserving deliberate explicit mappings.
  return Object.keys(suggestions).length ? { ...suggestions, ...explicitEntries } : explicitEntries;
}

export function contestWizardReducer(
  state: ContestWizardState,
  event: ContestWizardEvent,
): ContestWizardState {
  switch (event.type) {
    case 'GO_TO_STEP':
      return { ...state, step: event.step, maxStep: Math.max(state.maxStep, event.step) };

    case 'SET_MATERIAL_MODE':
      return { ...state, materialMode: event.mode };

    case 'SET_UPLOADED':
      return { ...state, uploaded: event.material };

    case 'SET_PROBLEMS': {
      const confirmationBroken = Boolean(
        state.confirmedWeightsSig &&
        event.nextCfWeightSig &&
        state.confirmedWeightsSig !== event.nextCfWeightSig,
      );
      return {
        ...state,
        problems: event.problems,
        ...(confirmationBroken ? { confirmedWeightsSig: undefined, cfNoticeSticky: true } : {}),
      };
    }

    case 'SYNC_CF_SIGNATURE': {
      if (state.confirmedWeightsSig && event.currentCfWeightSig !== state.confirmedWeightsSig) {
        return { ...state, confirmedWeightsSig: undefined, cfNoticeSticky: true };
      }
      return state;
    }

    case 'JUDGE_CHANGED':
      return {
        ...state,
        remotePreview: undefined,
        confirmedWeightsSig: undefined,
        cfNoticeSticky: event.judge === 'codeforces' && event.sourceJudge?.kind === 'codeforces' && event.sourceJudge.points_known === false,
      };

    case 'APPLY_REMOTE_PREVIEW': {
      const mergedMap = mergePreviewProblemMap(event.existingProblemMap, event.result.problem_map_suggestion?.problem_map);
      const isUntouchedDefault =
        !event.isEdit &&
        state.problems.length === 1 &&
        state.problems[0]!.id === '1' &&
        state.problems[0]!.maxPoints === 1 &&
        !state.problems[0]!.answers.trim();

      const orderedIds: string[] = [];
      const addId = (candidate: string) => {
        const trimmed = candidate.trim();
        if (trimmed && !orderedIds.includes(trimmed)) orderedIds.push(trimmed);
      };
      if (!isUntouchedDefault) state.problems.forEach(p => addId(p.id));
      (event.result.pdf_info?.problem_ids ?? []).forEach(addId);
      Object.keys(event.result.problem_map_suggestion?.problem_map ?? {}).forEach(addId);
      (event.result.problem_map_suggestion?.unmapped_local ?? []).forEach(addId);
      if (!orderedIds.length) event.result.preview.problems.forEach(p => addId(p.remote_id));

      const prevPointsKnown = event.judge === 'codeforces'
        ? computeCodeforcesPointsKnown({
            cfId: event.cfId,
            gym: event.gym,
            problems: state.problems.map(p => ({ id: p.id.trim(), max_points: p.maxPoints })),
            problemMap: event.existingProblemMap,
            preview: state.remotePreview,
            confirmedSignature: state.confirmedWeightsSig,
            isEdit: event.isEdit,
            sourceJudge: event.sourceJudge,
            sourceProblems: event.sourceProblems,
          })
        : undefined;
      const replacePlaceholders = isUntouchedDefault || prevPointsKnown === false;

      const nextProblems: ProblemDraft[] = orderedIds.length
        ? orderedIds.map(localId => {
            const existing = isUntouchedDefault ? undefined : state.problems.find(p => p.id.trim() === localId);
            const mappedRemoteId = mergedMap[localId] ?? localId;
            const remoteProblem = event.result.preview.problems.find(p => p.remote_id === mappedRemoteId);
            const remotePoints = validMaxPoints(remoteProblem?.max_points);
            const resolvedMaxPoints = existing
              ? (replacePlaceholders && remotePoints !== undefined ? remotePoints : existing.maxPoints)
              : remotePoints ?? event.initialProblemDrafts.find(p => p.id === localId)?.maxPoints ?? 1;
            return {
              id: localId,
              maxPoints: resolvedMaxPoints,
              answers: existing?.answers ?? event.initialProblemDrafts.find(p => p.id === localId)?.answers ?? '',
            };
          })
        : state.problems;

      const nextVerified = event.judge === 'codeforces'
        ? computeCodeforcesPointsKnown({
            cfId: event.cfId,
            gym: event.gym,
            problems: nextProblems.map(p => ({ id: p.id.trim(), max_points: p.maxPoints })),
            problemMap: mergedMap,
            preview: event.result,
            confirmedSignature: undefined,
            isEdit: event.isEdit,
            sourceJudge: event.sourceJudge,
            sourceProblems: event.sourceProblems,
          })
        : undefined;

      return {
        ...state,
        problems: nextProblems,
        remotePreview: event.result,
        confirmedWeightsSig: undefined,
        cfNoticeSticky: event.judge === 'codeforces' && nextVerified === false,
      };
    }

    case 'SET_CF_CONFIRMATION':
      return event.confirmed
        ? { ...state, confirmedWeightsSig: event.currentSig, cfNoticeSticky: true }
        : { ...state, confirmedWeightsSig: undefined };
  }
}

export function buildCfWeightSigFromDrafts(
  cfId: string,
  gym: boolean,
  drafts: ProblemDraft[],
  problemMap: Record<string, unknown>,
) {
  return codeforcesWeightSignature(
    cfId,
    gym,
    drafts.map(p => ({ id: p.id.trim(), max_points: p.maxPoints })),
    problemMap,
  );
}
