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
 * Resolves authoritative run status AND matching reason from the SAME winning source:
 * Precedence: sse_status_terminal > progress_terminal > batch_terminal > active_batch > progress_status.
 * Falls back to another source's reason ONLY when that source agrees on the winning status.
 */
export function deriveRunAuthority(input: {
  terminalStatus?: TerminalQueueStatus;
  progress?: RunProgressContract;
  batchJobStatus?: RunStatus;
  batchJobReason?: string;
}): RunAuthority {
  const { terminalStatus, progress, batchJobStatus, batchJobReason } = input;
  const progressStatus: RunStatus | undefined =
    progress && progress.status !== 'unknown' ? progress.status : undefined;
  const progressTerminal: RunStatus | undefined =
    progress?.status === 'completed' || progress?.status === 'void' ? progress.status : undefined;
  const batchTerminal: RunStatus | undefined =
    batchJobStatus && batchJobStatus !== 'running' && batchJobStatus !== 'queued' ? batchJobStatus : undefined;

  const isTerminal = Boolean(terminalStatus || progressTerminal || batchTerminal);
  const running = !isTerminal && (batchJobStatus === 'running' || progress?.status === 'running');

  if (terminalStatus) {
    const status = terminalStatus.status;
    const reason =
      terminalStatus.reason ??
      (batchJobStatus === status ? batchJobReason : undefined) ??
      (progressStatus === status ? progress?.reason : undefined);
    return { running: false, displayStatus: status, displayReason: reason };
  }

  if (progressTerminal) {
    const status = progressTerminal;
    const reason =
      progress?.reason ??
      (batchJobStatus === status ? batchJobReason : undefined);
    return { running: false, displayStatus: status, displayReason: reason };
  }

  if (batchTerminal) {
    const status = batchTerminal;
    const reason =
      batchJobReason ??
      (progressStatus === status ? progress?.reason : undefined);
    return { running: false, displayStatus: status, displayReason: reason };
  }

  if (batchJobStatus) {
    return {
      running,
      displayStatus: batchJobStatus,
      displayReason: batchJobReason ?? (progressStatus === batchJobStatus ? progress?.reason : undefined),
    };
  }

  return {
    running,
    displayStatus: progressStatus,
    displayReason: progress?.reason,
  };
}
