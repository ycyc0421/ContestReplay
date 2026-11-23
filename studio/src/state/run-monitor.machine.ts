import type { RunProgressContract, RunStatus } from '@studio-api';

export type ProgressConnection = 'connecting' | 'live' | 'polling' | 'closed';

export interface TerminalQueueStatus {
  status: RunStatus;
  reason?: string;
}

export interface RunAuthority {
  running: boolean;
  displayStatus?: RunStatus;
  displayReason?: string;
}

export const isTerminalProgress = (progress?: RunProgressContract): boolean =>
  progress?.status === 'completed' || progress?.status === 'void';

/**
 * Resolves authoritative run status from SSE queue status, SSE/GET progress snapshot, and batch job state.
 * Precedence: sse_status_terminal > progress_terminal > batch_terminal > active_batch > progress_status.
 */
export function deriveRunAuthority(input: {
  terminalStatus?: TerminalQueueStatus;
  progress?: RunProgressContract;
  batchJobStatus?: RunStatus;
  batchJobReason?: string;
}): RunAuthority {
  const { terminalStatus, progress, batchJobStatus, batchJobReason } = input;
  const progressTerminal: RunStatus | undefined =
    progress?.status === 'completed' || progress?.status === 'void' ? progress.status : undefined;
  const batchTerminal: RunStatus | undefined =
    batchJobStatus && batchJobStatus !== 'running' && batchJobStatus !== 'queued' ? batchJobStatus : undefined;

  const isTerminal = Boolean(terminalStatus || progressTerminal || batchTerminal);
  const running = !isTerminal && (batchJobStatus === 'running' || progress?.status === 'running');
  const displayStatus: RunStatus | undefined =
    terminalStatus?.status ??
    progressTerminal ??
    batchTerminal ??
    batchJobStatus ??
    (progress?.status === 'unknown' ? undefined : progress?.status);
  const displayReason = batchJobReason ?? terminalStatus?.reason ?? progress?.reason;

  return { running, displayStatus, displayReason };
}
