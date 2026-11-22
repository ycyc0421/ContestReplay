import { act, fireEvent, render, screen } from '@testing-library/react';
import type { GhostRaceContract } from '@studio-api';
import { GhostRace } from './ghost-race';

const digest = 'a'.repeat(64);
const runA = '11111111-1111-4111-8111-111111111111';
const race: GhostRaceContract = {
  contest_id: 'demo',
  contest_title: 'Demo Final',
  data_version: 1,
  contest_revision: digest,
  protocol_id: 'short',
  protocol_version: 1,
  protocol_sha256: digest,
  time_limit_ms: 120_000,
  timeline_end_ms: 120_000,
  scoring_mode: 'icpc',
  problems: [{ id: 'A', max_points: 1 }],
  participants: [{
    run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A', status: 'completed',
    time_limit_ms: 120_000, duration_ms: 120_000, final_score: 1, final_solved_count: 1, final_penalty: 0, submissions: [],
  }],
  milestones: [{
    elapsed_ms: 12_000, run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A',
    seq: 1, kind: 'submission_judged', problem_id: 'A', verdict: 'AC', score: 1, summary: 'Agent A solved A at 12s',
  }],
  samples: [
    {
      at_elapsed_ms: 0,
      scoring_mode: 'icpc',
      standings: [{
        rank: 1, status: 'completed', provisional: false, unranked: false, run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A',
        score: 0, max_score: 1, solved_count: 0, penalty: 0, penalty_ms: 0, last_ac_ms: 0, submissions_used: 0, finished: false,
        problems: [{ id: 'A', status: 'unattempted', attempts: 0, wrong_attempts: 0, score: 0, max_points: 1 }],
      }],
    },
    {
      at_elapsed_ms: 60_000,
      scoring_mode: 'icpc',
      standings: [{
        rank: 1, status: 'completed', provisional: false, unranked: false, run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A',
        score: 1, max_score: 1, solved_count: 1, penalty: 0, penalty_ms: 12_000, last_ac_ms: 12_000, submissions_used: 1, finished: false,
        problems: [{ id: 'A', status: 'accepted', attempts: 1, wrong_attempts: 0, score: 1, max_points: 1, first_ac_ms: 12_000 }],
      }],
    },
    {
      at_elapsed_ms: 120_000,
      scoring_mode: 'icpc',
      standings: [{
        rank: 1, status: 'completed', provisional: false, unranked: false, run_id: runA, agent_id: 'agent-a', agent_name: 'Agent A',
        score: 1, max_score: 1, solved_count: 1, penalty: 0, penalty_ms: 12_000, last_ac_ms: 12_000, submissions_used: 1, finished: true,
        problems: [{ id: 'A', status: 'accepted', attempts: 1, wrong_attempts: 0, score: 1, max_points: 1, first_ac_ms: 12_000 }],
      }],
    },
  ],
};

describe('GhostRace', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps milestones and standings on one sample clock and advances smoothly during playback', () => {
    vi.useFakeTimers();
    render(<GhostRace race={race} />);

    // At sample 0 (00:00), the 12s milestone must NOT appear while standings still show 0 / 1.
    expect(screen.queryByText('Agent A solved A at 12s')).not.toBeInTheDocument();
    expect(screen.getByText('0 / 1')).toBeInTheDocument();

    // Start playback at default 16x (4s contest time per 250ms tick): after 1s (16s elapsed), still at 00:00 sample -> no contradiction.
    fireEvent.click(screen.getByRole('button', { name: '开始竞速' }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Agent A solved A at 12s')).not.toBeInTheDocument();
    expect(screen.getByText('0 / 1')).toBeInTheDocument();

    // Advance past 60s contest time (total 4s real time * 16 = 64s): sample 1 (01:00) activates both standings AND milestone together.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('Agent A solved A at 12s')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();

    // Scrub slider back to sample 0 resets both standings and milestones together.
    fireEvent.change(screen.getByRole('slider', { name: '竞速时间轴' }), { target: { value: '0' } });
    expect(screen.queryByText('Agent A solved A at 12s')).not.toBeInTheDocument();
    expect(screen.getByText('0 / 1')).toBeInTheDocument();
  });
});
