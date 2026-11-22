import type { ContestPreviewResponse } from '@studio-api';
import { canonicalCfRef, codeforcesWeightSignature, computeCodeforcesPointsKnown } from './cf-points';

const previewFor = (contestRef: string, problems: { remote_id: string; max_points?: number }[]): ContestPreviewResponse => ({
  preview: { platform: 'codeforces', contest_ref: contestRef, title: 'CF', status: 'finished', problems, suggested_languages: [] },
  language_presets: [{ id: 'cpp17', label: 'C++17', remote_id: '54' }],
});

describe('computeCodeforcesPointsKnown', () => {
  it('returns explicit false when editing weights on a points_known=true contest without fetching a preview', () => {
    const unchanged = computeCodeforcesPointsKnown({
      cfId: '1999',
      gym: false,
      problems: [{ id: 'A', max_points: 500 }],
      problemMap: {},
      isEdit: true,
      sourceJudge: { kind: 'codeforces', contest_id: 1999, points_known: true },
      sourceProblems: [{ id: 'A', max_points: 500 }],
    });
    expect(unchanged).toBe(true);

    const edited = computeCodeforcesPointsKnown({
      cfId: '1999',
      gym: false,
      problems: [{ id: 'A', max_points: 2 }],
      problemMap: {},
      isEdit: true,
      sourceJudge: { kind: 'codeforces', contest_id: 1999, points_known: true },
      sourceProblems: [{ id: 'A', max_points: 500 }],
    });
    expect(edited).toBe(false);
  });

  it('uses canonical Round vs Gym refs (gym:<id>) for preview matching, source comparison, and confirmation', () => {
    expect(canonicalCfRef('2000', false)).toBe('2000');
    expect(canonicalCfRef('2000', true)).toBe('gym:2000');

    // Gym preview matches gym:2000 -> true
    expect(computeCodeforcesPointsKnown({
      cfId: '2000',
      gym: true,
      problems: [{ id: 'A', max_points: 500 }],
      problemMap: {},
      preview: previewFor('gym:2000', [{ remote_id: 'A', max_points: 500 }]),
      isEdit: false,
    })).toBe(true);

    // Switching a verified Round (2000) to Gym (gym:2000) does NOT reuse Round preview or Round source verification
    expect(computeCodeforcesPointsKnown({
      cfId: '2000',
      gym: true,
      problems: [{ id: 'A', max_points: 500 }],
      problemMap: {},
      preview: previewFor('2000', [{ remote_id: 'A', max_points: 500 }]),
      isEdit: true,
      sourceJudge: { kind: 'codeforces', contest_id: 2000, gym: false, points_known: true },
      sourceProblems: [{ id: 'A', max_points: 500 }],
    })).toBe(false);

    // Confirmation signature differs between Round and Gym
    const roundSig = codeforcesWeightSignature('2000', false, [{ id: 'A', max_points: 500 }], {});
    const gymSig = codeforcesWeightSignature('2000', true, [{ id: 'A', max_points: 500 }], {});
    expect(roundSig).not.toBe(gymSig);
  });
});
