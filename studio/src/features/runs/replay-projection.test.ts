import type { RunReplayContract } from '@studio-api';
import { projectReplayAt } from './replay-projection';

const digest = 'a'.repeat(64);
function makeReplay(overrides: Partial<RunReplayContract>): RunReplayContract {
  return {
    run_id: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    agent_id: 'agent-a',
    contest_id: 'demo',
    data_version: 1,
    contest_revision: digest,
    protocol_id: 'short',
    protocol_version: 1,
    protocol_sha256: digest,
    scoring_mode: 'icpc',
    time_limit_ms: 7_200_000,
    duration_ms: 300_000,
    problems: [{ id: 'A', max_points: 500 }, { id: 'B', max_points: 1000 }],
    submissions: [],
    frames: [],
    telemetry: { model_turns: 1, total_model_wait_ms: 1000, total_input_tokens: 10, total_output_tokens: 10 },
    ...overrides,
  };
}

describe('projectReplayAt', () => {
  it('keeps an accepted problem accepted across pending and already_accepted retries and dates first AC by receipt', () => {
    const replay = makeReplay({
      scoring_mode: 'icpc',
      submissions: [
        { submission_id: 's1', problem_id: 'A', received_ms: 50_000, judged_ms: 70_000, verdict: 'AC', score: 500, max_points: 500 },
        { submission_id: 's2', problem_id: 'A', received_ms: 90_000, judged_ms: 120_000, verdict: 'already_accepted', score: 0, max_points: 500 },
      ],
    });

    // Received at 50s, not yet judged at 60s -> pending
    const at60 = projectReplayAt(replay, 60_000);
    expect(at60.solved_count).toBe(0);
    expect(at60.score).toBe(0);
    expect(at60.problems[0]).toMatchObject({ id: 'A', status: 'pending', attempts: 1, score: 0, max_points: 1 });

    // Judged at 70s -> accepted with ICPC score 1/1 and first_ac_ms at receipt (50s), not judged (70s)
    const at75 = projectReplayAt(replay, 75_000);
    expect(at75.solved_count).toBe(1);
    expect(at75.score).toBe(1);
    expect(at75.problems[0]).toMatchObject({ id: 'A', status: 'accepted', score: 1, max_points: 1, first_ac_ms: 50_000 });

    // Retry pending at 100s -> must NOT regress to pending
    const at100 = projectReplayAt(replay, 100_000);
    expect(at100.solved_count).toBe(1);
    expect(at100.problems[0]).toMatchObject({ id: 'A', status: 'accepted', attempts: 2, score: 1, first_ac_ms: 50_000 });

    // Retry judged already_accepted at 130s -> must NOT regress to wrong
    const at130 = projectReplayAt(replay, 130_000);
    expect(at130.solved_count).toBe(1);
    expect(at130.problems[0]).toMatchObject({ id: 'A', status: 'accepted', attempts: 2, wrong_attempts: 0, score: 1, first_ac_ms: 50_000 });
  });

  it('applies CF decay and wrong penalty rules while ignoring CE no-penalty verdicts', () => {
    const replay = makeReplay({
      scoring_mode: 'cf',
      time_limit_ms: 100_000,
      problems: [{ id: 'A', max_points: 1000 }],
      submissions: [
        { submission_id: 's1', problem_id: 'A', received_ms: 10_000, judged_ms: 12_000, verdict: 'CE', score: 0, max_points: 1000 },
        { submission_id: 's2', problem_id: 'A', received_ms: 20_000, judged_ms: 25_000, verdict: 'WA', score: 0, max_points: 1000 },
        { submission_id: 's3', problem_id: 'A', received_ms: 50_000, judged_ms: 55_000, verdict: 'AC', score: 1000, max_points: 1000 },
      ],
    });
    const at60 = projectReplayAt(replay, 60_000);
    // 1000 * (1 - 0.5 * 0.5) - 50 * 1 = 750 - 50 = 700
    expect(at60.score).toBe(700);
    expect(at60.problems[0]).toMatchObject({ status: 'accepted', wrong_attempts: 1, score: 700, first_ac_ms: 50_000 });
  });

  it('applies IOI partial scoring and refuses to mark explicit wrong verdict as solved', () => {
    const replay = makeReplay({
      scoring_mode: 'ioi',
      problems: [{ id: 'A', max_points: 100 }],
      submissions: [
        { submission_id: 's1', problem_id: 'A', received_ms: 10_000, judged_ms: 15_000, verdict: 'WA', score: 40, max_points: 100 },
        { submission_id: 's2', problem_id: 'A', received_ms: 20_000, judged_ms: 25_000, verdict: 'WA', score: 100, max_points: 100 },
      ],
    });
    const at30 = projectReplayAt(replay, 30_000);
    expect(at30.solved_count).toBe(0);
    expect(at30.score).toBe(100);
    expect(at30.problems[0]).toMatchObject({ status: 'partial', score: 100 });
  });
});
