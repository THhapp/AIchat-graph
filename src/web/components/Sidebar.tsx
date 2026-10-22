import { useEffect, useState } from 'react';
import type { GraphNode, GraphResponse } from '../../shared/protocol.js';
import type { SearchResults } from '../lib/search.js';

/** Structural reading order: root first, then next before branch by order. */
function orderChain(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.from === null || !byId.has(node.from)) continue;
    const list = children.get(node.from) ?? [];
    list.push(node);
    children.set(node.from, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => {
      if (a.flow !== b.flow) {
        if (a.flow === 'next') return -1;
        if (b.flow === 'next') return 1;
      }
      const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.number.localeCompare(b.number, 'zh-CN', { numeric: true });
    });
  }
  const result: GraphNode[] = [];
  const seen = new Set<string>();
  const roots = nodes.filter((node) => node.from === null || !byId.has(node.from));
  const visit = (node: GraphNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    result.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // Defensive: orphaned/cyclic leftovers stay visible rather than disappearing.
  for (const node of nodes) visit(node);
  return result;
}

export interface SidebarProps {
  graph: GraphResponse | null;
  query: string;
  onQueryChange: (value: string) => void;
  results: SearchResults;
  collapsed: ReadonlySet<string>;
  activeNodeId: string | null;
  selectedNodeId: string | null;
  topicFilter: string | null;
  onSelectNode: (id: string) => void;
  onOpenTopic: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onTopicFilter: (id: string | null) => void;
  onSelectTopicPath: (path: string) => void;
  /** Called by the panel's own close control. */
  onClose: () => void;
  directoryMode?: boolean;
  onCopyTopic?: () => void;
  copied?: boolean;
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const { graph, query, onQueryChange, results, collapsed, activeNodeId, selectedNodeId, topicFilter, onSelectNode, onOpenTopic, onToggleCollapse, onClose, directoryMode = false, onCopyTopic, copied } = props;
  const currentTopicId = topicFilter ?? (!directoryMode && graph?.topics.length === 1 ? graph.topics[0]?.id ?? null : null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(currentTopicId === null ? [] : [currentTopicId]));
  useEffect(() => {
    if (currentTopicId !== null) setExpanded((current) => new Set([...current, currentTopicId]));
  }, [currentTopicId]);
  const searching = query.trim().length > 0;
  const toggleFolder = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const renderNode = (node: GraphNode): React.JSX.Element => (
    <li key={node.id} className="nav-item nav-item--chain" data-active={node.id === selectedNodeId ? 'true' : 'false'} data-current={node.id === activeNodeId ? 'true' : 'false'} style={{ paddingLeft: 'calc(' + String((node.number.match(/-/g) ?? []).length) + ' * 10px)' }}>
      <button type="button" className="nav-item__twisty" aria-expanded={!collapsed.has(node.id)} aria-label={collapsed.has(node.id) ? '展开节点分支' : '折叠节点分支'} onClick={() => { onToggleCollapse(node.id); }}>{collapsed.has(node.id) ? '▸' : '▾'}</button>
      <button type="button" className="nav-item__main" onClick={() => { onSelectNode(node.id); }}><span className="nav-item__number">{node.number}</span><span className="nav-item__title">{node.title}</span></button>
      <span className="nav-item__state" data-state={node.state} title={node.state} />
    </li>
  );
  const matches = results.nodes.filter((node) => node.topicId === currentTopicId);
  return (
    <nav className="sidebar panel" id="nav-panel" aria-label="主题目录">
      <div className="panel__head">
        <h2 className="panel__title">主题目录</h2>
        <button type="button" className="panel__close" onClick={onClose} aria-label="收起主题目录">×</button>
      </div>
      <div className="panel__scroll">
        <section aria-label="主题文件夹" className="nav-section">
          <h3 className="nav-heading">主题 {String(graph?.topics.length ?? 0)}</h3>
          {graph === null ? <p className="sidebar__placeholder">图尚未载入。</p> : graph.topics.length === 0 ? <p className="sidebar__placeholder">工作区尚无主题，请让 Agent 创建。</p> : (
            <ul className="nav-list">
              {graph.topics.map((topic) => (
                <li key={topic.id} className="topic-folder" data-topic-id={topic.id}>
                  <div className="nav-item" data-active={topic.id === currentTopicId ? 'true' : 'false'}>
                    <button type="button" className="nav-item__twisty" aria-expanded={expanded.has(topic.id)} aria-label={(expanded.has(topic.id) ? '收起主题 ' : '展开主题 ') + topic.title} onClick={() => { toggleFolder(topic.id); }}>{expanded.has(topic.id) ? '▾' : '▸'}</button>
                    <button type="button" className="nav-item__main" aria-current={topic.id === currentTopicId ? 'page' : undefined} onClick={() => { onOpenTopic(topic.id); }} title={topic.title}>
                      <span aria-hidden="true">▱</span><span className="nav-item__title">{topic.title}</span><span className="nav-item__meta">{String(topic.nodeIds.length)} 张</span>
                    </button>
                  </div>
                  {expanded.has(topic.id) ? <ul className="nav-list nav-list--tree" aria-label={topic.title + '的节点'}>{orderChain(graph.nodes.filter((node) => node.topicId === topic.id)).map(renderNode)}</ul> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="nav-section" aria-label="当前主题搜索">
          <div className="search">
            <label className="visually-hidden" htmlFor="search-input">搜索当前主题的标题和摘要</label>
            <input id="search-input" type="search" className="search__input" placeholder={currentTopicId === null ? '请先选择主题' : '搜索当前主题…'} disabled={currentTopicId === null} value={query} autoComplete="off" onChange={(event) => { onQueryChange(event.target.value); }} />
            {searching ? <button type="button" className="search__clear" onClick={() => { onQueryChange(''); }} aria-label="清除搜索">×</button> : null}
          </div>
          {searching ? <><h3 className="nav-heading">当前主题结果 {String(matches.length)}</h3><ul className="nav-list">{matches.map(renderNode)}</ul>{matches.length === 0 ? <p className="sidebar__placeholder">当前主题没有匹配的标题或摘要。</p> : null}</> : null}
          {onCopyTopic !== undefined && currentTopicId !== null ? <button type="button" onClick={onCopyTopic}>{copied ? '已复制' : '复制主题给 Agent'}</button> : null}
        </section>
      </div>
    </nav>
  );
}
