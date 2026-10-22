import type { GraphNode, GraphResponse, GraphTopic } from '../../shared/protocol.js';
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
}

function countStates(nodes: GraphNode[]): { agreed: number; proposed: number; reference: number } {
  let agreed = 0;
  let proposed = 0;
  let reference = 0;
  for (const node of nodes) {
    if (node.state === 'agreed') agreed += 1;
    else if (node.state === 'proposed') proposed += 1;
    else reference += 1;
  }
  return { agreed, proposed, reference };
}

function TopicRow(props: {
  topic: GraphTopic;
  active: boolean;
  onOpen: () => void;
  onFilter: () => void;
  nodeCount: number;
}): React.JSX.Element {
  const { topic, active, onOpen, onFilter, nodeCount } = props;
  return (
    <li className="nav-item" data-active={active ? 'true' : 'false'}>
      <button type="button" className="nav-item__main" onClick={onOpen} title={topic.path}>
        <span className="nav-item__title">{topic.title}</span>
        <span className="nav-item__meta">{String(nodeCount)} 张</span>
      </button>
      <button
        type="button"
        className="nav-item__filter"
        aria-pressed={active}
        aria-label={active ? '退出主题聚焦' : '聚焦该主题'}
        title={active ? '退出主题聚焦' : '聚焦该主题'}
        onClick={onFilter}
      >
        {active ? '●' : '○'}
      </button>
    </li>
  );
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const {
    graph, query, onQueryChange, results, collapsed, activeNodeId, selectedNodeId,
    topicFilter, onSelectNode, onOpenTopic, onToggleCollapse, onTopicFilter, onSelectTopicPath, onClose,
  } = props;

  const counts = graph === null ? null : countStates(graph.nodes);
  const topicTitleById = new Map(graph?.topics.map((topic) => [topic.id, topic.title]) ?? []);
  const searching = query.trim().length > 0;

  return (
    <nav className="sidebar panel" id="nav-panel" aria-label="主题与搜索">
      <div className="panel__head">
        <h2 className="panel__title">主题与搜索</h2>
        <button type="button" className="panel__close" onClick={onClose} aria-label="收起导航" title="收起导航">×</button>
        {counts !== null ? (
          <span className="sidebar__counts" title="已确认 / 待确认 / 参考">
            <span className="dot dot--ok" />{String(counts.agreed)}
            <span className="dot dot--warn" />{String(counts.proposed)}
            <span className="dot dot--idle" />{String(counts.reference)}
          </span>
        ) : null}
      </div>

      <div className="search">
        <label className="visually-hidden" htmlFor="search-input">搜索标题、摘要或主题</label>
        <input
          id="search-input"
          type="search"
          className="search__input"
          placeholder="搜索标题、摘要、主题…"
          value={query}
          autoComplete="off"
          onChange={(event) => { onQueryChange(event.target.value); }}
        />
        {searching ? (
          <button type="button" className="search__clear" onClick={() => { onQueryChange(''); }} aria-label="清除搜索">×</button>
        ) : null}
      </div>

      <div className="panel__scroll">
        {graph === null ? (
          <p className="sidebar__placeholder">图尚未载入。</p>
        ) : searching ? (
          <section aria-label="搜索结果" className="nav-section">
            <h3 className="nav-heading">
              搜索结果 {String(results.nodes.length + results.topics.length)}
            </h3>
            {results.nodes.length === 0 && results.topics.length === 0 ? (
              <p className="sidebar__placeholder">没有匹配「{results.trimmed}」的标题或摘要。</p>
            ) : null}
            <ul className="nav-list">
              {results.topics.map((topic) => (
                <TopicRow
                  key={'topic:' + topic.id}
                  topic={topic}
                  active={topic.id === topicFilter}
                  nodeCount={topic.nodeIds.length}
                  onOpen={() => { onSelectTopicPath(topic.path); }}
                  onFilter={() => { onTopicFilter(topic.id === topicFilter ? null : topic.id); }}
                />
              ))}
              {results.nodes.map((node) => (
                <li key={node.id} className="nav-item nav-item--node" data-active={node.id === selectedNodeId ? 'true' : 'false'}>
                  <button type="button" className="nav-item__main" onClick={() => { onSelectNode(node.id); }}>
                    <span className="nav-item__number">{node.number}</span>
                    <span className="nav-item__title">{node.title}</span>
                    <span className="nav-item__meta">{topicTitleById.get(node.topicId) ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <>
            <section aria-label="主题目录" className="nav-section">
              <h3 className="nav-heading">主题 {String(graph.topics.length)}</h3>
              {graph.topics.length === 0 ? (
                <p className="sidebar__placeholder">工作区尚无主题。</p>
              ) : (
                <ul className="nav-list">
                  {graph.topics.map((topic) => (
                    <TopicRow
                      key={topic.id}
                      topic={topic}
                      active={topic.id === topicFilter}
                      nodeCount={topic.nodeIds.length}
                      onOpen={() => { onSelectTopicPath(topic.path); }}
                      onFilter={() => { onTopicFilter(topic.id === topicFilter ? null : topic.id); }}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="讨论链" className="nav-section">
              <h3 className="nav-heading">结构链</h3>
              <ul className="nav-list nav-list--tree">
                {orderChain(graph.nodes).map((node) => {
                  const indent = (node.number.match(/-/g) ?? []).length;
                  const isCollapsed = collapsed.has(node.id);
                  return (
                    <li
                      key={node.id}
                      className="nav-item nav-item--chain"
                      data-active={node.id === selectedNodeId ? 'true' : 'false'}
                      data-current={node.id === activeNodeId ? 'true' : 'false'}
                      style={{ paddingLeft: 'calc(' + String(indent) + ' * 10px)' }}
                    >
                      {node.flow !== 'root' ? (
                        <button
                          type="button"
                          className="nav-item__twisty"
                          aria-expanded={!isCollapsed}
                          aria-label={isCollapsed ? '展开' : '折叠'}
                          onClick={() => { onToggleCollapse(node.id); }}
                        >
                          {isCollapsed ? '▸' : '▾'}
                        </button>
                      ) : (
                        <span className="nav-item__twisty nav-item__twisty--root" aria-hidden="true">·</span>
                      )}
                      <button type="button" className="nav-item__main" onClick={() => { onSelectNode(node.id); }}>
                        <span className="nav-item__number">{node.number}</span>
                        <span className="nav-item__title">{node.title}</span>
                      </button>
                      <span className="nav-item__state" data-state={node.state} title={node.state} />
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}
      </div>
    </nav>
  );
}