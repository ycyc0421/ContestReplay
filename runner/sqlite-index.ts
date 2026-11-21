import { constants, chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { agentKind } from './agent-manifest.js';
import { loadAgent, loadContest } from './config.js';
import { Connections } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { documentFormat, parseDocumentText } from './serialization.js';

export const INDEX_SCHEMA_VERSION = 1;

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'runs']);
const MAX_CONFIG_BYTES = 1_048_576; // 1 MiB
const MAX_BATCH_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_EVENTS_BYTES = 64 * 1024 * 1024; // 64 MiB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textVal = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numVal = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : 'Invalid configuration');
const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, ch => `\\${ch}`);
}

async function readBoundedNoFollow(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (info.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${filePath}`);
    const buf = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buf, offset, info.size - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset === info.size ? buf : buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export interface IndexedAgent {
  path: string;
  id: string;
  name?: string;
  model: string;
  vendor?: string;
  harness: string;
  provider?: string;
  speed_tier?: string;
  valid: boolean;
  issues: string[];
  mtime_ms: number;
  size: number;
  indexed_at: string;
}

export interface IndexedContest {
  path: string;
  id: string;
  title: string;
  data_version: number;
  judge_kind: string;
  problem_count: number;
  time_limit_ms: number;
  valid: boolean;
  issues: string[];
  mtime_ms: number;
  size: number;
  indexed_at: string;
}

export interface IndexedRun {
  run_id: string;
  batch_id?: string;
  agent_id: string;
  agent_name?: string;
  agent_revision: string;
  speed_tier?: string;
  contest_id: string;
  data_version: number;
  status: string;
  reason?: string;
  score?: number;
  max_score?: number;
  created_at?: string;
  indexed_at: string;
}

export interface ListAgentsOptions {
  search?: string;
  vendor?: string;
  harness?: string;
  provider?: string;
  validOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListContestsOptions {
  search?: string;
  judgeKind?: string;
  validOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface CoverageQueryOptions {
  agentIds?: string[];
  contestIds?: string[];
  includeInvalid?: boolean;
}

export interface CoverageCell {
  agent_id: string;
  agent_name?: string;
  agent_path: string;
  contest_id: string;
  contest_title?: string;
  contest_path: string;
  data_version: number;
  completed_count: number;
  void_count: number;
  total_runs: number;
  latest_status: string | null;
  latest_run_id?: string;
  best_score?: number;
  max_score?: number;
}

export interface UncoveredOptions {
  agentIds?: string[];
  contestIds?: string[];
  minRepeats?: number;
  includeVoid?: boolean;
  maxCells?: number;
}

export type UncoveredReason = 'unrun' | 'below_repeats' | 'void_only';

export interface UncoveredCell {
  agent: string;
  contest: string;
  agent_id: string;
  contest_id: string;
  data_version: number;
  missing_repeats: number;
  reason: UncoveredReason;
}

export interface UncoveredResult {
  cells: UncoveredCell[];
  total_gaps: number;
}

export interface SyncOptions {
  base?: string;
  root?: string;
  store?: Connections;
}

export interface SyncStats {
  agents_indexed: number;
  agents_reused: number;
  agents_pruned: number;
  contests_indexed: number;
  contests_reused: number;
  contests_pruned: number;
  batches_indexed: number;
  batches_reused: number;
  batches_pruned: number;
  runs_indexed: number;
  runs_reused: number;
  runs_pruned: number;
}

export interface BatchSpecV2 {
  schema_version: 2;
  cells: Array<{ agent: string; contest: string }>;
}

export function toBatchSpec(gaps: UncoveredResult | readonly Pick<UncoveredCell, 'agent' | 'contest'>[]): BatchSpecV2 {
  const list = Array.isArray(gaps) ? gaps : (gaps as UncoveredResult).cells;
  const seen = new Set<string>();
  const cells: Array<{ agent: string; contest: string }> = [];
  for (const item of list) {
    const key = JSON.stringify([item.agent, item.contest]);
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ agent: item.agent, contest: item.contest });
    if (cells.length >= 1000) break;
  }
  return { schema_version: 2, cells };
}

interface AgentRow {
  path: string;
  id: string;
  name: string | null;
  model: string;
  vendor: string | null;
  harness: string;
  provider: string | null;
  speed_tier: string | null;
  valid: number;
  issues_json: string;
  mtime_ms: number;
  size: number;
  indexed_at: string;
}

interface ContestRow {
  path: string;
  id: string;
  title: string;
  data_version: number;
  judge_kind: string;
  problem_count: number;
  time_limit_ms: number;
  valid: number;
  issues_json: string;
  mtime_ms: number;
  size: number;
  indexed_at: string;
}

interface CachedFileState {
  kind: string;
  mtime_ms: number;
  size: number;
}

interface BatchRunRow {
  batch_id: string;
  job_index: number;
  run_id: string | null;
  status: string;
  reason: string | null;
  agent_id: string;
  agent_name: string | null;
  agent_revision: string;
  speed_tier: string | null;
  contest_id: string;
  data_version: number;
  created_at: string;
}

const batchFileSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  created_at: z.string().min(1),
  plan: z.object({
    jobs: z.array(
      z.object({
        agent_id: z.string().min(1),
        agent_name: z.string().optional(),
        agent_revision: z.string().min(1),
        speed_tier: z.string().optional(),
        contest_id: z.string().min(1),
        data_version: z.number().int().positive(),
      }),
    ),
  }),
  jobs: z.array(
    z.object({
      status: z.string().min(1),
      run_id: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
});

function parseEventsTerminal(rawText: string): {
  status?: string;
  reason?: string;
  score?: number;
  max_score?: number;
} {
  let result: { status?: string; reason?: string; score?: number; max_score?: number } = {};
  const lines = rawText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = record(JSON.parse(line));
      if (parsed.type === 'run_ended') {
        result = {
          status: textVal(parsed.status),
          reason: textVal(parsed.reason),
          score: numVal(parsed.score),
          max_score: numVal(parsed.max_score),
        };
        break;
      }
    } catch {
      // Ignore partial or malformed trailing line.
    }
  }
  return result;
}

export class WorkspaceIndex {
  readonly workspaceDir: string;
  readonly dbPath: string;
  private db: DatabaseSync;
  private closed = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.dbPath = join(this.workspaceDir, '.index.sqlite');
    mkdirSync(this.workspaceDir, { recursive: true, mode: 0o700 });
    try {
      const info = lstatSync(this.dbPath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Refusing to open non-regular SQLite index path: ${this.dbPath}`);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    this.db = new DatabaseSync(this.dbPath);
    this.hardenFileModes();
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    this.initSchema();
    this.hardenFileModes();
  }

  private hardenFileModes(): void {
    for (const filePath of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        const info = lstatSync(filePath);
        if (info.isFile() && !info.isSymbolicLink()) {
          chmodSync(filePath, 0o600);
        }
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const versionRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value?: string }
      | undefined;
    if (versionRow?.value !== String(INDEX_SCHEMA_VERSION)) {
      this.db.exec(`
        DROP TABLE IF EXISTS agents;
        DROP TABLE IF EXISTS contests;
        DROP TABLE IF EXISTS runs;
        DROP TABLE IF EXISTS batches;
        DROP TABLE IF EXISTS scanned_files;
        DROP TABLE IF EXISTS batch_runs;
        DROP TABLE IF EXISTS run_file_state;
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        path TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        name TEXT,
        model TEXT NOT NULL,
        vendor TEXT,
        harness TEXT NOT NULL,
        provider TEXT,
        speed_tier TEXT,
        valid INTEGER NOT NULL,
        issues_json TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agents_id ON agents(id);
      CREATE INDEX IF NOT EXISTS idx_agents_vendor ON agents(vendor);
      CREATE INDEX IF NOT EXISTS idx_agents_harness ON agents(harness);
      CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents(provider);
      CREATE INDEX IF NOT EXISTS idx_agents_valid ON agents(valid);

      CREATE TABLE IF NOT EXISTS contests (
        path TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        data_version INTEGER NOT NULL,
        judge_kind TEXT NOT NULL,
        problem_count INTEGER NOT NULL,
        time_limit_ms INTEGER NOT NULL,
        valid INTEGER NOT NULL,
        issues_json TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contests_id ON contests(id);
      CREATE INDEX IF NOT EXISTS idx_contests_judge_kind ON contests(judge_kind);
      CREATE INDEX IF NOT EXISTS idx_contests_valid ON contests(valid);

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        batch_id TEXT,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        agent_revision TEXT NOT NULL,
        speed_tier TEXT,
        contest_id TEXT NOT NULL,
        data_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        score REAL,
        max_score REAL,
        created_at TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_cell ON runs(agent_id, contest_id, data_version);
      CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        job_count INTEGER NOT NULL,
        completed_count INTEGER NOT NULL,
        void_count INTEGER NOT NULL,
        queued_count INTEGER NOT NULL,
        running_count INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scanned_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS batch_runs (
        batch_id TEXT NOT NULL,
        job_index INTEGER NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        agent_revision TEXT NOT NULL,
        speed_tier TEXT,
        contest_id TEXT NOT NULL,
        data_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, job_index)
      );
      CREATE INDEX IF NOT EXISTS idx_batch_runs_run_id ON batch_runs(run_id);

      CREATE TABLE IF NOT EXISTS run_file_state (
        run_id TEXT PRIMARY KEY,
        run_mtime_ms REAL,
        events_mtime_ms REAL,
        events_size INTEGER,
        batch_mtime_ms REAL
      );
    `);

    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(INDEX_SCHEMA_VERSION),
    );
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('WorkspaceIndex is closed');
  }

  private withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure if transaction already aborted.
      }
      throw error;
    }
  }

  async sync(opts: SyncOptions = {}): Promise<SyncStats> {
    this.assertOpen();
    const base = resolve(opts.base ?? process.cwd());
    const root = resolve(opts.root ?? this.workspaceDir);
    const store = opts.store ?? new Connections();
    const nowIso = new Date().toISOString();

    const stats: SyncStats = {
      agents_indexed: 0,
      agents_reused: 0,
      agents_pruned: 0,
      contests_indexed: 0,
      contests_reused: 0,
      contests_pruned: 0,
      batches_indexed: 0,
      batches_reused: 0,
      batches_pruned: 0,
      runs_indexed: 0,
      runs_reused: 0,
      runs_pruned: 0,
    };

    await this.syncConfigs(base, store, nowIso, stats);
    await this.syncBatchesAndRuns(root, nowIso, stats);
    this.hardenFileModes();
    return stats;
  }

  private async syncConfigs(base: string, store: Connections, nowIso: string, stats: SyncStats): Promise<void> {
    const providerIds = new Set((await store.list().catch(() => [])).map(p => p.id));

    const cachedFiles = new Map<string, CachedFileState>();
    for (const row of this.db.prepare('SELECT path, kind, mtime_ms, size FROM scanned_files').all() as unknown as Array<{
      path: string;
      kind: string;
      mtime_ms: number;
      size: number;
    }>) {
      cachedFiles.set(row.path, { kind: row.kind, mtime_ms: row.mtime_ms, size: row.size });
    }

    const cachedAgents = new Map<string, { mtime_ms: number; size: number; provider: string | null; valid: number }>();
    for (const row of this.db.prepare('SELECT path, mtime_ms, size, provider, valid FROM agents').all() as unknown as Array<{
      path: string;
      mtime_ms: number;
      size: number;
      provider: string | null;
      valid: number;
    }>) {
      cachedAgents.set(row.path, row);
    }

    const cachedContests = new Map<string, { mtime_ms: number; size: number }>();
    for (const row of this.db.prepare('SELECT path, mtime_ms, size FROM contests').all() as unknown as Array<{
      path: string;
      mtime_ms: number;
      size: number;
    }>) {
      cachedContests.set(row.path, row);
    }

    const seenPaths = new Set<string>();
    const seenAgentPaths = new Set<string>();
    const seenContestPaths = new Set<string>();

    const agentUpserts: Array<{
      path: string;
      id: string;
      name: string | null;
      model: string;
      vendor: string | null;
      harness: string;
      provider: string | null;
      speed_tier: string | null;
      valid: number;
      issues_json: string;
      mtime_ms: number;
      size: number;
      indexed_at: string;
    }> = [];

    const contestUpserts: Array<{
      path: string;
      id: string;
      title: string;
      data_version: number;
      judge_kind: string;
      problem_count: number;
      time_limit_ms: number;
      valid: number;
      issues_json: string;
      mtime_ms: number;
      size: number;
      indexed_at: string;
    }> = [];

    const scannedUpserts: Array<{ path: string; kind: string; mtime_ms: number; size: number }> = [];

    // Streaming iterative directory walk without a hard 10,000-file cap.
    const dirs: string[] = [];
    try {
      const baseStat = await lstat(base);
      if (baseStat.isDirectory() && !baseStat.isSymbolicLink()) {
        dirs.push(base);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    while (dirs.length > 0) {
      const currentDir = dirs.pop()!;
      let entries: string[];
      try {
        entries = await readdir(currentDir);
      } catch {
        continue;
      }
      entries.sort();
      for (const name of entries) {
        if (name.startsWith('.') || SKIPPED_DIRS.has(name)) continue;
        const fullPath = join(currentDir, name);
        let info;
        try {
          info = await lstat(fullPath);
        } catch {
          continue;
        }
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          dirs.push(fullPath);
          continue;
        }
        if (!info.isFile() || !/\.(toml|yaml|yml|json)$/i.test(name)) continue;

        const relPath = relative(base, fullPath);
        seenPaths.add(relPath);
        const mtimeMs = info.mtimeMs;
        const size = info.size;

        const prev = cachedFiles.get(relPath);
        if (prev && prev.mtime_ms === mtimeMs && prev.size === size) {
          if (prev.kind === 'other') continue;
          if (prev.kind === 'contest' && cachedContests.has(relPath)) {
            seenContestPaths.add(relPath);
            stats.contests_reused++;
            continue;
          }
          if (prev.kind === 'agent') {
            const cachedAgent = cachedAgents.get(relPath);
            const providerMatches =
              cachedAgent !== undefined &&
              (cachedAgent.provider === null ||
                (cachedAgent.valid === 1 && providerIds.has(cachedAgent.provider)) ||
                (cachedAgent.valid === 0 && !providerIds.has(cachedAgent.provider)));
            if (cachedAgent && providerMatches) {
              seenAgentPaths.add(relPath);
              stats.agents_reused++;
              continue;
            }
          }
        }

        if (size > MAX_CONFIG_BYTES) {
          scannedUpserts.push({ path: relPath, kind: 'other', mtime_ms: mtimeMs, size });
          continue;
        }

        let raw: Record<string, unknown>;
        try {
          const bytes = await readBoundedNoFollow(fullPath, MAX_CONFIG_BYTES);
          raw = record(parseDocumentText(bytes.toString('utf8'), documentFormat(fullPath)));
        } catch {
          scannedUpserts.push({ path: relPath, kind: 'other', mtime_ms: mtimeMs, size });
          continue;
        }

        const isAgent = raw.kind === agentKind || 'agent_id' in raw || ('harness' in raw && 'model' in raw);
        const isContest = !isAgent && 'contest_id' in raw;

        if (isAgent) {
          seenAgentPaths.add(relPath);
          const loaded = await loadAgent(fullPath, store).then(
            value => ({ value }),
            error => ({ error }),
          );
          const harnessObj = record(raw.harness);
          const provider =
            textVal(raw.provider) ?? textVal(raw.connection) ?? ('value' in loaded ? loaded.value.connection : undefined);
          const id =
            textVal(raw.id) ??
            textVal(raw.agent_id) ??
            ('value' in loaded ? loaded.value.agent.agent_id : name);
          const displayName =
            ('value' in loaded ? loaded.value.agentName : undefined) ?? (textVal(raw.name)?.trim() || undefined);
          const rawTier = speedTierSchema.safeParse(raw.speed_tier);
          const speedTier =
            'value' in loaded ? loaded.value.speedTier : rawTier.success ? rawTier.data : undefined;
          const issues = 'error' in loaded ? [errMsg(loaded.error)] : [];

          agentUpserts.push({
            path: relPath,
            id,
            name: displayName ?? null,
            model: textVal(raw.model) ?? ('value' in loaded ? loaded.value.profile.model : ''),
            vendor: textVal(raw.vendor) ?? ('value' in loaded ? loaded.value.vendor ?? null : null),
            harness:
              textVal(harnessObj.kind) ??
              textVal(raw.harness) ??
              ('value' in loaded ? loaded.value.profile.harness : 'unknown'),
            provider: provider ?? null,
            speed_tier: speedTier ?? null,
            valid: 'value' in loaded ? 1 : 0,
            issues_json: JSON.stringify(issues),
            mtime_ms: mtimeMs,
            size,
            indexed_at: nowIso,
          });
          scannedUpserts.push({ path: relPath, kind: 'agent', mtime_ms: mtimeMs, size });
          stats.agents_indexed++;
        } else if (isContest) {
          seenContestPaths.add(relPath);
          const loaded = await loadContest(fullPath).then(
            value => ({ value }),
            error => ({ error }),
          );
          const judgeObj = record(raw.judge);
          const rulesObj = record(raw.rules);
          const issues = 'error' in loaded ? [errMsg(loaded.error)] : [];
          contestUpserts.push({
            path: relPath,
            id: textVal(raw.contest_id) ?? name,
            title: textVal(raw.title) ?? textVal(raw.contest_id) ?? name,
            data_version: typeof raw.data_version === 'number' && Number.isInteger(raw.data_version) ? raw.data_version : 1,
            judge_kind: textVal(judgeObj.kind) ?? 'unknown',
            problem_count:
              'value' in loaded
                ? loaded.value.contest.problems.length
                : Array.isArray(raw.problems)
                  ? raw.problems.length
                  : 0,
            time_limit_ms:
              'value' in loaded
                ? loaded.value.contest.rules.time_limit_ms
                : typeof rulesObj.time_limit_ms === 'number'
                  ? Math.round(rulesObj.time_limit_ms)
                  : 900_000,
            valid: 'value' in loaded ? 1 : 0,
            issues_json: JSON.stringify(issues),
            mtime_ms: mtimeMs,
            size,
            indexed_at: nowIso,
          });
          scannedUpserts.push({ path: relPath, kind: 'contest', mtime_ms: mtimeMs, size });
          stats.contests_indexed++;
        } else {
          scannedUpserts.push({ path: relPath, kind: 'other', mtime_ms: mtimeMs, size });
        }
      }
    }

    this.withTransaction(() => {
      const upsertAgent = this.db.prepare(`
        INSERT OR REPLACE INTO agents (
          path, id, name, model, vendor, harness, provider, speed_tier, valid, issues_json, mtime_ms, size, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of agentUpserts) {
        upsertAgent.run(
          a.path,
          a.id,
          a.name,
          a.model,
          a.vendor,
          a.harness,
          a.provider,
          a.speed_tier,
          a.valid,
          a.issues_json,
          a.mtime_ms,
          a.size,
          a.indexed_at,
        );
      }

      const upsertContest = this.db.prepare(`
        INSERT OR REPLACE INTO contests (
          path, id, title, data_version, judge_kind, problem_count, time_limit_ms, valid, issues_json, mtime_ms, size, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of contestUpserts) {
        upsertContest.run(
          c.path,
          c.id,
          c.title,
          c.data_version,
          c.judge_kind,
          c.problem_count,
          c.time_limit_ms,
          c.valid,
          c.issues_json,
          c.mtime_ms,
          c.size,
          c.indexed_at,
        );
      }

      const upsertScanned = this.db.prepare(
        'INSERT OR REPLACE INTO scanned_files (path, kind, mtime_ms, size) VALUES (?, ?, ?, ?)',
      );
      for (const s of scannedUpserts) {
        upsertScanned.run(s.path, s.kind, s.mtime_ms, s.size);
      }

      const delAgent = this.db.prepare('DELETE FROM agents WHERE path = ?');
      for (const oldPath of cachedAgents.keys()) {
        if (!seenAgentPaths.has(oldPath)) {
          delAgent.run(oldPath);
          stats.agents_pruned++;
        }
      }

      const delContest = this.db.prepare('DELETE FROM contests WHERE path = ?');
      for (const oldPath of cachedContests.keys()) {
        if (!seenContestPaths.has(oldPath)) {
          delContest.run(oldPath);
          stats.contests_pruned++;
        }
      }

      const delScanned = this.db.prepare('DELETE FROM scanned_files WHERE path = ?');
      for (const oldPath of cachedFiles.keys()) {
        if (!seenPaths.has(oldPath)) {
          delScanned.run(oldPath);
        }
      }
    });
  }

  private async syncBatchesAndRuns(root: string, nowIso: string, stats: SyncStats): Promise<void> {
    const cachedBatches = new Map<string, number>();
    for (const row of this.db.prepare('SELECT batch_id, mtime_ms FROM batches').all() as unknown as Array<{
      batch_id: string;
      mtime_ms: number;
    }>) {
      cachedBatches.set(row.batch_id, row.mtime_ms);
    }

    const seenBatchIds = new Set<string>();
    const batchUpserts: Array<{
      batch_id: string;
      created_at: string;
      job_count: number;
      completed_count: number;
      void_count: number;
      queued_count: number;
      running_count: number;
      mtime_ms: number;
      indexed_at: string;
      runs: BatchRunRow[];
    }> = [];

    const batchesPath = join(root, '.batches');
    let batchEntries: string[] = [];
    try {
      const info = await lstat(batchesPath);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        batchEntries = await readdir(batchesPath);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    for (const name of batchEntries.sort()) {
      if (!name.endsWith('.json')) continue;
      const batchId = name.slice(0, -5);
      if (!UUID_RE.test(batchId)) continue;
      const filePath = join(batchesPath, name);
      let info;
      try {
        info = await lstat(filePath);
      } catch {
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) continue;

      seenBatchIds.add(batchId);
      const prevMtime = cachedBatches.get(batchId);
      if (prevMtime !== undefined && prevMtime === info.mtimeMs) {
        stats.batches_reused++;
        continue;
      }

      try {
        const bytes = await readBoundedNoFollow(filePath, MAX_BATCH_BYTES);
        const parsed = batchFileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
        if (!parsed.success || parsed.data.id !== batchId) continue;
        const batch = parsed.data;
        let completed = 0;
        let voidCount = 0;
        let queued = 0;
        let running = 0;
        const batchRuns: BatchRunRow[] = [];
        for (let i = 0; i < batch.jobs.length; i++) {
          const job = batch.jobs[i]!;
          const planJob = batch.plan.jobs[i];
          if (job.status === 'completed') completed++;
          else if (job.status === 'void') voidCount++;
          else if (job.status === 'queued') queued++;
          else if (job.status === 'running') running++;
          if (planJob) {
            batchRuns.push({
              batch_id: batchId,
              job_index: i,
              run_id: job.run_id ?? null,
              status: job.status,
              reason: job.reason ?? null,
              agent_id: planJob.agent_id,
              agent_name: planJob.agent_name ?? null,
              agent_revision: planJob.agent_revision,
              speed_tier: planJob.speed_tier ?? null,
              contest_id: planJob.contest_id,
              data_version: planJob.data_version,
              created_at: batch.created_at,
            });
          }
        }
        batchUpserts.push({
          batch_id: batchId,
          created_at: batch.created_at,
          job_count: batch.jobs.length,
          completed_count: completed,
          void_count: voidCount,
          queued_count: queued,
          running_count: running,
          mtime_ms: info.mtimeMs,
          indexed_at: nowIso,
          runs: batchRuns,
        });
        stats.batches_indexed++;
      } catch {
        // Ignore corrupt or partially written batch file.
      }
    }

    // Apply batch updates and pruning first so batch_runs reflects current batches.
    this.withTransaction(() => {
      const upsertBatch = this.db.prepare(`
        INSERT OR REPLACE INTO batches (
          batch_id, created_at, job_count, completed_count, void_count, queued_count, running_count, mtime_ms, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const delBatchRuns = this.db.prepare('DELETE FROM batch_runs WHERE batch_id = ?');
      const insBatchRun = this.db.prepare(`
        INSERT INTO batch_runs (
          batch_id, job_index, run_id, status, reason, agent_id, agent_name, agent_revision, speed_tier, contest_id, data_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const b of batchUpserts) {
        upsertBatch.run(
          b.batch_id,
          b.created_at,
          b.job_count,
          b.completed_count,
          b.void_count,
          b.queued_count,
          b.running_count,
          b.mtime_ms,
          b.indexed_at,
        );
        delBatchRuns.run(b.batch_id);
        for (const br of b.runs) {
          insBatchRun.run(
            br.batch_id,
            br.job_index,
            br.run_id,
            br.status,
            br.reason,
            br.agent_id,
            br.agent_name,
            br.agent_revision,
            br.speed_tier,
            br.contest_id,
            br.data_version,
            br.created_at,
          );
        }
      }

      const delBatch = this.db.prepare('DELETE FROM batches WHERE batch_id = ?');
      for (const oldBatchId of cachedBatches.keys()) {
        if (!seenBatchIds.has(oldBatchId)) {
          delBatch.run(oldBatchId);
          delBatchRuns.run(oldBatchId);
          stats.batches_pruned++;
        }
      }
    });

    // Build run_id -> batch run metadata map (plus batch mtime).
    const batchMtimes = new Map<string, number>();
    for (const row of this.db.prepare('SELECT batch_id, mtime_ms FROM batches').all() as unknown as Array<{
      batch_id: string;
      mtime_ms: number;
    }>) {
      batchMtimes.set(row.batch_id, row.mtime_ms);
    }

    const batchRunByRunId = new Map<string, BatchRunRow & { batch_mtime_ms: number }>();
    for (const row of this.db
      .prepare('SELECT * FROM batch_runs WHERE run_id IS NOT NULL')
      .all() as unknown as BatchRunRow[]) {
      if (row.run_id) {
        batchRunByRunId.set(row.run_id, { ...row, batch_mtime_ms: batchMtimes.get(row.batch_id) ?? 0 });
      }
    }

    const cachedRunStates = new Map<
      string,
      { run_mtime_ms: number | null; events_mtime_ms: number | null; events_size: number | null; batch_mtime_ms: number | null }
    >();
    for (const row of this.db.prepare('SELECT * FROM run_file_state').all() as unknown as Array<{
      run_id: string;
      run_mtime_ms: number | null;
      events_mtime_ms: number | null;
      events_size: number | null;
      batch_mtime_ms: number | null;
    }>) {
      cachedRunStates.set(row.run_id, row);
    }

    const existingRunIds = new Set<string>(
      (this.db.prepare('SELECT run_id FROM runs').all() as unknown as Array<{ run_id: string }>).map(r => r.run_id),
    );

    const seenRunIds = new Set<string>();
    const runUpserts: Array<{
      run_id: string;
      batch_id: string | null;
      agent_id: string;
      agent_name: string | null;
      agent_revision: string;
      speed_tier: string | null;
      contest_id: string;
      data_version: number;
      status: string;
      reason: string | null;
      score: number | null;
      max_score: number | null;
      created_at: string | null;
      indexed_at: string;
      state: {
        run_mtime_ms: number | null;
        events_mtime_ms: number | null;
        events_size: number | null;
        batch_mtime_ms: number | null;
      };
    }> = [];

    // Scan run directories directly under root.
    let rootEntries: string[] = [];
    try {
      const info = await lstat(root);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        rootEntries = await readdir(root);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }

    for (const name of rootEntries.sort()) {
      if (!UUID_RE.test(name)) continue;
      const runDir = join(root, name);
      let dirInfo;
      try {
        dirInfo = await lstat(runDir);
      } catch {
        continue;
      }
      if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;

      const runJsonPath = join(runDir, 'run.json');
      let runStat;
      try {
        runStat = await lstat(runJsonPath);
      } catch {
        continue;
      }
      if (!runStat.isFile() || runStat.isSymbolicLink()) continue;

      const eventsPath = join(runDir, 'events.jsonl');
      let eventsStat: { mtimeMs: number; size: number } | undefined;
      try {
        const st = await lstat(eventsPath);
        if (st.isFile() && !st.isSymbolicLink()) {
          eventsStat = { mtimeMs: st.mtimeMs, size: st.size };
        }
      } catch {
        // Optional events.jsonl if run just started.
      }

      const batchInfo = batchRunByRunId.get(name);
      const batchMtime = batchInfo ? batchInfo.batch_mtime_ms : null;

      seenRunIds.add(name);
      const prevState = cachedRunStates.get(name);
      if (
        prevState &&
        existingRunIds.has(name) &&
        prevState.run_mtime_ms === runStat.mtimeMs &&
        prevState.events_mtime_ms === (eventsStat?.mtimeMs ?? null) &&
        prevState.events_size === (eventsStat?.size ?? null) &&
        prevState.batch_mtime_ms === batchMtime
      ) {
        stats.runs_reused++;
        continue;
      }

      try {
        const metaBytes = await readBoundedNoFollow(runJsonPath, MAX_CONFIG_BYTES);
        const meta = record(JSON.parse(metaBytes.toString('utf8')));
        const runId = textVal(meta.run_id) ?? name;
        if (runId !== name) continue;

        const modelObj = record(meta.model);
        const agentId = textVal(meta.agent_id) ?? batchInfo?.agent_id;
        const contestId = textVal(meta.contest_id) ?? batchInfo?.contest_id;
        const agentRevision = textVal(meta.agent_revision) ?? batchInfo?.agent_revision;
        const dataVersion = numVal(meta.data_version) ?? batchInfo?.data_version ?? 1;
        if (!agentId || !contestId || !agentRevision) continue;

        let terminal: { status?: string; reason?: string; score?: number; max_score?: number } = {};
        if (eventsStat && eventsStat.size <= MAX_EVENTS_BYTES) {
          try {
            const evBytes = await readBoundedNoFollow(eventsPath, MAX_EVENTS_BYTES);
            terminal = parseEventsTerminal(evBytes.toString('utf8'));
          } catch {
            // Leave terminal empty if events.jsonl cannot be read.
          }
        }

        const status = terminal.status ?? batchInfo?.status ?? 'running';
        const reason = terminal.reason ?? batchInfo?.reason ?? null;
        const createdAt =
          textVal(meta.started_at) ??
          textVal(meta.created_at) ??
          batchInfo?.created_at ??
          new Date(runStat.mtimeMs).toISOString();

        runUpserts.push({
          run_id: name,
          batch_id: batchInfo?.batch_id ?? null,
          agent_id: agentId,
          agent_name: textVal(meta.agent_name) ?? batchInfo?.agent_name ?? null,
          agent_revision: agentRevision,
          speed_tier: textVal(modelObj.speed_tier) ?? batchInfo?.speed_tier ?? null,
          contest_id: contestId,
          data_version: Math.trunc(dataVersion),
          status,
          reason,
          score: terminal.score ?? null,
          max_score: terminal.max_score ?? null,
          created_at: createdAt,
          indexed_at: nowIso,
          state: {
            run_mtime_ms: runStat.mtimeMs,
            events_mtime_ms: eventsStat?.mtimeMs ?? null,
            events_size: eventsStat?.size ?? null,
            batch_mtime_ms: batchMtime,
          },
        });
        stats.runs_indexed++;
      } catch {
        // Ignore malformed run.json.
      }
    }

    // Also include batch jobs with a run_id that don't have a run.json on disk.
    for (const [runId, br] of batchRunByRunId) {
      if (seenRunIds.has(runId)) continue;
      seenRunIds.add(runId);
      const prevState = cachedRunStates.get(runId);
      if (
        prevState &&
        existingRunIds.has(runId) &&
        prevState.run_mtime_ms === null &&
        prevState.events_mtime_ms === null &&
        prevState.events_size === null &&
        prevState.batch_mtime_ms === br.batch_mtime_ms
      ) {
        stats.runs_reused++;
        continue;
      }
      runUpserts.push({
        run_id: runId,
        batch_id: br.batch_id,
        agent_id: br.agent_id,
        agent_name: br.agent_name,
        agent_revision: br.agent_revision,
        speed_tier: br.speed_tier,
        contest_id: br.contest_id,
        data_version: br.data_version,
        status: br.status,
        reason: br.reason,
        score: null,
        max_score: null,
        created_at: br.created_at,
        indexed_at: nowIso,
        state: {
          run_mtime_ms: null,
          events_mtime_ms: null,
          events_size: null,
          batch_mtime_ms: br.batch_mtime_ms,
        },
      });
      stats.runs_indexed++;
    }

    this.withTransaction(() => {
      const upsertRun = this.db.prepare(`
        INSERT OR REPLACE INTO runs (
          run_id, batch_id, agent_id, agent_name, agent_revision, speed_tier,
          contest_id, data_version, status, reason, score, max_score, created_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const upsertState = this.db.prepare(`
        INSERT OR REPLACE INTO run_file_state (
          run_id, run_mtime_ms, events_mtime_ms, events_size, batch_mtime_ms
        ) VALUES (?, ?, ?, ?, ?)
      `);

      for (const r of runUpserts) {
        upsertRun.run(
          r.run_id,
          r.batch_id,
          r.agent_id,
          r.agent_name,
          r.agent_revision,
          r.speed_tier,
          r.contest_id,
          r.data_version,
          r.status,
          r.reason,
          r.score,
          r.max_score,
          r.created_at,
          r.indexed_at,
        );
        upsertState.run(
          r.run_id,
          r.state.run_mtime_ms,
          r.state.events_mtime_ms,
          r.state.events_size,
          r.state.batch_mtime_ms,
        );
      }

      const delRun = this.db.prepare('DELETE FROM runs WHERE run_id = ?');
      const delState = this.db.prepare('DELETE FROM run_file_state WHERE run_id = ?');
      for (const oldRunId of existingRunIds) {
        if (!seenRunIds.has(oldRunId)) {
          delRun.run(oldRunId);
          delState.run(oldRunId);
          stats.runs_pruned++;
        }
      }
    });
  }

  listAgents(opts: ListAgentsOptions = {}): { total: number; items: IndexedAgent[] } {
    this.assertOpen();
    const where: string[] = [];
    const params: SQLInputValue[] = [];

    if (opts.search?.trim()) {
      const pattern = `%${escapeLike(opts.search.trim().toLowerCase())}%`;
      where.push(
        `(LOWER(id) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(name, '')) LIKE ? ESCAPE '\\' OR LOWER(model) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(vendor, '')) LIKE ? ESCAPE '\\' OR LOWER(path) LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (opts.vendor !== undefined) {
      where.push('vendor = ?');
      params.push(opts.vendor);
    }
    if (opts.harness !== undefined) {
      where.push('harness = ?');
      params.push(opts.harness);
    }
    if (opts.provider !== undefined) {
      where.push('provider = ?');
      params.push(opts.provider);
    }
    if (opts.validOnly) {
      where.push('valid = 1');
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM agents ${whereClause}`)
      .get(...params) as { cnt: number };
    const rows = this.db
      .prepare(`SELECT * FROM agents ${whereClause} ORDER BY id ASC, path ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as AgentRow[];

    return {
      total: Number(totalRow.cnt),
      items: rows.map(row => ({
        path: row.path,
        id: row.id,
        ...(row.name !== null ? { name: row.name } : {}),
        model: row.model,
        ...(row.vendor !== null ? { vendor: row.vendor } : {}),
        harness: row.harness,
        ...(row.provider !== null ? { provider: row.provider } : {}),
        ...(row.speed_tier !== null ? { speed_tier: row.speed_tier } : {}),
        valid: row.valid === 1,
        issues: JSON.parse(row.issues_json) as string[],
        mtime_ms: row.mtime_ms,
        size: row.size,
        indexed_at: row.indexed_at,
      })),
    };
  }

  listContests(opts: ListContestsOptions = {}): { total: number; items: IndexedContest[] } {
    this.assertOpen();
    const where: string[] = [];
    const params: SQLInputValue[] = [];

    if (opts.search?.trim()) {
      const pattern = `%${escapeLike(opts.search.trim().toLowerCase())}%`;
      where.push(
        `(LOWER(id) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(path) LIKE ? ESCAPE '\\')`,
      );
      params.push(pattern, pattern, pattern);
    }
    if (opts.judgeKind !== undefined) {
      where.push('judge_kind = ?');
      params.push(opts.judgeKind);
    }
    if (opts.validOnly) {
      where.push('valid = 1');
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 100)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM contests ${whereClause}`)
      .get(...params) as { cnt: number };
    const rows = this.db
      .prepare(`SELECT * FROM contests ${whereClause} ORDER BY title ASC, path ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as ContestRow[];

    return {
      total: Number(totalRow.cnt),
      items: rows.map(row => ({
        path: row.path,
        id: row.id,
        title: row.title,
        data_version: row.data_version,
        judge_kind: row.judge_kind,
        problem_count: row.problem_count,
        time_limit_ms: row.time_limit_ms,
        valid: row.valid === 1,
        issues: JSON.parse(row.issues_json) as string[],
        mtime_ms: row.mtime_ms,
        size: row.size,
        indexed_at: row.indexed_at,
      })),
    };
  }

  queryCoverage(opts: CoverageQueryOptions = {}): CoverageCell[] {
    this.assertOpen();
    const includeInvalid = opts.includeInvalid === true;

    const agentWhere: string[] = [];
    const agentParams: SQLInputValue[] = [];
    if (!includeInvalid) agentWhere.push('valid = 1');
    if (opts.agentIds?.length) {
      agentWhere.push(`id IN (${opts.agentIds.map(() => '?').join(', ')})`);
      agentParams.push(...opts.agentIds);
    }
    const agentRows = this.db
      .prepare(
        `SELECT path, id, name, valid FROM agents ${agentWhere.length ? `WHERE ${agentWhere.join(' AND ')}` : ''} ORDER BY id ASC, valid DESC, path ASC`,
      )
      .all(...agentParams) as unknown as Array<{ path: string; id: string; name: string | null; valid: number }>;

    const dedupAgents: Array<{ id: string; name: string | null; path: string }> = [];
    const seenAgentIds = new Set<string>();
    for (const a of agentRows) {
      if (seenAgentIds.has(a.id)) continue;
      seenAgentIds.add(a.id);
      dedupAgents.push({ id: a.id, name: a.name, path: a.path });
    }

    const contestWhere: string[] = [];
    const contestParams: SQLInputValue[] = [];
    if (!includeInvalid) contestWhere.push('valid = 1');
    if (opts.contestIds?.length) {
      contestWhere.push(`id IN (${opts.contestIds.map(() => '?').join(', ')})`);
      contestParams.push(...opts.contestIds);
    }
    const contestRows = this.db
      .prepare(
        `SELECT path, id, title, data_version, valid FROM contests ${contestWhere.length ? `WHERE ${contestWhere.join(' AND ')}` : ''} ORDER BY id ASC, data_version DESC, valid DESC, path ASC`,
      )
      .all(...contestParams) as unknown as Array<{
      path: string;
      id: string;
      title: string;
      data_version: number;
      valid: number;
    }>;

    const dedupContests: Array<{ id: string; title: string; data_version: number; path: string }> = [];
    const seenContestKeys = new Set<string>();
    for (const c of contestRows) {
      const key = `${c.id}\0${c.data_version}`;
      if (seenContestKeys.has(key)) continue;
      seenContestKeys.add(key);
      dedupContests.push({ id: c.id, title: c.title, data_version: c.data_version, path: c.path });
    }

    if (!dedupAgents.length || !dedupContests.length) return [];

    // Aggregate run counts and scores per (agent_id, contest_id, data_version).
    const runRows = this.db
      .prepare(`
        SELECT
          run_id,
          agent_id,
          contest_id,
          data_version,
          status,
          score,
          max_score,
          created_at
        FROM runs
        ORDER BY COALESCE(created_at, '') DESC, rowid DESC
      `)
      .all() as unknown as Array<{
      run_id: string;
      agent_id: string;
      contest_id: string;
      data_version: number;
      status: string;
      score: number | null;
      max_score: number | null;
      created_at: string | null;
    }>;

    type Agg = {
      completed_count: number;
      void_count: number;
      total_runs: number;
      latest_status: string | null;
      latest_run_id?: string;
      best_score?: number;
      max_score?: number;
    };
    const aggMap = new Map<string, Agg>();
    for (const r of runRows) {
      const key = `${r.agent_id}\0${r.contest_id}\0${r.data_version}`;
      let agg = aggMap.get(key);
      if (!agg) {
        agg = {
          completed_count: 0,
          void_count: 0,
          total_runs: 0,
          latest_status: r.status,
          latest_run_id: r.run_id,
        };
        aggMap.set(key, agg);
      }
      agg.total_runs++;
      if (r.status === 'completed') {
        agg.completed_count++;
        if (r.score !== null && (agg.best_score === undefined || r.score > agg.best_score)) {
          agg.best_score = r.score;
          if (r.max_score !== null) agg.max_score = r.max_score;
        }
      } else if (r.status === 'void') {
        agg.void_count++;
      }
      if (agg.max_score === undefined && r.max_score !== null) {
        agg.max_score = r.max_score;
      }
    }

    const cells: CoverageCell[] = [];
    for (const a of dedupAgents) {
      for (const c of dedupContests) {
        const key = `${a.id}\0${c.id}\0${c.data_version}`;
        const agg = aggMap.get(key);
        cells.push({
          agent_id: a.id,
          ...(a.name !== null ? { agent_name: a.name } : {}),
          agent_path: a.path,
          contest_id: c.id,
          contest_title: c.title,
          contest_path: c.path,
          data_version: c.data_version,
          completed_count: agg?.completed_count ?? 0,
          void_count: agg?.void_count ?? 0,
          total_runs: agg?.total_runs ?? 0,
          latest_status: agg?.latest_status ?? null,
          ...(agg?.latest_run_id !== undefined ? { latest_run_id: agg.latest_run_id } : {}),
          ...(agg?.best_score !== undefined ? { best_score: agg.best_score } : {}),
          ...(agg?.max_score !== undefined ? { max_score: agg.max_score } : {}),
        });
      }
    }
    return cells;
  }

  findUncoveredCells(opts: UncoveredOptions = {}): UncoveredResult {
    this.assertOpen();
    const minRepeats = Math.max(1, Math.floor(opts.minRepeats ?? 1));
    const includeVoid = opts.includeVoid !== false;
    const maxCells = Math.max(1, Math.min(10_000, Math.floor(opts.maxCells ?? 1000)));

    const coverage = this.queryCoverage({
      agentIds: opts.agentIds,
      contestIds: opts.contestIds,
      includeInvalid: false,
    });

    const gaps: UncoveredCell[] = [];
    for (const cell of coverage) {
      if (cell.completed_count >= minRepeats) continue;
      if (cell.total_runs === 0) {
        gaps.push({
          agent: cell.agent_path,
          contest: cell.contest_path,
          agent_id: cell.agent_id,
          contest_id: cell.contest_id,
          data_version: cell.data_version,
          missing_repeats: minRepeats,
          reason: 'unrun',
        });
      } else if (cell.completed_count === 0 && cell.void_count > 0) {
        if (!includeVoid) continue;
        gaps.push({
          agent: cell.agent_path,
          contest: cell.contest_path,
          agent_id: cell.agent_id,
          contest_id: cell.contest_id,
          data_version: cell.data_version,
          missing_repeats: minRepeats,
          reason: 'void_only',
        });
      } else {
        gaps.push({
          agent: cell.agent_path,
          contest: cell.contest_path,
          agent_id: cell.agent_id,
          contest_id: cell.contest_id,
          data_version: cell.data_version,
          missing_repeats: minRepeats - cell.completed_count,
          reason: 'below_repeats',
        });
      }
    }

    return {
      cells: gaps.slice(0, maxCells),
      total_gaps: gaps.length,
    };
  }

  toBatchSpec(gaps: UncoveredResult | readonly Pick<UncoveredCell, 'agent' | 'contest'>[]): BatchSpecV2 {
    return toBatchSpec(gaps);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
