import { LicenseNotices } from './LicenseNotices.js';

export interface AppHeaderProps {
  /** Displayed workspace name, already falling back to its id. */
  workspaceName: string;
  graphRevision: number;
  /** Title of the topic being read; null when no topic is open. */
  selectedTopicTitle: string | null;
  /** Topic active node, highlighted by the directory action. */
  activeNodeId: string | null;
  /** "查看全部" and "复制给 Agent" only make sense with a topic open. */
  topicSelected: boolean;
  leftOpen: boolean;
  detailOpen: boolean;
  exportOpen: boolean;
  copied: boolean;
  onOpenLeft: () => void;
  onSelectNode: (nodeId: string) => void;
  onResetView: () => void;
  onCopyPrompt: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onToggleExport: () => void;
}

/** Read-only header: branding, topic picker and panel/view actions. */
export function AppHeader(props: AppHeaderProps): React.JSX.Element {
  const topicTitle = props.selectedTopicTitle ?? '选择主题';
  // Narrow once so the click closure keeps the non-null type.
  const activeNodeId = props.activeNodeId;
  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__title">AIchat-graph</span>
        <span className="app-header__workspace">{props.workspaceName}</span>
        <button type="button" className="app-header__topic" onClick={props.onOpenLeft} title={topicTitle + ' · 打开主题目录'}>
          {topicTitle} ▾
        </button>
      </div>
      <span className="app-header__spacer" />
      <div className="app-header__meta">
        <span>图 r{props.graphRevision}</span>
        {activeNodeId !== null ? (
          <button type="button" onClick={() => { props.onSelectNode(activeNodeId); }} title="定位当前讨论节点">
            当前讨论
          </button>
        ) : null}
        <button type="button" disabled={!props.topicSelected} onClick={props.onResetView} title="展开并适配当前主题">查看全部</button>
        <button type="button" disabled={!props.topicSelected} onClick={props.onCopyPrompt}>{props.copied ? '已复制' : '复制给 Agent'}</button>
        <button
          type="button"
          aria-pressed={props.leftOpen}
          aria-controls="nav-panel"
          onClick={props.onToggleLeft}
          title="主题目录"
        >
          {props.leftOpen ? '收起目录' : '主题目录'}
        </button>
        <button
          type="button"
          aria-pressed={props.detailOpen}
          aria-controls="detail-panel"
          onClick={props.onToggleRight}
          title="详情面板"
        >
          {props.detailOpen ? '收起详情' : '打开详情'}
        </button>
        <button
          type="button"
          aria-pressed={props.exportOpen}
          aria-controls="export-panel"
          onClick={props.onToggleExport}
          title="导出为独立 HTML"
        >
          {props.exportOpen ? '收起导出' : '导出'}
        </button>
      </div>
    </header>
  );
}

export interface AppBannersProps {
  stale: boolean;
  /** Latest refresh failure; the current reading stays visible. */
  error: Error | null;
  onRefresh: () => void;
}

/** Stale-snapshot and refresh-failure banners, independent of each other. */
export function AppBanners(props: AppBannersProps): React.JSX.Element {
  return (
    <>
      {props.stale ? (
        <div className="banner banner--stale" role="status">
          <span className="banner__text">
            <strong>显示上一份有效内容。</strong> 磁盘上的源文件当前不合法或无法读取，图与详情来自同一份有效快照，不是当前磁盘事实。
          </span>
          <button type="button" onClick={props.onRefresh}>重新检查</button>
        </div>
      ) : null}
      {props.error !== null ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">刷新失败：{props.error.message}（保留当前阅读内容）</span>
          <button type="button" onClick={props.onRefresh}>重试</button>
        </div>
      ) : null}
    </>
  );
}

export interface AppStatus {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
}

export interface AppFooterProps {
  status: AppStatus;
  topicNodeCount: number;
  topicCount: number;
  /** Nodes currently drawn by the layout; null until a layout result exists. */
  visibleCount: number | null;
  instanceId: string;
  revision: number;
}

/** Read-only status bar: sync state, graph totals and diagnostics link. */
export function AppFooter(props: AppFooterProps): React.JSX.Element {
  return (
    <footer className="app-status">
      <span className={'dot dot--' + props.status.tone} aria-hidden="true" />
      <span role="status">{props.status.text}</span>
      <span>{String(props.topicNodeCount)} 节点 · 当前主题 / 全库 {String(props.topicCount)} 主题</span>
      {props.visibleCount !== null ? (
        <span>{String(props.visibleCount)} 可见</span>
      ) : null}
      <span className="app-status__spacer" />
      <span>实例 {props.instanceId.slice(0, 8)} · r{props.revision}</span>
      <LicenseNotices />
      <a href="/api/diagnostics" target="_blank" rel="noreferrer">诊断</a>
    </footer>
  );
}
