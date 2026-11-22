import { constants, chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { agentKind } from './agent-manifest.js';
import {
  isForbiddenPublicFilename,
  loadVerifiedAgentFromDoc,
  loadVerifiedContestFromDoc,
  readConfinedRegularFile,
  resolveProtectedDirs,
} from './automation.js';
import { revisionFor, sha256 } from './config.js';
import { Connections, type Connection } from './connections.js';
import { speedTierSchema } from './harnesses.js';
import { protocolDigest, protocolDigestForPreset, resolveProtocolPreset } from './protocol.js';
import { canonical, documentFormat, parseDocumentText } from './serialization.js';

export const INDEX_SCHEMA_VERSION = 3;
const PLANNER_PLACEHOLDER_IMAGE = `sha256:${'0'.repeat(64)}`;

const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'runs']);
const MAX_CONFIG_BYTES = 1_048_576; // 1 MiB
const MAX_BATCH_BYTES = 16 * 1024 * 1024; // 16 MiB
const EVENTS_TAIL_BYTES = 256 * 1024; // 256 KiB tail scan for run_ended
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const textVal = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numVal = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : 'Invalid configuration');
const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function isSqliteCorruptError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { errcode?: number; errstr?: string; code?: string; message?: string };
  if (err.errcode === 11 || err.errcode === 26) return true; // SQLITE_CORRUPT (11), SQLITE_NOTADB (26)
  const text = `${err.errstr ?? ''} ${err.code ?? ''} ${err.message ?? ''}`;
  return /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(text);
}

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

async function readTailNoFollow(filePath: string, maxTailBytes: number): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (info.size === 0) return '';
    const start = Math.max(0, info.size - maxTailBytes);
    const len = info.size - start;
    const buf = Buffer.allocUnsafe(len);
    let offset = 0;
    while (offset < len) {
      const { bytesRead } = await handle.read(buf, offset, len - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const text = buf.subarray(0, offset).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      return nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

interface DepStat {
  path: string;
  mtime_ms: number | null;
  size: number | null;
}

async function statDep(baseReal: string, absPath: string): Promise<DepStat> {
  const rel = relative(baseReal, absPath);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { path: absPath, mtime_ms: -2, size: -2 };
  }
  try {
    const info = await lstat(absPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { path: absPath, mtime_ms: -1, size: -1 };
    }
    return { path: absPath, mtime_ms: info.mtimeMs, size: info.size };
  } catch {
    return { path: absPath, mtime_ms: null, size: null };
  }
}

async function depsUnchanged(baseReal: string, depsJson: string | null): Promise<boolean> {
  if (!depsJson) return true;
  let deps: DepStat[];
  try {
    deps = JSON.parse(depsJson) as DepStat[];
    if (!Array.isArray(deps)) return false;
  } catch {
    return false;
  }
  for (const dep of deps) {
    const current = await statDep(baseReal, dep.path);
    if (current.mtime_ms !== dep.mtime_ms || current.size !== dep.size) {
      return false;
    }
  }
  return true;
}

function collectAgentDepPaths(fullPath: string, raw: Record<string, unknown>): string[] {
  const dir = dirname(fullPath);
  const paths: string[] = [];
  const harnessObj = record(raw.harness);
  const nativeCfg = record(harnessObj.native_config);
  const nativePath = textVal(nativeCfg.path);
  if (nativePath) paths.push(resolve(dir, nativePath));
  const legacyConfig = textVal(raw.config);
  if (legacyConfig) paths.push(resolve(dir, legacyConfig));
  return [...new Set(paths)].sort();
}

function collectContestDepPaths(
  fullPath: string,
  raw: Record<string, unknown>,
): { materialPaths: string[]; judgePaths: string[]; allPaths: string[] } {
  const dir = dirname(fullPath);
  const materialPaths: string[] = [];
  const judgePaths: string[] = [];
  const materials = record(raw.materials);
  const entrypoint = record(materials.entrypoint);
  const entryPath = textVal(entrypoint.path);
  if (entryPath) materialPaths.push(resolve(dir, entryPath));
  const statement = record(raw.statement);
  const stmtPath = textVal(statement.path);
  if (stmtPath) materialPaths.push(resolve(dir, stmtPath));
  if (Array.isArray(materials.attachments)) {
    for (const att of materials.attachments) {
      const attPath = textVal(record(att).path);
      if (attPath) materialPaths.push(resolve(dir, attPath));
    }
  }
  const judge = record(raw.judge);
  const answers = record(judge.answers);
  const ansPath = textVal(answers.path) ?? textVal(judge.path);
  if (ansPath) judgePaths.push(resolve(dir, ansPath));
  const uniqueMaterials = [...new Set(materialPaths)].sort();
  const uniqueJudge = [...new Set(judgePaths)].sort();
  const allPaths = [...new Set([...uniqueMaterials, ...uniqueJudge])].sort();
  return { materialPaths: uniqueMaterials, judgePaths: uniqueJudge, allPaths };
}

function providerMetaHash(provider: Connection | undefined): string {
  if (!provider) return 'missing';
  return sha256(
    canonical({
      id: provider.id,
      protocol: provider.protocol,
      base_url: provider.base_url,
      approved_origin: provider.approved_origin,
      supports_fast: provider.supports_fast ?? null,
      supports_ultrafast: provider.supports_ultrafast ?? null,
    }),
  );
}

function cellCompatibility(
  harness: string,
  judgeKind: string,
  attachmentCount: number,
  agentId: string,
  contestId: string,
): { compatible: boolean; reason?: string } {
  if (harness === 'builtin-responses' && (judgeKind !== 'local' || attachmentCount > 0)) {
    return {
      compatible: false,
      reason: `Incompatible cell ${agentId} × ${contestId}: built-in Responses supports PDF and local answers only`,
    };
  }
  return { compatible: true };
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
  agent_revision?: string;
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
  contest_revision?: string;
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
  profile_sha256?: string;
  effective_sha256?: string;
  speed_tier?: string;
  contest_id: string;
  data_version: number;
  contest_revision?: string;
  contest_sha256?: string;
  protocol_sha256?: string;
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
  agent_revision?: string;
  contest_id: string;
  contest_title?: string;
  contest_path: string;
  contest_revision?: string;
  data_version: number;
  compatible: boolean;
  incompatible_reason?: string;
  completed_count: number;
  void_count: number;
  running_count: number;
  total_runs: number;
  historical_completed_count: number;
  historical_total_runs: number;
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

export type UncoveredReason = 'unrun' | 'below_repeats' | 'void_only' | 'running';

export interface UncoveredCell {
  agent: string;
  contest: string;
  agent_id: string;
  contest_id: string;
  data_version: number;
  missing_repeats: number;
  reason: UncoveredReason;
  running_count?: number;
}

export interface UncoveredResult {
  cells: UncoveredCell[];
  total_gaps: number;
  waves_required: number;
  truncated: boolean;
  incompatible_skipped: number;
}

export interface SyncOptions {
  base?: string;
  root?: string;
  store?: Connections;
  credentialDirs?: string[];
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

export function toBatchSpec(
  gaps: UncoveredResult | readonly Pick<UncoveredCell, 'agent' | 'contest'>[],
): BatchSpecV2 | null {
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
  if (cells.length === 0) return null;
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
  agent_revision: string | null;
  effective_sha256: string | null;
  provider_meta_hash: string | null;
  deps_json: string | null;
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
  attachment_count: number;
  contest_revision: string | null;
  contest_sha256: string | null;
  protocol_sha256: string | null;
  deps_json: string | null;
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
  profile_sha256: string | null;
  effective_sha256: string | null;
  speed_tier: string | null;
  contest_id: string;
  data_version: number;
  contest_sha256: string | null;
  protocol_sha256: string | null;
  created_at: string;
}

const batchFileSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  created_at: z.string().min(1),
  plan: z.object({
    protocol_sha256: z.string().optional(),
    jobs: z.array(
      z.object({
        agent_id: z.string().min(1),
        agent_name: z.string().optional(),
        agent_revision: z.string().min(1),
        profile_sha256: z.string().optional(),
        effective_sha256: z.string().optional(),
        speed_tier: z.string().optional(),
        contest_id: z.string().min(1),
        data_version: z.number().int().positive(),
        contest_sha256: z.string().optional(),
        protocol_preset: z.string().optional(),
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

interface RunQueryRow {
  run_id: string;
  agent_id: string;
  agent_revision: string;
  profile_sha256: string | null;
  effective_sha256: string | null;
  speed_tier: string | null;
  contest_id: string;
  data_version: number;
  contest_revision: string | null;
  contest_sha256: string | null;
  protocol_sha256: string | null;
  status: string;
  score: number | null;
  max_score: number | null;
  created_at: string | null;
}

function runMatchesCurrentRevision(
  r: RunQueryRow,
  agent: {
    agent_revision: string | null;
    equivalent_profile_hashes?: ReadonlySet<string>;
    effective_sha256: string | null;
    speed_tier: string | null;
  },
  contest: { contest_revision: string | null; contest_sha256: string | null; protocol_sha256: string | null },
): boolean {
  const validProfiles = agent.equivalent_profile_hashes;
  if (validProfiles && validProfiles.size > 0) {
    const runProfile = r.profile_sha256 ?? r.agent_revision;
    if (!validProfiles.has(runProfile)) return false;
  } else if (agent.agent_revision !== null) {
    if (r.profile_sha256 !== null) {
      if (r.profile_sha256 !== agent.agent_revision) return false;
    } else if (r.agent_revision !== agent.agent_revision) {
      return false;
    }
  }
  if (agent.effective_sha256 !== null) {
    if (r.effective_sha256 === null || r.effective_sha256 !== agent.effective_sha256) return false;
  }
  const expectedSpeedTier = agent.speed_tier || 'standard';
  if (r.speed_tier === null || r.speed_tier !== expectedSpeedTier) return false;
  if (contest.contest_revision !== null || contest.contest_sha256 !== null) {
    if (contest.contest_revision !== null && r.contest_revision !== null) {
      if (r.contest_revision !== contest.contest_revision) return false;
    } else if (contest.contest_sha256 !== null && r.contest_sha256 !== null) {
      if (r.contest_sha256 !== contest.contest_sha256) return false;
    } else {
      return false;
    }
  }
  if (contest.protocol_sha256 !== null) {
    if (r.protocol_sha256 === null || r.protocol_sha256 !== contest.protocol_sha256) return false;
  }
  return true;
}

export class WorkspaceIndex {
  readonly workspaceDir: string;
  readonly dbPath: string;
  private db!: DatabaseSync;
  private closed = false;

  constructor(workspaceDir: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.dbPath = join(this.workspaceDir, '.index.sqlite');
    this.ensureSafeWorkspaceDir();
    this.openAndInitWithRecovery();
  }

  private sqliteFiles(): string[] {
    return [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`, `${this.dbPath}-journal`];
  }

  private ensureSafeWorkspaceDir(): void {
    const parentDir = dirname(this.dbPath);
    let info;
    try {
      info = lstatSync(parentDir);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      info = lstatSync(parentDir);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Refusing to open symlinked or non-directory workspace root: ${parentDir}`);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`Refusing to open workspace root not owned by current user: ${parentDir}`);
    }
    if ((info.mode & 0o077) !== 0) {
      chmodSync(parentDir, 0o700);
    }
  }

  private assertSafeSqliteFiles(): void {
    for (const filePath of this.sqliteFiles()) {
      try {
        const info = lstatSync(filePath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error(`Refusing to open non-regular SQLite index path: ${filePath}`);
        }
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
  }

  private unlinkSafeSqliteFiles(): void {
    this.ensureSafeWorkspaceDir();
    for (const filePath of this.sqliteFiles()) {
      try {
        const info = lstatSync(filePath);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error(`Refusing to remove non-regular SQLite index path: ${filePath}`);
        }
        unlinkSync(filePath);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
  }

  private openAndInitOnce(): void {
    this.ensureSafeWorkspaceDir();
    this.assertSafeSqliteFiles();

    // Pre-create / verify dbPath with O_NOFOLLOW and fchmodSync(fd, 0o600) on the verified descriptor
    // BEFORE closing fd so there is zero pathname chmod race and dbPath is never world-readable.
    const fd = openSync(this.dbPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) {
        throw new Error(`Refusing to open non-regular SQLite index path: ${this.dbPath}`);
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid !== undefined && info.uid !== uid) {
        throw new Error(`Refusing to open SQLite index not owned by current user: ${this.dbPath}`);
      }
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }

    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.dbPath);
      this.db = db;
      this.hardenFileModes();
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
      `);
      this.initSchema();
      this.hardenFileModes();
    } catch (error) {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors during init failure.
        }
      }
      throw error;
    }
  }

  private openAndInitWithRecovery(): void {
    try {
      this.openAndInitOnce();
    } catch (error) {
      if (!isSqliteCorruptError(error)) throw error;
      this.unlinkSafeSqliteFiles();
      this.openAndInitOnce();
    }
  }

  private rebuildFromCorruption(): void {
    try {
      this.db.close();
    } catch {
      // Ignore close error on corrupt DB handle.
    }
    this.unlinkSafeSqliteFiles();
    this.openAndInitOnce();
  }

  private hardenFileModes(): void {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    for (const filePath of this.sqliteFiles()) {
      let fd: number | undefined;
      try {
        fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        if (!info.isFile()) {
          throw new Error(`Refusing to touch non-regular SQLite index path: ${filePath}`);
        }
        if (uid !== undefined && info.uid !== uid) {
          throw new Error(`Refusing to touch SQLite index path not owned by current user: ${filePath}`);
        }
        fchmodSync(fd, 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') continue;
        if (code === 'ELOOP') {
          throw new Error(`Refusing to touch non-regular SQLite index path: ${filePath}`);
        }
        throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
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
        agent_revision TEXT,
        effective_sha256 TEXT,
        planner_revision TEXT,
        provider_meta_hash TEXT,
        deps_json TEXT,
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
        attachment_count INTEGER NOT NULL DEFAULT 0,
        contest_revision TEXT,
        contest_sha256 TEXT,
        protocol_sha256 TEXT,
        deps_json TEXT,
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
        profile_sha256 TEXT,
        effective_sha256 TEXT,
        speed_tier TEXT,
        contest_id TEXT NOT NULL,
        data_version INTEGER NOT NULL,
        contest_revision TEXT,
        contest_sha256 TEXT,
        protocol_sha256 TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        score REAL,
        max_score REAL,
        created_at TEXT,
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_cell ON runs(agent_id, contest_id, data_version);
      CREATE INDEX IF NOT EXISTS idx_runs_contest ON runs(contest_id, data_version);
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
        size INTEGER NOT NULL,
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
        profile_sha256 TEXT,
        effective_sha256 TEXT,
        speed_tier TEXT,
        contest_id TEXT NOT NULL,
        data_version INTEGER NOT NULL,
        contest_sha256 TEXT,
        protocol_sha256 TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id, job_index)
      );
      CREATE INDEX IF NOT EXISTS idx_batch_runs_run_id ON batch_runs(run_id);

      CREATE TABLE IF NOT EXISTS run_file_state (
        run_id TEXT PRIMARY KEY,
        run_mtime_ms REAL,
        run_size INTEGER,
        events_mtime_ms REAL,
        events_size INTEGER,
        batch_mtime_ms REAL,
        batch_size INTEGER
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
    try {
      return await this.syncOnce(opts);
    } catch (error) {
      if (!isSqliteCorruptError(error)) throw error;
      this.rebuildFromCorruption();
      return await this.syncOnce(opts);
    }
  }

  private async syncOnce(opts: SyncOptions): Promise<SyncStats> {
    const rawBase = resolve(opts.base ?? process.cwd());
    const base = await realpath(rawBase).catch(() => rawBase);
    const root = resolve(opts.root ?? this.workspaceDir);
    const rootReal = await realpath(root).catch(() => root);
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

    const protectedDirs = await resolveProtectedDirs({
      baseReal: base,
      baseResolved: rawBase,
      root,
      store,
      credentialDirs: opts.credentialDirs,
    });
    await this.syncConfigs(base, root, rootReal, protectedDirs, store, nowIso, stats);
    await this.syncBatchesAndRuns(root, nowIso, stats);
    this.hardenFileModes();
    return stats;
  }

  private async syncConfigs(
    base: string,
    rawRoot: string,
    rootReal: string,
    protectedDirs: readonly string[],
    store: Connections,
    nowIso: string,
    stats: SyncStats,
  ): Promise<void> {
    // Metadata-only store.list(); never reads credential files or OS keyring.
    const providersList = await store.list().catch(() => [] as Connection[]);
    const providerById = new Map<string, Connection>(providersList.map(p => [p.id, p]));

    const cachedFiles = new Map<string, CachedFileState>();
    for (const row of this.db.prepare('SELECT path, kind, mtime_ms, size FROM scanned_files').all() as unknown as Array<{
      path: string;
      kind: string;
      mtime_ms: number;
      size: number;
    }>) {
      cachedFiles.set(row.path, { kind: row.kind, mtime_ms: row.mtime_ms, size: row.size });
    }

    const cachedAgents = new Map<
      string,
      { mtime_ms: number; size: number; provider: string | null; provider_meta_hash: string | null; deps_json: string | null; valid: number }
    >();
    for (const row of this.db
      .prepare('SELECT path, mtime_ms, size, provider, provider_meta_hash, deps_json, valid FROM agents')
      .all() as unknown as Array<{
      path: string;
      mtime_ms: number;
      size: number;
      provider: string | null;
      provider_meta_hash: string | null;
      deps_json: string | null;
      valid: number;
    }>) {
      cachedAgents.set(row.path, row);
    }

    const cachedContests = new Map<string, { mtime_ms: number; size: number; deps_json: string | null }>();
    for (const row of this.db
      .prepare('SELECT path, mtime_ms, size, deps_json FROM contests')
      .all() as unknown as Array<{
      path: string;
      mtime_ms: number;
      size: number;
      deps_json: string | null;
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
      agent_revision: string | null;
      effective_sha256: string | null;
      planner_revision: string | null;
      provider_meta_hash: string | null;
      deps_json: string;
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
      attachment_count: number;
      contest_revision: string | null;
      contest_sha256: string | null;
      protocol_sha256: string | null;
      deps_json: string;
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
        if (
          fullPath === rawRoot ||
          fullPath === rootReal ||
          protectedDirs.some(dir => fullPath === dir || fullPath.startsWith(dir + sep))
        ) {
          continue;
        }
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
          if (prev.kind === 'contest') {
            const cachedContest = cachedContests.get(relPath);
            if (cachedContest && (await depsUnchanged(base, cachedContest.deps_json))) {
              seenContestPaths.add(relPath);
              stats.contests_reused++;
              continue;
            }
          }
          if (prev.kind === 'agent') {
            const cachedAgent = cachedAgents.get(relPath);
            if (cachedAgent) {
              const expectedProviderHash =
                cachedAgent.provider === null ? null : providerMetaHash(providerById.get(cachedAgent.provider));
              const providerMatches = cachedAgent.provider_meta_hash === expectedProviderHash;
              if (providerMatches && (await depsUnchanged(base, cachedAgent.deps_json))) {
                seenAgentPaths.add(relPath);
                stats.agents_reused++;
                continue;
              }
            }
          }
        }

        if (size > MAX_CONFIG_BYTES || isForbiddenPublicFilename(fullPath)) {
          scannedUpserts.push({ path: relPath, kind: 'other', mtime_ms: mtimeMs, size });
          continue;
        }

        let raw: Record<string, unknown>;
        try {
          const { bytes } = await readConfinedRegularFile(base, fullPath, ['file'], MAX_CONFIG_BYTES);
          raw = record(parseDocumentText(bytes.toString('utf8'), documentFormat(fullPath)));
        } catch {
          scannedUpserts.push({ path: relPath, kind: 'other', mtime_ms: mtimeMs, size });
          continue;
        }

        const isAgent =
          !('run_id' in raw) &&
          !('accepted_answers' in raw) &&
          !('contest_id' in raw) &&
          (raw.kind === agentKind || 'agent_id' in raw || ('harness' in raw && 'model' in raw));
        const isContest = !isAgent && !('run_id' in raw) && !('accepted_answers' in raw) && 'contest_id' in raw;

        if (isAgent) {
          seenAgentPaths.add(relPath);
          const depPaths = collectAgentDepPaths(fullPath, raw);
          const depStats = await Promise.all(depPaths.map(p => statDep(base, p)));
          const loaded = await loadVerifiedAgentFromDoc({
            base,
            agentAbsPath: fullPath,
            relPath,
            rawDoc: raw,
            store,
            protectedDirs,
          }).then(
            value => ({ value }),
            error => ({ error }),
          );
          const harnessObj = record(raw.harness);
          const provider =
            textVal(raw.provider) ?? textVal(raw.connection) ?? ('value' in loaded ? loaded.value.connectionId : undefined);
          const id =
            textVal(raw.id) ??
            textVal(raw.agent_id) ??
            ('value' in loaded ? loaded.value.profile.id : name);
          const displayName =
            ('value' in loaded ? loaded.value.agentName : undefined) ?? (textVal(raw.name)?.trim() || undefined);
          const rawTier = speedTierSchema.safeParse(raw.speed_tier);
          const speedTier =
            'value' in loaded ? loaded.value.speedTier : rawTier.success ? rawTier.data : undefined;
          const issues = 'error' in loaded ? [errMsg(loaded.error)] : [];
          const pHash = provider !== undefined ? providerMetaHash(providerById.get(provider)) : null;

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
            agent_revision: 'value' in loaded ? loaded.value.profileDigest : null,
            effective_sha256: 'value' in loaded ? loaded.value.effectiveDigest : null,
            planner_revision:
              'value' in loaded
                ? revisionFor(
                    loaded.value.profile,
                    loaded.value.effectiveDigest,
                    PLANNER_PLACEHOLDER_IMAGE,
                    protocolDigest,
                  )
                : null,
            provider_meta_hash: pHash,
            deps_json: JSON.stringify(depStats),
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
          const { allPaths } = collectContestDepPaths(fullPath, raw);
          const depStats = await Promise.all(allPaths.map(p => statDep(base, p)));
          const loaded = await loadVerifiedContestFromDoc({
            base,
            contestAbsPath: fullPath,
            relPath,
            rawDoc: raw,
            protectedDirs,
          }).then(
            value => ({ value }),
            error => ({ error }),
          );
          const judgeObj = record(raw.judge);
          const rulesObj = record(raw.rules);
          const materialsObj = record(raw.materials);
          const issues = 'error' in loaded ? [errMsg(loaded.error)] : [];
          const protocolSha =
            'value' in loaded
              ? protocolDigestForPreset(resolveProtocolPreset(loaded.value.contest.rules))
              : null;
          contestUpserts.push({
            path: relPath,
            id: textVal(raw.contest_id) ?? name,
            title: textVal(raw.title) ?? textVal(raw.contest_id) ?? name,
            data_version: typeof raw.data_version === 'number' && Number.isInteger(raw.data_version) ? raw.data_version : 1,
            judge_kind:
              'value' in loaded ? loaded.value.contest.judge.kind : textVal(judgeObj.kind) ?? 'unknown',
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
            attachment_count:
              'value' in loaded
                ? loaded.value.contest.materials.attachments.length
                : Array.isArray(materialsObj.attachments)
                  ? materialsObj.attachments.length
                  : 0,
            contest_revision: 'value' in loaded ? loaded.value.contestRevision : null,
            contest_sha256: 'value' in loaded ? loaded.value.contestDigest : null,
            protocol_sha256: protocolSha,
            deps_json: JSON.stringify(depStats),
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
          path, id, name, model, vendor, harness, provider, speed_tier,
          agent_revision, effective_sha256, planner_revision, provider_meta_hash, deps_json,
          valid, issues_json, mtime_ms, size, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          a.agent_revision,
          a.effective_sha256,
          a.planner_revision,
          a.provider_meta_hash,
          a.deps_json,
          a.valid,
          a.issues_json,
          a.mtime_ms,
          a.size,
          a.indexed_at,
        );
      }

      const upsertContest = this.db.prepare(`
        INSERT OR REPLACE INTO contests (
          path, id, title, data_version, judge_kind, problem_count, time_limit_ms,
          attachment_count, contest_revision, contest_sha256, protocol_sha256, deps_json,
          valid, issues_json, mtime_ms, size, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          c.attachment_count,
          c.contest_revision,
          c.contest_sha256,
          c.protocol_sha256,
          c.deps_json,
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
    const cachedBatches = new Map<string, { mtime_ms: number; size: number }>();
    for (const row of this.db.prepare('SELECT batch_id, mtime_ms, size FROM batches').all() as unknown as Array<{
      batch_id: string;
      mtime_ms: number;
      size: number;
    }>) {
      cachedBatches.set(row.batch_id, { mtime_ms: row.mtime_ms, size: row.size });
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
      size: number;
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

      const prevBatch = cachedBatches.get(batchId);
      if (prevBatch !== undefined && prevBatch.mtime_ms === info.mtimeMs && prevBatch.size === info.size) {
        seenBatchIds.add(batchId);
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
            const presetName = planJob.protocol_preset;
            const jobProtocolSha =
              presetName === 'short' || presetName === 'cf-2h' || presetName === 'icpc-5h'
                ? protocolDigestForPreset(presetName)
                : batch.plan.protocol_sha256 ?? null;
            batchRuns.push({
              batch_id: batchId,
              job_index: i,
              run_id: job.run_id ?? null,
              status: job.status,
              reason: job.reason ?? null,
              agent_id: planJob.agent_id,
              agent_name: planJob.agent_name ?? null,
              agent_revision: planJob.agent_revision,
              profile_sha256: planJob.profile_sha256 ?? null,
              effective_sha256: planJob.effective_sha256 ?? null,
              speed_tier: planJob.speed_tier ?? null,
              contest_id: planJob.contest_id,
              data_version: planJob.data_version,
              contest_sha256: planJob.contest_sha256 ?? null,
              protocol_sha256: jobProtocolSha,
              created_at: batch.created_at,
            });
          }
        }
        // Only mark batch as seen AFTER successful parsing.
        seenBatchIds.add(batchId);
        batchUpserts.push({
          batch_id: batchId,
          created_at: batch.created_at,
          job_count: batch.jobs.length,
          completed_count: completed,
          void_count: voidCount,
          queued_count: queued,
          running_count: running,
          mtime_ms: info.mtimeMs,
          size: info.size,
          indexed_at: nowIso,
          runs: batchRuns,
        });
        stats.batches_indexed++;
      } catch {
        // Corrupt or invalidated batch file: intentionally NOT added to seenBatchIds so stale rows are pruned.
      }
    }

    // Apply batch updates and pruning first so batch_runs reflects current batches.
    this.withTransaction(() => {
      const upsertBatch = this.db.prepare(`
        INSERT OR REPLACE INTO batches (
          batch_id, created_at, job_count, completed_count, void_count, queued_count, running_count, mtime_ms, size, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const delBatchRuns = this.db.prepare('DELETE FROM batch_runs WHERE batch_id = ?');
      const insBatchRun = this.db.prepare(`
        INSERT INTO batch_runs (
          batch_id, job_index, run_id, status, reason, agent_id, agent_name, agent_revision,
          profile_sha256, effective_sha256, speed_tier, contest_id, data_version, contest_sha256, protocol_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          b.size,
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
            br.profile_sha256,
            br.effective_sha256,
            br.speed_tier,
            br.contest_id,
            br.data_version,
            br.contest_sha256,
            br.protocol_sha256,
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

    // Build run_id -> batch run metadata map (plus batch mtime & size).
    const batchFileInfo = new Map<string, { mtime_ms: number; size: number }>();
    for (const row of this.db.prepare('SELECT batch_id, mtime_ms, size FROM batches').all() as unknown as Array<{
      batch_id: string;
      mtime_ms: number;
      size: number;
    }>) {
      batchFileInfo.set(row.batch_id, { mtime_ms: row.mtime_ms, size: row.size });
    }

    const batchRunByRunId = new Map<string, BatchRunRow & { batch_mtime_ms: number; batch_size: number }>();
    for (const row of this.db
      .prepare('SELECT * FROM batch_runs WHERE run_id IS NOT NULL')
      .all() as unknown as BatchRunRow[]) {
      if (row.run_id) {
        const bf = batchFileInfo.get(row.batch_id);
        batchRunByRunId.set(row.run_id, {
          ...row,
          batch_mtime_ms: bf?.mtime_ms ?? 0,
          batch_size: bf?.size ?? 0,
        });
      }
    }

    const cachedRunStates = new Map<
      string,
      {
        run_mtime_ms: number | null;
        run_size: number | null;
        events_mtime_ms: number | null;
        events_size: number | null;
        batch_mtime_ms: number | null;
        batch_size: number | null;
      }
    >();
    for (const row of this.db.prepare('SELECT * FROM run_file_state').all() as unknown as Array<{
      run_id: string;
      run_mtime_ms: number | null;
      run_size: number | null;
      events_mtime_ms: number | null;
      events_size: number | null;
      batch_mtime_ms: number | null;
      batch_size: number | null;
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
      profile_sha256: string | null;
      effective_sha256: string | null;
      speed_tier: string | null;
      contest_id: string;
      data_version: number;
      contest_revision: string | null;
      contest_sha256: string | null;
      protocol_sha256: string | null;
      status: string;
      reason: string | null;
      score: number | null;
      max_score: number | null;
      created_at: string | null;
      indexed_at: string;
      state: {
        run_mtime_ms: number | null;
        run_size: number | null;
        events_mtime_ms: number | null;
        events_size: number | null;
        batch_mtime_ms: number | null;
        batch_size: number | null;
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
      const batchSize = batchInfo ? batchInfo.batch_size : null;

      const prevState = cachedRunStates.get(name);
      if (
        prevState &&
        existingRunIds.has(name) &&
        prevState.run_mtime_ms === runStat.mtimeMs &&
        prevState.run_size === runStat.size &&
        prevState.events_mtime_ms === (eventsStat?.mtimeMs ?? null) &&
        prevState.events_size === (eventsStat?.size ?? null) &&
        prevState.batch_mtime_ms === batchMtime &&
        prevState.batch_size === batchSize
      ) {
        seenRunIds.add(name);
        stats.runs_reused++;
        continue;
      }

      try {
        const metaBytes = await readBoundedNoFollow(runJsonPath, MAX_CONFIG_BYTES);
        const meta = record(JSON.parse(metaBytes.toString('utf8')));
        const runId = textVal(meta.run_id) ?? name;
        if (runId !== name) continue;

        const modelObj = record(meta.model);
        const agentDigestsObj = record(meta.agent_digests);
        const inputShaObj = record(meta.input_sha256);
        const agentId = textVal(meta.agent_id) ?? batchInfo?.agent_id;
        const contestId = textVal(meta.contest_id) ?? batchInfo?.contest_id;
        const agentRevision = textVal(meta.agent_revision) ?? batchInfo?.agent_revision;
        const dataVersion = numVal(meta.data_version) ?? batchInfo?.data_version ?? 1;
        if (!agentId || !contestId || !agentRevision) continue;

        let terminal: { status?: string; reason?: string; score?: number; max_score?: number } = {};
        if (eventsStat && eventsStat.size > 0) {
          try {
            const tailText = await readTailNoFollow(eventsPath, EVENTS_TAIL_BYTES);
            terminal = parseEventsTerminal(tailText);
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

        // Only mark run as seen AFTER successful parsing.
        seenRunIds.add(name);
        runUpserts.push({
          run_id: name,
          batch_id: batchInfo?.batch_id ?? null,
          agent_id: agentId,
          agent_name: textVal(meta.agent_name) ?? batchInfo?.agent_name ?? null,
          agent_revision: agentRevision,
          profile_sha256: textVal(agentDigestsObj.profile_sha256) ?? batchInfo?.profile_sha256 ?? null,
          effective_sha256: textVal(agentDigestsObj.effective_sha256) ?? batchInfo?.effective_sha256 ?? null,
          speed_tier: textVal(modelObj.speed_tier) ?? batchInfo?.speed_tier ?? null,
          contest_id: contestId,
          data_version: Math.trunc(dataVersion),
          contest_revision: textVal(meta.contest_revision) ?? null,
          contest_sha256: textVal(inputShaObj.contest) ?? batchInfo?.contest_sha256 ?? null,
          protocol_sha256: textVal(meta.protocol_sha256) ?? batchInfo?.protocol_sha256 ?? null,
          status,
          reason,
          score: terminal.score ?? null,
          max_score: terminal.max_score ?? null,
          created_at: createdAt,
          indexed_at: nowIso,
          state: {
            run_mtime_ms: runStat.mtimeMs,
            run_size: runStat.size,
            events_mtime_ms: eventsStat?.mtimeMs ?? null,
            events_size: eventsStat?.size ?? null,
            batch_mtime_ms: batchMtime,
            batch_size: batchSize,
          },
        });
        stats.runs_indexed++;
      } catch {
        // Malformed/invalidated run.json: intentionally NOT added to seenRunIds so stale rows are pruned.
      }
    }

    // Also include batch jobs with a run_id that don't have a valid run.json on disk.
    for (const [runId, br] of batchRunByRunId) {
      if (seenRunIds.has(runId)) continue;
      // If a run directory with a corrupt run.json exists on disk, do NOT resurrect it from batch state.
      let corruptRunOnDisk = false;
      try {
        const st = await lstat(join(root, runId, 'run.json'));
        if (st.isFile() || st.isSymbolicLink()) corruptRunOnDisk = true;
      } catch {
        // No run.json on disk.
      }
      if (corruptRunOnDisk) continue;

      seenRunIds.add(runId);
      const prevState = cachedRunStates.get(runId);
      if (
        prevState &&
        existingRunIds.has(runId) &&
        prevState.run_mtime_ms === null &&
        prevState.run_size === null &&
        prevState.events_mtime_ms === null &&
        prevState.events_size === null &&
        prevState.batch_mtime_ms === br.batch_mtime_ms &&
        prevState.batch_size === br.batch_size
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
        profile_sha256: br.profile_sha256,
        effective_sha256: br.effective_sha256,
        speed_tier: br.speed_tier,
        contest_id: br.contest_id,
        data_version: br.data_version,
        contest_revision: null,
        contest_sha256: br.contest_sha256,
        protocol_sha256: br.protocol_sha256,
        status: br.status,
        reason: br.reason,
        score: null,
        max_score: null,
        created_at: br.created_at,
        indexed_at: nowIso,
        state: {
          run_mtime_ms: null,
          run_size: null,
          events_mtime_ms: null,
          events_size: null,
          batch_mtime_ms: br.batch_mtime_ms,
          batch_size: br.batch_size,
        },
      });
      stats.runs_indexed++;
    }

    this.withTransaction(() => {
      const upsertRun = this.db.prepare(`
        INSERT OR REPLACE INTO runs (
          run_id, batch_id, agent_id, agent_name, agent_revision, profile_sha256, effective_sha256,
          speed_tier, contest_id, data_version, contest_revision, contest_sha256, protocol_sha256,
          status, reason, score, max_score, created_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const upsertState = this.db.prepare(`
        INSERT OR REPLACE INTO run_file_state (
          run_id, run_mtime_ms, run_size, events_mtime_ms, events_size, batch_mtime_ms, batch_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const r of runUpserts) {
        upsertRun.run(
          r.run_id,
          r.batch_id,
          r.agent_id,
          r.agent_name,
          r.agent_revision,
          r.profile_sha256,
          r.effective_sha256,
          r.speed_tier,
          r.contest_id,
          r.data_version,
          r.contest_revision,
          r.contest_sha256,
          r.protocol_sha256,
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
          r.state.run_size,
          r.state.events_mtime_ms,
          r.state.events_size,
          r.state.batch_mtime_ms,
          r.state.batch_size,
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
        ...(row.agent_revision !== null ? { agent_revision: row.agent_revision } : {}),
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
        ...(row.contest_revision !== null ? { contest_revision: row.contest_revision } : {}),
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
        `SELECT path, id, name, harness, speed_tier, agent_revision, effective_sha256, planner_revision, valid FROM agents ${agentWhere.length ? `WHERE ${agentWhere.join(' AND ')}` : ''} ORDER BY id ASC, valid DESC, path ASC`,
      )
      .all(...agentParams) as unknown as Array<{
      path: string;
      id: string;
      name: string | null;
      harness: string;
      speed_tier: string | null;
      agent_revision: string | null;
      effective_sha256: string | null;
      planner_revision: string | null;
      valid: number;
    }>;

    const contestWhere: string[] = [];
    const contestParams: SQLInputValue[] = [];
    if (!includeInvalid) contestWhere.push('valid = 1');
    if (opts.contestIds?.length) {
      contestWhere.push(`id IN (${opts.contestIds.map(() => '?').join(', ')})`);
      contestParams.push(...opts.contestIds);
    }
    const contestRows = this.db
      .prepare(
        `SELECT path, id, title, data_version, judge_kind, attachment_count, contest_revision, contest_sha256, protocol_sha256, valid FROM contests ${contestWhere.length ? `WHERE ${contestWhere.join(' AND ')}` : ''} ORDER BY id ASC, data_version DESC, valid DESC, path ASC`,
      )
      .all(...contestParams) as unknown as Array<{
      path: string;
      id: string;
      title: string;
      data_version: number;
      judge_kind: string;
      attachment_count: number;
      contest_revision: string | null;
      contest_sha256: string | null;
      protocol_sha256: string | null;
      valid: number;
    }>;

    if (!agentRows.length || !contestRows.length) return [];

    // Filter runs by opts.agentIds / opts.contestIds so SQLite indexes are utilized.
    const runWhere: string[] = [];
    const runParams: SQLInputValue[] = [];
    if (opts.agentIds?.length) {
      runWhere.push(`agent_id IN (${opts.agentIds.map(() => '?').join(', ')})`);
      runParams.push(...opts.agentIds);
    }
    if (opts.contestIds?.length) {
      runWhere.push(`contest_id IN (${opts.contestIds.map(() => '?').join(', ')})`);
      runParams.push(...opts.contestIds);
    }

    const runRows = this.db
      .prepare(`
        SELECT
          run_id,
          agent_id,
          agent_revision,
          profile_sha256,
          effective_sha256,
          speed_tier,
          contest_id,
          data_version,
          contest_revision,
          contest_sha256,
          protocol_sha256,
          status,
          score,
          max_score,
          created_at
        FROM runs
        ${runWhere.length ? `WHERE ${runWhere.join(' AND ')}` : ''}
        ORDER BY COALESCE(created_at, '') DESC, rowid DESC
      `)
      .all(...runParams) as unknown as RunQueryRow[];

    // Index runs by (agent_id, contest_id, data_version) in newest-first order.
    const runsByCellKey = new Map<string, RunQueryRow[]>();
    for (const r of runRows) {
      const key = `${r.agent_id}\0${r.contest_id}\0${r.data_version}`;
      let list = runsByCellKey.get(key);
      if (!list) {
        list = [];
        runsByCellKey.set(key, list);
      }
      list.push(r);
    }

    // Collapse duplicate paths that resolve to the EXACT same planner revision identity (so toBatchSpec
    // never emits duplicate revisions rejected by makePlan), while preserving distinct valid revisions sharing an ID
    // AND crediting runs executed through ANY equivalent profile hash inside the collapsed group!
    type GroupedAgent = (typeof agentRows)[number] & { equivalent_profile_hashes: Set<string> };
    const uniqueAgents: GroupedAgent[] = [];
    const groupedAgentsByRev = new Map<string, GroupedAgent>();
    for (const a of agentRows) {
      const revKey =
        a.valid === 1 && a.planner_revision !== null
          ? JSON.stringify([a.id, a.planner_revision, a.speed_tier ?? 'standard'])
          : `path:${a.path}`;
      const existing = groupedAgentsByRev.get(revKey);
      if (existing) {
        if (a.agent_revision !== null) existing.equivalent_profile_hashes.add(a.agent_revision);
        continue;
      }
      const grouped: GroupedAgent = {
        ...a,
        equivalent_profile_hashes: new Set(a.agent_revision !== null ? [a.agent_revision] : []),
      };
      groupedAgentsByRev.set(revKey, grouped);
      uniqueAgents.push(grouped);
    }

    const uniqueContests: typeof contestRows = [];
    const seenContestRevs = new Set<string>();
    for (const c of contestRows) {
      const revKey =
        c.valid === 1 && c.contest_sha256 !== null
          ? JSON.stringify([c.id, c.data_version, c.contest_sha256])
          : `path:${c.path}`;
      if (seenContestRevs.has(revKey)) continue;
      seenContestRevs.add(revKey);
      uniqueContests.push(c);
    }

    const cells: CoverageCell[] = [];
    for (const a of uniqueAgents) {
      for (const c of uniqueContests) {
        const key = `${a.id}\0${c.id}\0${c.data_version}`;
        const cellRuns = runsByCellKey.get(key) ?? [];
        let completedCount = 0;
        let voidCount = 0;
        let runningCount = 0;
        let totalRuns = 0;
        let historicalCompletedCount = 0;
        let historicalTotalRuns = 0;
        let latestStatus: string | null = null;
        let latestRunId: string | undefined;
        let bestScore: number | undefined;
        let maxScore: number | undefined;

        for (const r of cellRuns) {
          historicalTotalRuns++;
          if (r.status === 'completed') historicalCompletedCount++;

          if (!runMatchesCurrentRevision(r, a, c)) continue;

          if (latestStatus === null) {
            latestStatus = r.status;
            latestRunId = r.run_id;
          }
          totalRuns++;
          if (r.status === 'completed') {
            completedCount++;
            if (r.score !== null && (bestScore === undefined || r.score > bestScore)) {
              bestScore = r.score;
              if (r.max_score !== null) maxScore = r.max_score;
            }
          } else if (r.status === 'void') {
            voidCount++;
          } else if (r.status === 'running') {
            runningCount++;
          }
          if (maxScore === undefined && r.max_score !== null) {
            maxScore = r.max_score;
          }
        }

        const compat = cellCompatibility(a.harness, c.judge_kind, c.attachment_count, a.id, c.id);

        cells.push({
          agent_id: a.id,
          ...(a.name !== null ? { agent_name: a.name } : {}),
          agent_path: a.path,
          ...(a.agent_revision !== null ? { agent_revision: a.agent_revision } : {}),
          contest_id: c.id,
          contest_title: c.title,
          contest_path: c.path,
          ...(c.contest_revision !== null ? { contest_revision: c.contest_revision } : {}),
          data_version: c.data_version,
          compatible: compat.compatible,
          ...(compat.reason ? { incompatible_reason: compat.reason } : {}),
          completed_count: completedCount,
          void_count: voidCount,
          running_count: runningCount,
          total_runs: totalRuns,
          historical_completed_count: historicalCompletedCount,
          historical_total_runs: historicalTotalRuns,
          latest_status: latestStatus,
          ...(latestRunId !== undefined ? { latest_run_id: latestRunId } : {}),
          ...(bestScore !== undefined ? { best_score: bestScore } : {}),
          ...(maxScore !== undefined ? { max_score: maxScore } : {}),
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
    let incompatibleSkipped = 0;

    for (const cell of coverage) {
      if (!cell.compatible) {
        incompatibleSkipped++;
        continue;
      }
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
      } else if (
        cell.completed_count === 0 &&
        cell.running_count === 0 &&
        cell.void_count > 0 &&
        cell.void_count === cell.total_runs
      ) {
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
      } else if (cell.completed_count === 0 && cell.running_count > 0) {
        gaps.push({
          agent: cell.agent_path,
          contest: cell.contest_path,
          agent_id: cell.agent_id,
          contest_id: cell.contest_id,
          data_version: cell.data_version,
          missing_repeats: minRepeats,
          reason: 'running',
          running_count: cell.running_count,
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
          ...(cell.running_count > 0 ? { running_count: cell.running_count } : {}),
        });
      }
    }

    const wavesRequired = gaps.length === 0 ? 0 : Math.max(...gaps.map(g => g.missing_repeats));
    return {
      cells: gaps.slice(0, maxCells),
      total_gaps: gaps.length,
      waves_required: wavesRequired,
      truncated: gaps.length > maxCells,
      incompatible_skipped: incompatibleSkipped,
    };
  }

  toBatchSpec(gaps: UncoveredResult | readonly Pick<UncoveredCell, 'agent' | 'contest'>[]): BatchSpecV2 | null {
    return toBatchSpec(gaps);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
