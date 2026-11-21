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
  /** Matches confirmed at exact/high/medium confidence (excludes low-confidence positional guesses). */
  confirmed_map: Record<string, string>;
  /** Low-confidence positional suggestions that require user confirmation. */
  suggested_map: Record<string, string>;
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
  // Strip trailing punctuation first (e.g. "P1." -> "P1", "A:" -> "A", "Q." -> "Q")
  value = value.replace(/[\s.:)-]+$/, '');
  // Strip leading prose prefixes ONLY when followed by a separator and a non-empty identifier
  // so bare single-letter labels like "Q" or "P" are never swallowed.
  value = value.replace(/^(?:problem|prob|task|question)\b[\s.#:-]+(?=\S)/i, '');
  value = value.replace(/^q[\s.#:-]+(?=\d+\b)/i, '');
  value = value.replace(/^p(?=\d+$)/i, '');
  value = value.replace(/^[#]+(?=\S)/, '');
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
 * Check whether a set of positive integers forms a reasonable 1-based ordinal sequence
 * (every number is within 1..26 and starts at 1, or every number maps cleanly to an available letter).
 * Prevents mis-pairing arbitrary numeric OJ IDs like [3, 100, 101] with [A, B, C].
 */
function isPlausibleOrdinalNumbers(nums: number[]): boolean {
  if (!nums.length) return false;
  if (nums.some(n => n < 1 || n > 26)) return false;
  const unique = new Set(nums);
  if (unique.size !== nums.length) return false;
  // Require every number in the set to be within a contiguous/small ordinal range starting near 1
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === 1 && max <= Math.max(nums.length + 2, 26) && max <= 26;
}

/**
 * Infer a strict 1-to-1 bijection from local problem identifiers (e.g. PDF headers or user list)
 * to remote OJ problem identifiers.
 */
export function inferProblemMap(
  localProblems: string[],
  remoteProblems: RemoteProblemDescriptor[],
): ProblemMapInference {
  // Deduplicate inputs while preserving order, tracking duplicates as ambiguous if needed
  const uniqueLocals: string[] = [];
  const seenLocalInput = new Set<string>();
  for (const l of localProblems) {
    if (!seenLocalInput.has(l)) {
      seenLocalInput.add(l);
      uniqueLocals.push(l);
    }
  }

  const uniqueRemotes: RemoteProblemDescriptor[] = [];
  const seenRemoteInput = new Set<string>();
  for (const r of remoteProblems) {
    if (!seenRemoteInput.has(r.remote_id)) {
      seenRemoteInput.add(r.remote_id);
      uniqueRemotes.push(r);
    }
  }

  const problem_map: Record<string, string> = {};
  const confirmed_map: Record<string, string> = {};
  const suggested_map: Record<string, string> = {};
  const matches: ProblemMapMatch[] = [];
  const usedLocal = new Set<string>();
  const usedRemote = new Set<string>();

  const recordMatch = (
    local: string,
    remoteId: string,
    strategy: ProblemMapStrategy,
    confidence: ProblemMapConfidence,
  ) => {
    problem_map[local] = remoteId;
    if (confidence === 'low') {
      suggested_map[local] = remoteId;
    } else {
      confirmed_map[local] = remoteId;
    }
    usedLocal.add(local);
    usedRemote.add(remoteId);
    matches.push({ local_id: local, remote_id: remoteId, strategy, confidence });
  };

  // Pass 1a: Exact string match (strictly unique on both sides)
  const remoteExactSet = new Set(uniqueRemotes.map(r => r.remote_id));
  for (const local of uniqueLocals) {
    if (usedLocal.has(local)) continue;
    if (remoteExactSet.has(local) && !usedRemote.has(local)) {
      recordMatch(local, local, 'exact', 'exact');
    }
  }

  // Pass 1b: Exact normalized match (strict 1-to-1: skip any normalized key with collisions on EITHER side)
  const remainingLocals1b = uniqueLocals.filter(l => !usedLocal.has(l));
  const remainingRemotes1b = uniqueRemotes.filter(r => !usedRemote.has(r.remote_id));
  const localByNorm = new Map<string, string[]>();
  for (const l of remainingLocals1b) {
    const norm = normalizeLabel(l);
    if (!norm) continue;
    const list = localByNorm.get(norm) ?? [];
    list.push(l);
    localByNorm.set(norm, list);
  }
  const remoteByNorm = new Map<string, RemoteProblemDescriptor[]>();
  for (const r of remainingRemotes1b) {
    const norm = normalizeLabel(r.remote_id);
    if (!norm) continue;
    const list = remoteByNorm.get(norm) ?? [];
    list.push(r);
    remoteByNorm.set(norm, list);
  }
  for (const [norm, locals] of localByNorm) {
    const remotes = remoteByNorm.get(norm);
    if (locals.length === 1 && remotes?.length === 1) {
      const local = locals[0]!;
      const target = remotes[0]!;
      if (!usedLocal.has(local) && !usedRemote.has(target.remote_id)) {
        recordMatch(local, target.remote_id, 'normalized', 'high');
      }
    }
  }

  // Pass 2: Numeric-to-alpha bijection (1 -> A, 2 -> B, ..., 26 -> Z)
  const remainingLocals2 = uniqueLocals.filter(l => !usedLocal.has(l));
  const remainingRemotes2 = uniqueRemotes.filter(r => !usedRemote.has(r.remote_id));
  if (remainingLocals2.length > 0 && remainingRemotes2.length > 0) {
    const parsedLocalNums = remainingLocals2.map(l => parsePositiveInt(normalizeLabel(l)));
    const allLocalsNumeric = parsedLocalNums.every((n): n is number => n !== undefined);
    const remoteAlphaList = remainingRemotes2.map(r => normalizeLabel(r.remote_id));
    const allRemotesAlpha = remoteAlphaList.every(n => /^[A-Z]$/.test(n));

    // Check for duplicate normalized local keys (e.g. "P1" and "Task 1") regardless of input order
    const localNumCounts = new Map<number, number>();
    if (allLocalsNumeric) {
      for (const n of parsedLocalNums) localNumCounts.set(n, (localNumCounts.get(n) ?? 0) + 1);
    }

    if (allLocalsNumeric && allRemotesAlpha && isPlausibleOrdinalNumbers(parsedLocalNums)) {
      const remoteAlphaMap = new Map<string, RemoteProblemDescriptor[]>();
      for (const r of remainingRemotes2) {
        const norm = normalizeLabel(r.remote_id);
        const list = remoteAlphaMap.get(norm) ?? [];
        list.push(r);
        remoteAlphaMap.set(norm, list);
      }
      const sameLength = remainingLocals2.length === remainingRemotes2.length;
      const planned: Array<{ local: string; remote: RemoteProblemDescriptor }> = [];
      let allMatched = true;
      for (let i = 0; i < remainingLocals2.length; i++) {
        const num = parsedLocalNums[i]!;
        if ((localNumCounts.get(num) ?? 0) > 1) {
          allMatched = false;
          continue;
        }
        const letter = alphaFromIndex(num);
        const candidates = letter ? remoteAlphaMap.get(letter) : undefined;
        if (candidates?.length === 1) {
          planned.push({ local: remainingLocals2[i]!, remote: candidates[0]! });
        } else {
          allMatched = false;
        }
      }
      if (planned.length > 0 && (allMatched || !sameLength)) {
        for (const pair of planned) {
          if (!usedLocal.has(pair.local) && !usedRemote.has(pair.remote.remote_id)) {
            recordMatch(pair.local, pair.remote.remote_id, 'numeric_to_alpha', sameLength && allMatched ? 'high' : 'medium');
          }
        }
      }
    }
  }

  // Pass 3: Alpha-to-numeric bijection (A -> 1, B -> 2, ..., Z -> 26)
  const remainingLocals3 = uniqueLocals.filter(l => !usedLocal.has(l));
  const remainingRemotes3 = uniqueRemotes.filter(r => !usedRemote.has(r.remote_id));
  if (remainingLocals3.length > 0 && remainingRemotes3.length > 0) {
    const parsedLocalAlphas = remainingLocals3.map(l => parseSingleAlpha(normalizeLabel(l)));
    const allLocalsAlpha = parsedLocalAlphas.every((n): n is number => n !== undefined);
    const parsedRemoteNums = remainingRemotes3.map(r => parsePositiveInt(normalizeLabel(r.remote_id)));
    const allRemotesNumeric = parsedRemoteNums.every((n): n is number => n !== undefined);

    // Detect duplicate normalized local letters (e.g. "Problem A" & "Task A") so neither enters confirmed_map
    const localAlphaCounts = new Map<number, number>();
    if (allLocalsAlpha) {
      for (const idx of parsedLocalAlphas) localAlphaCounts.set(idx, (localAlphaCounts.get(idx) ?? 0) + 1);
    }

    // Prevent mis-pairing ['A','B','C'] against arbitrary numeric IDs like ['3','100','101']!
    if (allLocalsAlpha && allRemotesNumeric && isPlausibleOrdinalNumbers(parsedRemoteNums)) {
      const remoteNumMap = new Map<number, RemoteProblemDescriptor[]>();
      for (let i = 0; i < remainingRemotes3.length; i++) {
        const num = parsedRemoteNums[i]!;
        const list = remoteNumMap.get(num) ?? [];
        list.push(remainingRemotes3[i]!);
        remoteNumMap.set(num, list);
      }
      const sameLength = remainingLocals3.length === remainingRemotes3.length;
      const planned: Array<{ local: string; remote: RemoteProblemDescriptor }> = [];
      let allMatched = true;
      for (let i = 0; i < remainingLocals3.length; i++) {
        const idx = parsedLocalAlphas[i]!;
        if ((localAlphaCounts.get(idx) ?? 0) > 1) {
          allMatched = false;
          continue;
        }
        const candidates = remoteNumMap.get(idx);
        if (candidates?.length === 1) {
          planned.push({ local: remainingLocals3[i]!, remote: candidates[0]! });
        } else {
          allMatched = false;
        }
      }
      if (planned.length > 0 && (allMatched || !sameLength)) {
        for (const pair of planned) {
          if (!usedLocal.has(pair.local) && !usedRemote.has(pair.remote.remote_id)) {
            recordMatch(pair.local, pair.remote.remote_id, 'alpha_to_numeric', sameLength && allMatched ? 'high' : 'medium');
          }
        }
      }
    }
  }

  // Pass 4: Ordered positional fallback when remaining counts are identical (low confidence)
  const remainingLocals4 = uniqueLocals.filter(l => !usedLocal.has(l));
  const remainingRemotes4 = uniqueRemotes.filter(r => !usedRemote.has(r.remote_id));
  if (remainingLocals4.length > 0 && remainingLocals4.length === remainingRemotes4.length) {
    for (let i = 0; i < remainingLocals4.length; i++) {
      const local = remainingLocals4[i]!;
      const target = remainingRemotes4[i]!;
      recordMatch(local, target.remote_id, 'positional', 'low');
    }
  }

  const order = new Map(uniqueLocals.map((id, idx) => [id, idx]));
  matches.sort((a, b) => (order.get(a.local_id) ?? 0) - (order.get(b.local_id) ?? 0));

  return {
    problem_map,
    confirmed_map,
    suggested_map,
    matches,
    unmapped_local: uniqueLocals.filter(l => !usedLocal.has(l)),
    unmapped_remote: uniqueRemotes.map(r => r.remote_id).filter(r => !usedRemote.has(r)),
  };
}

const STOP_HEADING_TITLES = new Set([
  'notes',
  'note',
  'input',
  'output',
  'example',
  'examples',
  'sample',
  'samples',
  'explanation',
  'constraints',
  'scoring',
  'subtasks',
  'interaction',
  'introduction',
  'appendix',
]);

/**
 * Extract candidate problem labels from extracted PDF / statement text.
 * Recognizes standalone problem headings while filtering out inline prose
 * (e.g. "problem a can be solved...") and generic section headings (e.g. "I. Notes").
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
    if (!line || line.length > 120) continue;

    // 1. Standalone heading: "Problem A", "Problem A. Two Sum", "Problem B1: Matrix", "Task C - Graph Walk"
    // Require capitalized keyword ("Problem"/"Prob."/"Task") and either end-of-line or explicit delimiter (., :, -, —, –)
    // so prose like "problem a can be solved..." or "Problem a is easy" is ignored.
    const keywordMatch = line.match(
      /^(?:Problem|Prob\.|Task)\s+([A-Z]\d{0,2}|\d{1,3})(?:$|[\s]*[.:—–-][\s]*(.+))$/,
    );
    if (keywordMatch?.[1]) {
      add(keywordMatch[1]);
      continue;
    }

    // 2. "P1. Foo", "P12: Bar" (uppercase P + digits + explicit delimiter)
    const pMatch = line.match(/^P(\d{1,3})[.:—–-]\s+([A-Z\u4e00-\u9fff].{1,100})$/);
    if (pMatch?.[1]) {
      add(`P${pMatch[1]}`);
      continue;
    }

    // 3. "A. Two Sum", "B1. Subarray", "D. Final Boss"
    // Require title starting with uppercase letter or CJK, not ending in sentence-like prose (>8 words),
    // and not a generic section title like "I. Notes" or "A. Constraints".
    const letterHeading = line.match(/^([A-Z]\d?)[.)]\s+([A-Z\u4e00-\u9fff][^.?!]{0,90})$/);
    if (letterHeading?.[1] && letterHeading[2]) {
      const title = letterHeading[2].trim();
      const firstWord = title.split(/\s+/)[0]?.toLowerCase() ?? '';
      const wordCount = title.split(/\s+/).length;
      if (!STOP_HEADING_TITLES.has(firstWord) && wordCount <= 8) {
        add(letterHeading[1]);
      }
    }
  }

  return labels;
}
