export interface PlaybackState {
  cursor: number;
  playing: boolean;
  speed: string;
  pinnedSeq?: number;
}

export type PlaybackEvent =
  | { type: 'RESET'; speed?: string }
  | { type: 'TOGGLE_PLAY'; duration: number; displayTime?: number }
  | { type: 'TICK'; duration: number; intervalMs: number }
  | { type: 'SEEK'; cursor: number; pinnedSeq?: number }
  | { type: 'SET_SPEED'; speed: string };

export function createPlaybackState(defaultSpeed = '4'): PlaybackState {
  return { cursor: 0, playing: false, speed: defaultSpeed, pinnedSeq: undefined };
}

export function playbackReducer(state: PlaybackState, event: PlaybackEvent): PlaybackState {
  switch (event.type) {
    case 'RESET':
      return {
        cursor: 0,
        playing: false,
        speed: event.speed ?? state.speed,
        pinnedSeq: undefined,
      };

    case 'TOGGLE_PLAY': {
      if (state.playing) return { ...state, playing: false };
      const atEnd = state.cursor >= event.duration || (event.displayTime !== undefined && event.displayTime >= event.duration);
      return {
        ...state,
        cursor: atEnd ? 0 : state.cursor,
        playing: event.duration > 0,
        pinnedSeq: undefined,
      };
    }

    case 'TICK': {
      if (!state.playing || event.duration <= 0) return state;
      const next = Math.min(event.duration, state.cursor + event.intervalMs * Number(state.speed));
      return {
        ...state,
        cursor: next,
        playing: next < event.duration,
      };
    }

    case 'SEEK':
      return {
        ...state,
        cursor: Math.max(0, event.cursor),
        playing: false,
        pinnedSeq: event.pinnedSeq,
      };

    case 'SET_SPEED':
      return { ...state, speed: event.speed };
  }
}
