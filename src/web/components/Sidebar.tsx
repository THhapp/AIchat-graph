import type { GraphResponse } from '../../next/protocol.js';
import type { SearchResults } from '../lib/search.js';
import {
  directoryRows,
  visibleDirectoryRows,
  type DirectoryRow,
} from './directoryTree.js';

export interface SidebarProps {
  graph: GraphResponse | null;
  query: string;
  onQueryChange: (value: string) => void;
  results: SearchResults;
  activeNodeId: string | null;
  selectedNodeId: string | null;
  topicFilter: string | null;
  onSelectNode: (id: string) => void;
  onOpenTopic: (id: string) => void;
  /** Directory-only fold of one node's children. Never collapses the graph. */
  onToggleNavNode: (nodeId: string) => void;
  /** Node ids folded inside the directory tree of the current topic. */
  navCollapsed: ReadonlySet<string>;
  /** Topic folders currently open; the reader's own choice, persisted locally. */
  expandedTopicIds: ReadonlySet<string>;
  onToggleTopicFolder: (topicId: string) => void;
  onTopicFilter: (id: string | null) => void;
  /** Called by the panel's own close control. */
  onClose: () => void;
  directoryMode?: boolean;
  onCopyTopic?: () => void;
  copied?: boolean;
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const {
    graph, query, onQueryChange, results, activeNodeId, selectedNodeId, topicFilter,
    onSelectNode, onOpenTopic, onToggleNavNode, navCollapsed, expandedTopicIds, onToggleTopicFolder,
    onClose, directoryMode = false, onCopyTopic, copied,
  } = props;
  const currentTopicId = topicFilter ?? (!directoryMode && graph?.topics.length === 1 ? graph.topics[0]?.id ?? null : null);
  const searching = query.trim().length > 0;
  const currentNodes = graph === null ? [] : graph.nodes.filter((node) => node.topicId === currentTopicId);

  const renderRow = (row: DirectoryRow, searchResult = false): React.JSX.Element => {
    const { node, level, hasChildren, hiddenCount } = row;
    const folded = !searchResult && navCollapsed.has(node.id);
    return (
      <li
        key={node.id}
        className={'nav-item' + (searchResult ? ' nav-item--search' : ' nav-item--chain')}
        data-active={node.id === selectedNodeId ? 'true' : 'false'}
        data-current={node.id === activeNodeId ? 'true' : 'false'}
        data-level={level}
        style={{ paddingLeft: String(level * 12) + 'px' }}
      >
        {searchResult || !hasChildren ? (
          <span className="nav-item__twisty nav-item__twisty--root" aria-hidden="true">·</span>
        ) : (
          <button
            type="button"
            className="nav-item__twisty"
            aria-expanded={!folded}
            aria-label={(folded ? '在目录中展开 ' : '在目录中折叠 ') + node.number + ' ' + node.title}
            title={folded ? '在目录中展开（不影响图）' : '在目录中折叠（不影响图）'}
            onClick={() => { onToggleNavNode(node.id); }}
          >
            {folded ? '▸' : '▾'}
          </button>
        )}
        <button type="button" className="nav-item__main" onClick={() => { onSelectNode(node.id); }}>
          <span className="nav-item__number">{node.number}</span>
          <span className="nav-item__title">{node.title}</span>
          {folded && hiddenCount > 0 ? <span className="nav-item__meta">+{String(hiddenCount)}</span> : null}
        </button>
        <span className="nav-item__state" data-state={node.state} title={node.state} />
      </li>
    );
  };

  const searchRows: DirectoryRow[] = results.nodes
    .filter((node) => node.topicId === currentTopicId)
    .map((node) => ({ node, level: 0, parentId: null, hasChildren: false, hiddenCount: 0 }));

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
              {graph.topics.map((topic) => {
                const open = expandedTopicIds.has(topic.id);
                const topicNodes = graph.nodes.filter((node) => node.topicId === topic.id);
                const rows = visibleDirectoryRows(directoryRows(topicNodes), navCollapsed);
                return (
                  <li key={topic.id} className="topic-folder" data-topic-id={topic.id}>
                    <div className="nav-item" data-active={topic.id === currentTopicId ? 'true' : 'false'}>
                      <button type="button" className="nav-item__twisty" aria-expanded={open} aria-label={(open ? '收起主题 ' : '展开主题 ') + topic.title} onClick={() => { onToggleTopicFolder(topic.id); }}>{open ? '▾' : '▸'}</button>
                      <button type="button" className="nav-item__main" aria-current={topic.id === currentTopicId ? 'page' : undefined} onClick={() => { onOpenTopic(topic.id); }} title={topic.title}>
                        <span aria-hidden="true">▱</span><span className="nav-item__title">{topic.title}</span><span className="nav-item__meta">{String(topic.nodeIds.length)} 张</span>
                      </button>
                    </div>
                    {open ? (
                      <ul className="nav-list nav-list--tree" aria-label={topic.title + '的节点'}>
                        {rows.map((row) => renderRow(row))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="nav-section" aria-label="当前主题搜索">
          <div className="search">
            <label className="visually-hidden" htmlFor="search-input">搜索当前主题的标题和摘要</label>
            <input id="search-input" type="search" className="search__input" placeholder={currentTopicId === null ? '请先选择主题' : '搜索当前主题…'} disabled={currentTopicId === null} value={query} autoComplete="off" onChange={(event) => { onQueryChange(event.target.value); }} />
            {searching ? <button type="button" className="search__clear" onClick={() => { onQueryChange(''); }} aria-label="清除搜索">×</button> : null}
          </div>
          {searching ? <><h3 className="nav-heading">当前主题结果 {String(searchRows.length)}</h3><ul className="nav-list nav-list--results">{searchRows.map((row) => renderRow(row, true))}</ul>{searchRows.length === 0 ? <p className="sidebar__placeholder">当前主题没有匹配的标题或摘要。</p> : null}</> : null}
          {onCopyTopic !== undefined && currentTopicId !== null ? <button type="button" onClick={onCopyTopic}>{copied ? '已复制' : '复制主题给 Agent'}</button> : null}
        </section>
      </div>
    </nav>
  );
}
