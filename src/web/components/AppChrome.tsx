import { useEffect, useRef, useState } from 'react';
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
  /** The local service is stopped: controls that need it are disabled. */
  serviceStopped: boolean;
  /** A runtime control request (open other library / stop) is in flight. */
  runtimeBusy: boolean;
  onOpenWorkspace: () => void;
  onStopService: () => void;
}

/** Read-only header: branding, topic picker and panel/view actions. */
export function AppHeader(props: AppHeaderProps): React.JSX.Element {
  const topicTitle = props.selectedTopicTitle ?? '选择主题';
  // Narrow once so the click closure keeps the non-null type.
  const activeNodeId = props.activeNodeId;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the program menu on an outside pointer or Escape; it has no backdrop.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (menuRef.current !== null && target instanceof Node && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const serviceUnavailable = props.serviceStopped || props.runtimeBusy;
  const runMenuAction = (action: () => void): void => {
    setMenuOpen(false);
    action();
  };

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
          disabled={props.serviceStopped}
          onClick={props.onToggleExport}
          title={props.serviceStopped ? '服务已停止，无法导出' : '导出为独立 HTML'}
        >
          {props.exportOpen ? '收起导出' : '导出'}
        </button>
        <div className="program-menu" ref={menuRef}>
          <button
            type="button"
            className="program-menu__trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={props.runtimeBusy}
            onClick={() => { setMenuOpen((open) => !open); }}
            title="程序菜单"
          >
            {props.runtimeBusy ? '处理中…' : '程序 ▾'}
          </button>
          {menuOpen ? (
            <div className="program-menu__list" role="menu" aria-label="程序菜单">
              <button
                type="button"
                role="menuitem"
                disabled={serviceUnavailable}
                onClick={() => { runMenuAction(props.onOpenWorkspace); }}
              >
                打开其他讨论库…
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={serviceUnavailable}
                onClick={() => { runMenuAction(props.onStopService); }}
              >
                退出本库服务…
              </button>
              {props.serviceStopped ? <p className="program-menu__note">服务已停止，显示停止前内容。</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export interface AppBannersProps {
  stale: boolean;
  /** Latest refresh failure; the current reading stays visible. */
  error: Error | null;
  /** The service was stopped on purpose: the loaded content is the last snapshot. */
  stopped: boolean;
  onRefresh: () => void;
}

/** Stale-snapshot, stopped-service and refresh-failure banners. */
export function AppBanners(props: AppBannersProps): React.JSX.Element {
  if (props.stopped) {
    return (
      <div className="banner banner--stale" role="status">
        <span className="banner__text">
          <strong>服务已停止，显示停止前内容。</strong> 本页不会重连或自动启动服务；需要继续写入、导出或打开其他库时，请重新启动本库服务后再打开页面。
        </span>
      </div>
    );
  }
  return (
    <>
      {props.stale ? (
        <div className="banner banner--stale" role="status">
          <span className="banner__text">
            <strong>显示上一份有效内容。</strong> 图与详情来自同一份有效快照，可能不是最新写入结果。
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
