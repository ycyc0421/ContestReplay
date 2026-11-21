export type ProblemMapStrategy =
  | 'exact'
  | 'normalized'
  | 'numeric_to_alpha'
  | 'alpha_to_numeric'
  | 'positional';

export type ProblemMapConfidence = 'exact' | 'high' | 'medium' | 'low';

export interface ProblemMapMatch {
  local_id: string;
  remote_id: string;
  strategy: ProblemMapStrategy;
  confidence: ProblemMapConfidence;
}

export interface ProblemMapInference {
  problem_map: Record<string, string>;
  matches: ProblemMapMatch[];
  unmapped_local: string[];
  unmapped_remote: string[];
}

export interface RemoteProblemDescriptor {
  remote_id: string;
  title?: string;
}

function normalizeLabel(raw: string): string {
  let value = raw.trim();
  // Strip leading prose prefixes like "Problem A", "Prob. 1", "Task B", "P1", "#3"
  value = value.replace(/^(?:problem|prob|task|question|q)\b[\s.#:-]*/i, '');
  value = value.replace(/^p(?=\d+$)/i, '');
  value = value.replace(/^[#]+/, '');
  // Strip trailing punctuation like "A." or "1:"
  value = value.replace(/[\s.:)-]+$/, '');
  return value.trim().toUpperCase();
}

function parsePositiveInt(normalized: string): number | undefined {
  if (!/^\d+$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

function parseSingleAlpha(normalized: string): number | undefined {
  if (!/^[A-Z]$/.test(normalized)) return undefined;
  return normalized.charCodeAt(0) - 64; // A -> 1 .. Z -> 26
}

function alphaFromIndex(index1Based: number): string | undefined {
  if (index1Based < 1 || index1Based > 26) return undefined;
  return String.fromCharCode(64 + index1Based);
}

/**
 * Infer a mapping from local problem identifiers (e.g. PDF headers or user list)
 * to remote OJ problem identifiers.
 */
export function inferProblemMap(
  localProblems: string[],
  remoteProblems: RemoteProblemDescriptor[],
): ProblemMapInference {
  const problem_map: Record<string, string> = {};
  const matches: ProblemMapMatch[] = [];
  const usedLocal = new Set<string>();
  const usedRemote = new Set<string>();

  const remoteByExact = new Map<string, RemoteProblemDescriptor[]>();
  const remoteByNorm = new Map<string, RemoteProblemDescriptor[]>();
  for (const remote of remoteProblems) {
    const exactList = remoteByExact.get(remote.remote_id) ?? [];
    exactList.push(remote);
    remoteByExact.set(remote.remote_id, exactList);

    const norm = normalizeLabel(remote.remote_id);
    if (norm) {
      const normList = remoteByNorm.get(norm) ?? [];
      normList.push(remote);
      remoteByNorm.set(norm, normList);
    }
  }

  // Pass 1a: Exact string match
  for (const local of localProblems) {
    if (usedLocal.has(local)) continue;
    const candidates = (remoteByExact.get(local) ?? []).filter(r => !usedRemote.has(r.remote_id));
    if (candidates.length === 1) {
      const target = candidates[0]!;
      problem_map[local] = target.remote_id;
      usedLocal.add(local);
      usedRemote.add(target.remote_id);
      matches.push({ local_id: local, remote_id: target.remote_id, strategy: 'exact', confidence: 'exact' });
    }
  }

  // Pass 1b: Exact normalized match (case-insensitive, stripping prefixes/punctuation)
  for (const local of localProblems) {
    if (usedLocal.has(local)) continue;
    const norm = normalizeLabel(local);
    if (!norm) continue;
    const candidates = (remoteByNorm.get(norm) ?? []).filter(r => !usedRemote.has(r.remote_id));
    if (candidates.length === 1) {
      const target = candidates[0]!;
      problem_map[local] = target.remote_id;
      usedLocal.add(local);
      usedRemote.add(target.remote_id);
      matches.push({ local_id: local, remote_id: target.remote_id, strategy: 'normalized', confidence: 'high' });
    }
  }

  // Pass 2: Numeric-to-alpha bijection (1 -> A, 2 -> B, ..., 26 -> Z)
  const remainingLocals2 = localProblems.filter(l => !usedLocal.has(l));
  const remainingRemotes2 = remoteProblems.filter(r => !usedRemote.has(r.remote_id));
  if (remainingLocals2.length > 0 && remainingRemotes2.length > 0) {
    const remoteAlphaMap = new Map<string, RemoteProblemDescriptor>();
    for (const r of remainingRemotes2) {
      const norm = normalizeLabel(r.remote_id);
      if (/^[A-Z]$/.test(norm) && !remoteAlphaMap.has(norm)) {
        remoteAlphaMap.set(norm, r);
      }
    }
    const allLocalsNumeric = remainingLocals2.every(l => parsePositiveInt(normalizeLabel(l)) !== undefined);
    const sameLength = remainingLocals2.length === remainingRemotes2.length;
    if (allLocalsNumeric && remoteAlphaMap.size > 0) {
      for (const local of remainingLocals2) {
        const num = parsePositiveInt(normalizeLabel(local));
        if (num === undefined) continue;
        const letter = alphaFromIndex(num);
        if (!letter) continue;
        const target = remoteAlphaMap.get(letter);
        if (target && !usedRemote.has(target.remote_id)) {
          problem_map[local] = target.remote_id;
          usedLocal.add(local);
          usedRemote.add(target.remote_id);
          matches.push({
            local_id: local,
            remote_id: target.remote_id,
            strategy: 'numeric_to_alpha',
            confidence: sameLength ? 'high' : 'medium',
          });
        }
      }
    }
  }

  // Pass 3: Alpha-to-numeric bijection (A -> 1, B -> 2, ..., Z -> 26)
  const remainingLocals3 = localProblems.filter(l => !usedLocal.has(l));
  const remainingRemotes3 = remoteProblems.filter(r => !usedRemote.has(r.remote_id));
  if (remainingLocals3.length > 0 && remainingRemotes3.length > 0) {
    const remoteNumMap = new Map<number, RemoteProblemDescriptor>();
    for (const r of remainingRemotes3) {
      const num = parsePositiveInt(normalizeLabel(r.remote_id));
      if (num !== undefined && !remoteNumMap.has(num)) {
        remoteNumMap.set(num, r);
      }
    }
    const allLocalsAlpha = remainingLocals3.every(l => parseSingleAlpha(normalizeLabel(l)) !== undefined);
    const sameLength = remainingLocals3.length === remainingRemotes3.length;
    if (allLocalsAlpha && remoteNumMap.size > 0) {
      for (const local of remainingLocals3) {
        const idx = parseSingleAlpha(normalizeLabel(local));
        if (idx === undefined) continue;
        const target = remoteNumMap.get(idx);
        if (target && !usedRemote.has(target.remote_id)) {
          problem_map[local] = target.remote_id;
          usedLocal.add(local);
          usedRemote.add(target.remote_id);
          matches.push({
            local_id: local,
            remote_id: target.remote_id,
            strategy: 'alpha_to_numeric',
            confidence: sameLength ? 'high' : 'medium',
          });
        }
      }
    }
  }

  // Pass 4: Ordered positional fallback when remaining counts are identical
  const remainingLocals4 = localProblems.filter(l => !usedLocal.has(l));
  const remainingRemotes4 = remoteProblems.filter(r => !usedRemote.has(r.remote_id));
  if (remainingLocals4.length > 0 && remainingLocals4.length === remainingRemotes4.length) {
    for (let i = 0; i < remainingLocals4.length; i++) {
      const local = remainingLocals4[i]!;
      const target = remainingRemotes4[i]!;
      problem_map[local] = target.remote_id;
      usedLocal.add(local);
      usedRemote.add(target.remote_id);
      matches.push({
        local_id: local,
        remote_id: target.remote_id,
        strategy: 'positional',
        confidence: 'low',
      });
    }
  }

  // Preserve original local problem ordering in matches output
  const order = new Map(localProblems.map((id, idx) => [id, idx]));
  matches.sort((a, b) => (order.get(a.local_id) ?? 0) - (order.get(b.local_id) ?? 0));

  return {
    problem_map,
    matches,
    unmapped_local: localProblems.filter(l => !usedLocal.has(l)),
    unmapped_remote: remoteProblems.map(r => r.remote_id).filter(r => !usedRemote.has(r)),
  };
}

/**
 * Extract candidate problem labels from extracted PDF / statement text.
 * Recognizes headings like:
 *   - "Problem A", "Problem A1", "Problem 1"
 *   - "Task 1", "Task B"
 *   - "A. Two Sum", "B1. Subarray"
 *   - "P1. Title", "P2: Title"
 */
export function extractProblemLabelsFromText(text: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];

  const add = (raw: string) => {
    const clean = raw.trim().toUpperCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    labels.push(clean);
  };

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length > 160) continue;

    // 1. "Problem A", "Problem A1", "Problem 1:", "Task 2 - Foo", "Prob B."
    const keywordMatch = line.match(
      /^(?:Problem|Prob\.?|Task)\s+([A-Z]\d{0,2}|\d{1,3})(?:$|[\s.:—–-]+)/i,
    );
    if (keywordMatch?.[1]) {
      add(keywordMatch[1]);
      continue;
    }

    // 2. "P1. Foo", "P12: Bar"
    const pMatch = line.match(/^P(\d{1,3})(?:[\s.:—–-]+.+)$/);
    if (pMatch?.[1]) {
      add(`P${pMatch[1]}`);
      continue;
    }

    // 3. "A. Two Sum", "A1. Something", "B) Something" (require title text starting with letter/CJK)
    const letterHeading = line.match(/^([A-Z]\d?)[.)]\s+([A-Za-z\u4e00-\u9fff].{1,120})$/);
    if (letterHeading?.[1]) {
      add(letterHeading[1]);
      continue;
    }
  }

  return labels;
}
