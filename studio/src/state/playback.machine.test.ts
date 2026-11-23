import { createPlaybackState, playbackReducer } from './playback.machine';

describe('playbackReducer', () => {
  it('advances smoothly on tick, stops cleanly at duration, and restarts from 0 on replay', () => {
    let s = createPlaybackState('16');
    s = playbackReducer(s, { type: 'TOGGLE_PLAY', duration: 10_000 });
    expect(s.playing).toBe(true);
    s = playbackReducer(s, { type: 'TICK', duration: 10_000, intervalMs: 250 });
    expect(s.cursor).toBe(4_000);
    expect(s.playing).toBe(true);
    s = playbackReducer(s, { type: 'TICK', duration: 10_000, intervalMs: 500 });
    expect(s.cursor).toBe(10_000);
    expect(s.playing).toBe(false);
    // Toggling play at the end resets cursor to 0
    s = playbackReducer(s, { type: 'TOGGLE_PLAY', duration: 10_000, displayTime: 10_000 });
    expect(s.cursor).toBe(0);
    expect(s.playing).toBe(true);
  });

  it('pauses and syncs cursor + pinnedSeq atomically on seek', () => {
    let s = playbackReducer(createPlaybackState('4'), { type: 'TOGGLE_PLAY', duration: 60_000 });
    s = playbackReducer(s, { type: 'SEEK', cursor: 12_000, pinnedSeq: 3 });
    expect(s).toMatchObject({ cursor: 12_000, playing: false, pinnedSeq: 3 });
  });
});
