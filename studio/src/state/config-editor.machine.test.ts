import type { AgentItemResponse } from '@studio-api';
import { configEditorReducer, initialConfigEditorState } from './config-editor.machine';

const makeAgent = (path: string, name: string): AgentItemResponse => ({
  path,
  format: 'toml',
  document: { kind: 'contestreplay.dev/agent', schema_version: 1, id: 'a', name },
  valid: true,
  issues: [],
});

describe('configEditorReducer', () => {
  it('ignores stale load responses when switching targets rapidly', () => {
    let s = configEditorReducer(initialConfigEditorState, { type: 'OPEN_EDIT_START', kind: 'agent', path: 'agents/a.toml', requestId: 1 });
    s = configEditorReducer(s, { type: 'OPEN_EDIT_START', kind: 'agent', path: 'agents/b.toml', requestId: 2 });
    s = configEditorReducer(s, { type: 'LOAD_AGENT_OK', requestId: 1, item: makeAgent('agents/a.toml', 'A') });
    expect(s).toEqual({ phase: 'loading', kind: 'agent', path: 'agents/b.toml', requestId: 2 });
    s = configEditorReducer(s, { type: 'LOAD_AGENT_OK', requestId: 2, item: makeAgent('agents/b.toml', 'B') });
    expect(s.phase).toBe('editing_agent');
    if (s.phase === 'editing_agent') expect(s.item.path).toBe('agents/b.toml');
  });

  it('keeps an open editor reload intact when an unrelated item is deleted, and closes when its own item is deleted', () => {
    const a1 = makeAgent('agents/a.toml', 'A1');
    const a2 = makeAgent('agents/a.toml', 'A2');
    let s = configEditorReducer(initialConfigEditorState, { type: 'OPEN_EDIT_START', kind: 'agent', path: 'agents/a.toml', requestId: 1 });
    s = configEditorReducer(s, { type: 'LOAD_AGENT_OK', requestId: 1, item: a1 });
    s = configEditorReducer(s, { type: 'RELOAD_START', kind: 'agent', path: 'agents/a.toml', requestId: 2 });
    // Deleting unrelated B must NOT cancel A's pending reload
    s = configEditorReducer(s, { type: 'ITEM_DELETED', kind: 'agent', path: 'agents/b.toml' });
    expect(s).toEqual({ phase: 'editing_agent', item: a1, reloadingRequestId: 2 });
    s = configEditorReducer(s, { type: 'RELOAD_AGENT_OK', requestId: 2, item: a2 });
    expect(s).toEqual({ phase: 'editing_agent', item: a2 });
    // Deleting A itself closes the editor cleanly
    s = configEditorReducer(s, { type: 'ITEM_DELETED', kind: 'agent', path: 'agents/a.toml' });
    expect(s).toEqual({ phase: 'closed' });
  });

  it('closes editing state on reload failure so user cannot save against an obsolete baseline', () => {
    let s = configEditorReducer(initialConfigEditorState, { type: 'OPEN_EDIT_START', kind: 'agent', path: 'agents/a.toml', requestId: 1 });
    s = configEditorReducer(s, { type: 'LOAD_AGENT_OK', requestId: 1, item: makeAgent('agents/a.toml', 'A1') });
    s = configEditorReducer(s, { type: 'RELOAD_START', kind: 'agent', path: 'agents/a.toml', requestId: 2 });
    s = configEditorReducer(s, { type: 'RELOAD_FAILED', requestId: 2, message: 'boom' });
    expect(s).toEqual({ phase: 'closed' });
  });
});
