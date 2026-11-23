import type { AgentItemResponse, ContestItemResponse } from '@studio-api';

export type ConfigKind = 'agent' | 'contest';

export type ConfigEditorState =
  | { phase: 'closed' }
  | { phase: 'creating'; kind: ConfigKind }
  | { phase: 'loading'; kind: ConfigKind; path: string; requestId: number }
  | { phase: 'editing_agent'; item: AgentItemResponse; reloadingRequestId?: number }
  | { phase: 'editing_contest'; item: ContestItemResponse; reloadingRequestId?: number }
  | { phase: 'load_error'; kind: ConfigKind; path: string; message: string };

export type ConfigEditorEvent =
  | { type: 'OPEN_NEW'; kind: ConfigKind }
  | { type: 'OPEN_EDIT_START'; kind: ConfigKind; path: string; requestId: number }
  | { type: 'LOAD_AGENT_OK'; requestId: number; item: AgentItemResponse }
  | { type: 'LOAD_CONTEST_OK'; requestId: number; item: ContestItemResponse }
  | { type: 'LOAD_ERROR'; requestId: number; message: string }
  | { type: 'RELOAD_START'; kind: ConfigKind; path: string; requestId: number }
  | { type: 'RELOAD_AGENT_OK'; requestId: number; item: AgentItemResponse }
  | { type: 'RELOAD_CONTEST_OK'; requestId: number; item: ContestItemResponse }
  | { type: 'RELOAD_FAILED'; requestId: number; message: string }
  | { type: 'ITEM_DELETED'; kind: ConfigKind; path: string }
  | { type: 'CLOSE' };

export const initialConfigEditorState: ConfigEditorState = { phase: 'closed' };

export function configEditorReducer(
  state: ConfigEditorState,
  event: ConfigEditorEvent,
): ConfigEditorState {
  switch (event.type) {
    case 'CLOSE':
      return { phase: 'closed' };

    case 'OPEN_NEW':
      return { phase: 'creating', kind: event.kind };

    case 'OPEN_EDIT_START':
      return { phase: 'loading', kind: event.kind, path: event.path, requestId: event.requestId };

    case 'LOAD_AGENT_OK':
      if (state.phase !== 'loading' || state.kind !== 'agent' || state.requestId !== event.requestId) {
        return state;
      }
      return { phase: 'editing_agent', item: event.item };

    case 'LOAD_CONTEST_OK':
      if (state.phase !== 'loading' || state.kind !== 'contest' || state.requestId !== event.requestId) {
        return state;
      }
      return { phase: 'editing_contest', item: event.item };

    case 'LOAD_ERROR':
      if (state.phase !== 'loading' || state.requestId !== event.requestId) {
        return state;
      }
      return { phase: 'load_error', kind: state.kind, path: state.path, message: event.message };

    case 'RELOAD_START':
      if (event.kind === 'agent' && state.phase === 'editing_agent' && state.item.path === event.path) {
        return { ...state, reloadingRequestId: event.requestId };
      }
      if (event.kind === 'contest' && state.phase === 'editing_contest' && state.item.path === event.path) {
        return { ...state, reloadingRequestId: event.requestId };
      }
      return state;

    case 'RELOAD_AGENT_OK':
      if (state.phase !== 'editing_agent' || state.reloadingRequestId !== event.requestId || state.item.path !== event.item.path) {
        return state;
      }
      return { phase: 'editing_agent', item: event.item };

    case 'RELOAD_CONTEST_OK':
      if (state.phase !== 'editing_contest' || state.reloadingRequestId !== event.requestId || state.item.path !== event.item.path) {
        return state;
      }
      return { phase: 'editing_contest', item: event.item };

    case 'RELOAD_FAILED':
      if (state.phase === 'editing_agent' && state.reloadingRequestId === event.requestId) {
        return { phase: 'closed' };
      }
      if (state.phase === 'editing_contest' && state.reloadingRequestId === event.requestId) {
        return { phase: 'closed' };
      }
      return state;

    case 'ITEM_DELETED':
      if (state.phase === 'loading' && state.kind === event.kind && state.path === event.path) {
        return { phase: 'closed' };
      }
      if (state.phase === 'load_error' && state.kind === event.kind && state.path === event.path) {
        return { phase: 'closed' };
      }
      if (event.kind === 'agent' && state.phase === 'editing_agent' && state.item.path === event.path) {
        return { phase: 'closed' };
      }
      if (event.kind === 'contest' && state.phase === 'editing_contest' && state.item.path === event.path) {
        return { phase: 'closed' };
      }
      // Deleting an unrelated item never cancels or disturbs the currently open editor or its pending reload.
      return state;
  }
}
