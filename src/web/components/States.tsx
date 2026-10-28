export function EmptyState(props: { topicCount: number; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="canvas-host__empty">
      <div className="state-block">
        <h3>工作区尚无卡片</h3>
        <p>服务返回了有效快照，但其中没有节点。这是一份空工作区，不是加载失败。</p>
        {props.topicCount > 0 ? <p>已发现 {String(props.topicCount)} 个主题，但没有可用节点；请查看诊断确认数据。</p> : null}
        <div className="state-block__actions">
          <button type="button" onClick={props.onRetry}>重新载入</button>
          <a href="/api/diagnostics" target="_blank" rel="noreferrer">查看诊断</a>
        </div>
      </div>
    </div>
  );
}
