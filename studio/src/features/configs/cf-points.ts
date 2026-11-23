import type { ContestPreviewResponse } from '@studio-api';

export type ProblemRow = { id: string; max_points: number };
export type CodeforcesSourceState = {
  kind?: string;
  contest_id?: number | string;
  gym?: boolean;
  base_url?: string;
  points_known?: boolean;
  problem_map?: Record<string, string>;
};

export function validMaxPoints(points?: number): number | undefined {
  return typeof points === 'number' && Number.isFinite(points) && points >= 1 ? Math.round(points) : undefined;
}

export function normalizeCfBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return 'https://codeforces.com';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function canonicalCfRef(cfId: string, gym: boolean): string {
  const trimmed = cfId.trim();
  const numeric = Number(trimmed);
  const idPart = trimmed && Number.isSafeInteger(numeric) && numeric >= 1 ? String(numeric) : trimmed;
  return gym ? `gym:${idPart}` : idPart;
}

export function codeforcesWeightSignature(
  cfId: string,
  gym: boolean,
  problems: ProblemRow[],
  problemMap: Record<string, unknown>,
  baseUrl?: string,
): string {
  return JSON.stringify({
    baseUrl: normalizeCfBaseUrl(baseUrl),
    cfRef: canonicalCfRef(cfId, gym),
    problems: problems.map(problem => ({ id: problem.id.trim(), max_points: problem.max_points })),
    problemMap,
  });
}

export function computeCodeforcesPointsKnown(input: {
  cfId: string;
  gym: boolean;
  baseUrl?: string;
  problems: ProblemRow[];
  problemMap: Record<string, unknown>;
  preview?: ContestPreviewResponse;
  previewBaseUrl?: string;
  confirmedSignature?: string;
  isEdit: boolean;
  sourceJudge?: CodeforcesSourceState;
  sourceProblems?: ProblemRow[];
}): boolean | undefined {
  const cfRef = canonicalCfRef(input.cfId, input.gym);
  const normalizedBase = normalizeCfBaseUrl(input.baseUrl);
  const rows = input.problems.map(problem => ({ id: problem.id.trim(), max_points: problem.max_points }));
  const sig = JSON.stringify({ baseUrl: normalizedBase, cfRef, problems: rows, problemMap: input.problemMap });

  if (input.confirmedSignature && input.confirmedSignature === sig) {
    return true;
  }

  const previewBase = normalizeCfBaseUrl(input.previewBaseUrl);
  if (
    input.preview &&
    input.preview.preview.platform === 'codeforces' &&
    input.preview.preview.contest_ref === cfRef &&
    previewBase === normalizedBase
  ) {
    return rows.length > 0 && rows.every(problem => {
      const mappedVal = input.problemMap[problem.id];
      const mapped = typeof mappedVal === 'string' && mappedVal.trim() ? mappedVal.trim() : problem.id;
      const remote = input.preview!.preview.problems.find(item => item.remote_id === mapped);
      const remotePoints = validMaxPoints(remote?.max_points);
      return remotePoints !== undefined && problem.max_points === remotePoints;
    });
  }

  const sourceRef = input.sourceJudge?.kind === 'codeforces'
    ? canonicalCfRef(String(input.sourceJudge.contest_id ?? ''), Boolean(input.sourceJudge.gym))
    : undefined;
  const sourceBase = normalizeCfBaseUrl(input.sourceJudge?.base_url);
  const sourceMap = input.sourceJudge?.problem_map ?? {};
  const sourceRows = input.sourceProblems ?? [];
  const unchangedFromSource = Boolean(
    input.isEdit &&
    input.sourceJudge?.kind === 'codeforces' &&
    sourceRef === cfRef &&
    sourceBase === normalizedBase &&
    JSON.stringify(rows) === JSON.stringify(sourceRows) &&
    JSON.stringify(input.problemMap) === JSON.stringify(sourceMap),
  );
  if (unchangedFromSource) {
    return input.sourceJudge?.points_known;
  }

  // Any changed or newly authored Codeforces weights without a matching verified preview or explicit confirmation must be false.
  return false;
}
