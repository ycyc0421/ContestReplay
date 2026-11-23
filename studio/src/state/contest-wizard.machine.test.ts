import {
  buildCfWeightSigFromDrafts,
  contestWizardReducer,
  mergePreviewProblemMap,
  type ContestWizardState,
} from './contest-wizard.machine';

const baseState: ContestWizardState = {
  step: 2,
  maxStep: 2,
  materialMode: 'path',
  problems: [{ id: 'A', maxPoints: 1, answers: '' }],
  cfNoticeSticky: false,
};

describe('contestWizardReducer', () => {
  it('preserves explicit problem_map overrides when merging preview suggestions', () => {
    expect(mergePreviewProblemMap({ A: 'B', B: 'A' }, { A: 'A', B: 'B', C: 'C' })).toEqual({
      A: 'B',
      B: 'A',
      C: 'C',
    });
  });

  it('atomically clears confirmation when a problem weight changes so restoring old weight requires reconfirming', () => {
    const sig1 = buildCfWeightSigFromDrafts('2000', false, [{ id: 'A', maxPoints: 1, answers: '' }], {});
    const sig2 = buildCfWeightSigFromDrafts('2000', false, [{ id: 'A', maxPoints: 2, answers: '' }], {});

    let s = contestWizardReducer(baseState, { type: 'SET_CF_CONFIRMATION', confirmed: true, currentSig: sig1 });
    expect(s.confirmedWeightsSig).toBe(sig1);
    expect(s.cfNoticeSticky).toBe(true);

    s = contestWizardReducer(s, {
      type: 'SET_PROBLEMS',
      problems: [{ id: 'A', maxPoints: 2, answers: '' }],
      nextCfWeightSig: sig2,
    });
    expect(s.confirmedWeightsSig).toBeUndefined();
    expect(s.cfNoticeSticky).toBe(true);

    s = contestWizardReducer(s, {
      type: 'SET_PROBLEMS',
      problems: [{ id: 'A', maxPoints: 1, answers: '' }],
      nextCfWeightSig: sig1,
    });
    expect(s.confirmedWeightsSig).toBeUndefined();
  });
});
