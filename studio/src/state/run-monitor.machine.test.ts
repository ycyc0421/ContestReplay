import type { RunProgressContract } from '@studio-api';
import { deriveRunAuthority } from './run-monitor.machine';

const makeProgress = (status: RunProgressContract['status']): RunProgressContract => ({
  run_id: '11111111-1111-4111-8111-111111111111',
  status,
  agent_id: 'a',
  contest_id: 'c',
  data_version: 1,
  elapsed_ms: 1000,
  time_limit_ms: 60_000,
  remaining_ms: 59_000,
  submissions_used: 0,
  max_submissions: 100,
  model_turns: 1,
  last_activity_ms: 1000,
  score: 0,
  max_score: 1,
  solved_count: 0,
  problem_count: 1,
  problems: [],
  recent_activity: [],
  telemetry: { model_turns: 1, total_model_wait_ms: 0, total_input_tokens: 0, total_output_tokens: 0 },
});

describe('deriveRunAuthority', () => {
  it('prefers terminal SSE queue status even when batch and progress GET still say running', () => {
    const auth = deriveRunAuthority({
      terminalStatus: { status: 'interrupted', reason: 'cancelled' },
      progress: makeProgress('running'),
      batchJobStatus: 'running',
    });
    expect(auth).toEqual({ running: false, displayStatus: 'interrupted', displayReason: 'cancelled' });
  });

  it('prefers terminal SSE progress completed over stale nonterminal batch running status', () => {
    const auth = deriveRunAuthority({
      progress: makeProgress('completed'),
      batchJobStatus: 'running',
    });
    expect(auth).toEqual({ running: false, displayStatus: 'completed', displayReason: undefined });
  });

  it('keeps run active only while no source has reported a terminal state', () => {
    const auth = deriveRunAuthority({
      progress: makeProgress('running'),
      batchJobStatus: 'running',
    });
    expect(auth).toEqual({ running: true, displayStatus: 'running', displayReason: undefined });
  });
});
