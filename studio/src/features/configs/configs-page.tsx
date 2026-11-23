import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, Bot, FilePlus2 } from 'lucide-react';
import { studioApi } from '@/lib/api';
import { invalidateConfigGraph } from '@/state/query-keys';
import {
  configEditorReducer,
  initialConfigEditorState,
  type ConfigKind,
} from '@/state/config-editor.machine';
import { PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { SlideDrawer } from '@/design-system/motion';
import { AgentForm } from './agent-form';
import { ContestForm } from './contest-form';
import { ConfigLibrary } from './config-library';

type ConfigsSearch = {
  tab?: 'agents' | 'contests';
  q?: string;
  drawer?: 'new-agent' | 'new-contest' | 'edit-agent' | 'edit-contest';
  path?: string;
};

export function ConfigsPage() {
  const search = useSearch({ strict: false }) as ConfigsSearch;
  const navigate = useNavigate();
  const client = useQueryClient();
  const [editor, dispatch] = useReducer(configEditorReducer, initialConfigEditorState);
  const requestSeq = useRef(0);
  const lastUrlKey = useRef('');

  const activeTab: 'agents' | 'contests' = search.tab === 'contests' ? 'contests' : 'agents';

  const patchSearch = useCallback((patch: Partial<ConfigsSearch>, clearDrawer = false) => {
    void navigate({
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        if (clearDrawer) {
          delete next.drawer;
          delete next.path;
        }
        if (!next.q) delete next.q;
        return next;
      },
      replace: true,
    } as never);
  }, [navigate]);

  const loadForEdit = useCallback((kind: ConfigKind, path: string) => {
    const requestId = ++requestSeq.current;
    dispatch({ type: 'OPEN_EDIT_START', kind, path, requestId });
    const fetchPromise = kind === 'agent'
      ? studioApi.agentItem(path).then(item => dispatch({ type: 'LOAD_AGENT_OK', requestId, item }))
      : studioApi.contestItem(path).then(item => dispatch({ type: 'LOAD_CONTEST_OK', requestId, item }));
    fetchPromise.catch((error: Error) => {
      dispatch({ type: 'LOAD_ERROR', requestId, message: error.message });
    });
  }, []);

  // Rehydrate drawer state from URL search params on initial mount / back-forward navigation
  useEffect(() => {
    const key = `${search.drawer ?? ''}:${search.path ?? ''}`;
    if (key === lastUrlKey.current) return;
    lastUrlKey.current = key;
    if (!search.drawer) {
      dispatch({ type: 'CLOSE' });
    } else if (search.drawer === 'new-agent') {
      dispatch({ type: 'OPEN_NEW', kind: 'agent' });
    } else if (search.drawer === 'new-contest') {
      dispatch({ type: 'OPEN_NEW', kind: 'contest' });
    } else if (search.drawer === 'edit-agent' && search.path) {
      loadForEdit('agent', search.path);
    } else if (search.drawer === 'edit-contest' && search.path) {
      loadForEdit('contest', search.path);
    }
  }, [search.drawer, search.path, loadForEdit]);

  const openNew = (kind: ConfigKind) => {
    const drawer = kind === 'agent' ? 'new-agent' : 'new-contest';
    lastUrlKey.current = `${drawer}:`;
    dispatch({ type: 'OPEN_NEW', kind });
    patchSearch({ drawer, path: undefined });
  };

  const openEdit = (kind: ConfigKind, path: string) => {
    const drawer = kind === 'agent' ? 'edit-agent' : 'edit-contest';
    lastUrlKey.current = `${drawer}:${path}`;
    loadForEdit(kind, path);
    patchSearch({ drawer, path });
  };

  const closeDrawer = () => {
    lastUrlKey.current = ':';
    dispatch({ type: 'CLOSE' });
    patchSearch({}, true);
  };

  const handleSaved = async (kind: ConfigKind, intent: 'save' | 'batch' = 'save') => {
    await invalidateConfigGraph(client);
    if (intent !== 'save') return;
    lastUrlKey.current = ':';
    dispatch({ type: 'CLOSE' });
    patchSearch({ tab: kind === 'agent' ? 'agents' : 'contests' }, true);
  };

  const handleDeleted = (kind: ConfigKind, path: string) => {
    const matchingOpen =
      (editor.phase === 'loading' && editor.kind === kind && editor.path === path) ||
      (editor.phase === 'load_error' && editor.kind === kind && editor.path === path) ||
      (kind === 'agent' && editor.phase === 'editing_agent' && editor.item.path === path) ||
      (kind === 'contest' && editor.phase === 'editing_contest' && editor.item.path === path);
    dispatch({ type: 'ITEM_DELETED', kind, path });
    if (matchingOpen) {
      lastUrlKey.current = ':';
      patchSearch({}, true);
    }
    void invalidateConfigGraph(client);
  };

  const drawerOpen = editor.phase !== 'closed';
  const drawerMeta = (() => {
    switch (editor.phase) {
      case 'creating':
        return editor.kind === 'agent'
          ? { eyebrow: '新建 Agent 配置', title: '新建 Agent', description: '定义模型、Provider 接入与 Harness 参数，保存为独立可复现清单。' }
          : { eyebrow: '新建 Contest 配置', title: '新建 Contest', description: '配置题面材料、本地或远端判题后端与赛时预算。' };
      case 'loading':
        return { eyebrow: '正在读取配置', title: editor.path, description: '正在从本机工作区加载清单与修订摘要…' };
      case 'editing_agent':
        return {
          eyebrow: '编辑 Agent 配置',
          title: editor.item.name ?? editor.item.id ?? editor.item.path,
          description: `文件：${editor.item.path} · 格式：${editor.item.format.toUpperCase()}`,
        };
      case 'editing_contest':
        return {
          eyebrow: '编辑 Contest 配置',
          title: (editor.item.document as { title?: string })?.title ?? editor.item.contest_id ?? editor.item.path,
          description: `文件：${editor.item.path}`,
        };
      case 'load_error':
        return { eyebrow: '无法加载配置', title: editor.path, description: '读取目标清单失败。' };
      default:
        return { eyebrow: '', title: '', description: '' };
    }
  })();

  return <>
    <PageHeader
      eyebrow="04 · 配置库"
      title="配置库"
      description="集中检索、编辑、克隆并派生可复现的 Agent 与 Contest 配置；新建与编辑在右侧抽屉完成，不打断列表上下文。"
      actions={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => openNew('agent')}><Bot className="size-4" />新建 Agent</Button>
          <Button onClick={() => openNew('contest')}><FilePlus2 className="size-4" />新建 Contest</Button>
        </div>
      }
    />

    <ConfigLibrary
      activeTab={activeTab}
      onTabChange={tab => patchSearch({ tab })}
      search={search.q ?? ''}
      onSearchChange={q => patchSearch({ q })}
      loadingPath={editor.phase === 'loading' ? editor.path : ''}
      onEditAgent={path => openEdit('agent', path)}
      onEditContest={path => openEdit('contest', path)}
      onDeletedAgent={path => handleDeleted('agent', path)}
      onDeletedContest={path => handleDeleted('contest', path)}
      onCreateAgent={() => openNew('agent')}
      onCreateContest={() => openNew('contest')}
    />

    <SlideDrawer
      open={drawerOpen}
      onOpenChange={open => { if (!open) closeDrawer(); }}
      eyebrow={drawerMeta.eyebrow}
      title={drawerMeta.title}
      description={drawerMeta.description}
    >
      {editor.phase === 'loading' && (
        <div className="space-y-4">
          <div className="skeleton h-12 rounded-[3px] border bg-muted/40" />
          <div className="skeleton h-36 rounded-[3px] border bg-muted/40" />
          <div className="skeleton h-48 rounded-[3px] border bg-muted/40" />
        </div>
      )}
      {editor.phase === 'load_error' && (
        <EmptyState
          icon={AlertTriangle}
          title="无法读取配置"
          description={editor.message}
          action={<Button variant="secondary" onClick={() => loadForEdit(editor.kind, editor.path)}>重试</Button>}
        />
      )}
      {editor.phase === 'creating' && editor.kind === 'agent' && (
        <AgentForm key="new-agent" onSaved={intent => handleSaved('agent', intent)} />
      )}
      {editor.phase === 'creating' && editor.kind === 'contest' && (
        <ContestForm key="new-contest" onSaved={intent => handleSaved('contest', intent)} />
      )}
      {editor.phase === 'editing_agent' && (
        <AgentForm key={editor.item.path} initial={editor.item} onSaved={intent => handleSaved('agent', intent)} />
      )}
      {editor.phase === 'editing_contest' && (
        <ContestForm key={editor.item.path} initial={editor.item} onSaved={intent => handleSaved('contest', intent)} />
      )}
    </SlideDrawer>
  </>;
}
