import { useCallback, useEffect, useRef, useState } from 'react';
import type { TopicExportStatus } from '../../shared/protocol.js';
import { describeExportFreshness, exportStateLabel, fetchExportStatuses, retryExport, setExportTarget } from '../data/exports.js';
import { errorMessage } from '../data/client.js';

export interface ExportPanelProps {
  graphRevision: number;
  instanceId: string;
  /** Topic currently selected in the reader, if any. */
  focusedTopicId: string | null;
  /** Statuses pushed by the service's 'export' event, keyed by topic id. */
  liveStatuses?: Readonly<Record<string, TopicExportStatus>>;
  onClose: () => void;
}

type Pending = { kind: 'target'; topicId: string } | { kind: 'retry'; topicId: string } | null;

/**
 * Per-topic export target and status. Paths are typed in full and sent to the
 * service; nothing here triggers a browser download or writes a file.
 */
export function ExportPanel({ graphRevision, instanceId, focusedTopicId, liveStatuses, onClose }: ExportPanelProps): React.JSX.Element {
  const [statuses, setStatuses] = useState<TopicExportStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Record<string, string>>({});
  const abort = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const topics = await fetchExportStatuses(controller.signal);
      if (controller.signal.aborted) return;
      setStatuses(topics);
      setError(null);
      setDrafts((current) => {
        const next: Record<string, string> = {};
        for (const status of topics) {
          next[status.topicId] = current[status.topicId] ?? status.targetPath ?? '';
        }
        return next;
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { abort.current?.abort(); };
  }, [load, instanceId, graphRevision]);

  useEffect(() => { headingRef.current?.focus(); }, []);

  // Merge pushed statuses: writing/ready arrive without a graph revision change, so a
  // graph-only refresh would leave the badge stuck on its previous state.
  useEffect(() => {
    if (liveStatuses === undefined) return;
    const entries = Object.values(liveStatuses);
    if (entries.length === 0) return;
    setStatuses((current) => {
      if (current === null) return current;
      return current.map((status) => liveStatuses[status.topicId] ?? status);
    });
  }, [liveStatuses]);

  const submitTarget = useCallback(async (topicId: string) => {
    const value = (drafts[topicId] ?? '').trim();
    const controller = new AbortController();
    setPending({ kind: 'target', topicId });
    try {
      const updated = await setExportTarget(topicId, value === '' ? null : value, controller.signal);
      setStatuses((current) => current === null ? current : current.map((s) => (s.topicId === topicId ? updated : s)));
      setNotice((current) => ({ ...current, [topicId]: value === '' ? '已取消绑定；已有成品不会删除。' : '已保存目标，服务将生成当前版本。' }));
      setError(null);
    } catch (cause) {
      setNotice((current) => ({ ...current, [topicId]: '' }));
      setError(errorMessage(cause));
    } finally {
      setPending((current) => (current?.topicId === topicId ? null : current));
    }
  }, [drafts]);

  const doRetry = useCallback(async (topicId: string) => {
    const controller = new AbortController();
    setPending({ kind: 'retry', topicId });
    try {
      const updated = await retryExport(topicId, controller.signal);
      setStatuses((current) => current === null ? current : current.map((s) => (s.topicId === topicId ? updated : s)));
      setNotice((current) => ({ ...current, [topicId]: '已重新排队。' }));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending((current) => (current?.topicId === topicId ? null : current));
    }
  }, []);

  const ordered = statuses === null ? null : [...statuses].sort((a, b) => {
    if (a.topicId === focusedTopicId) return -1;
    if (b.topicId === focusedTopicId) return 1;
    return a.topicTitle.localeCompare(b.topicTitle, 'zh-CN');
  });

  return (
    <section className="export-panel" id="export-panel" aria-labelledby="export-title">
      <div className="panel__head">
        <h2 className="panel__title" id="export-title" ref={headingRef} tabIndex={-1}>主题独立 HTML 导出</h2>
        <button type="button" className="panel__close" onClick={onClose} aria-label="收起导出设置" title="收起">×</button>
      </div>
      <div className="export-panel__hint">
        填写本机 .html 的完整绝对路径后保存。服务会写入该文件；此页不下载、不写盘。
        目标需不存在或属于同一主题，父目录必须已存在。
      </div>
      {error !== null ? (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">{error}</span>
          <button type="button" onClick={() => { void load(); }}>重试</button>
        </div>
      ) : null}
      <div className="export-panel__body">
        {ordered === null ? (
          <p className="sidebar__placeholder"><span className="spinner" /> 正在读取导出状态…</p>
        ) : ordered.length === 0 ? (
          <p className="sidebar__placeholder">没有可导出的主题。</p>
        ) : (
          <ul className="export-list">
            {ordered.map((status) => {
              const busy = pending?.topicId === status.topicId;
              const draft = drafts[status.topicId] ?? '';
              const dirty = draft.trim() !== (status.targetPath ?? '');
              return (
                <li key={status.topicId} className="export-item" data-state={status.state} data-focused={status.topicId === focusedTopicId ? 'true' : 'false'}>
                  <div className="export-item__head">
                    <h3 className="export-item__title">{status.topicTitle}</h3>
                    <span className="export-badge" data-state={status.state}>{exportStateLabel(status)}</span>
                  </div>
                  <p className="export-item__freshness">{describeExportFreshness(status)}</p>
                  <label className="export-item__label" htmlFor={'export-target-' + status.topicId}>
                    完整绝对路径（.html）
                  </label>
                  <div className="export-item__input-row">
                    <input
                      id={'export-target-' + status.topicId}
                      className="export-item__input"
                      type="text"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="例如 C:\Users\你\Documents\主题.html"
                      value={draft}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDrafts((current) => ({ ...current, [status.topicId]: value }));
                      }}
                    />
                    <button
                      type="button"
                      disabled={busy || !dirty}
                      onClick={() => { void submitTarget(status.topicId); }}
                    >
                      {busy ? '保存中…' : status.targetPath === null ? '保存目标' : draft.trim() === '' ? '取消绑定' : '更改位置'}
                    </button>
                  </div>
                  <div className="export-item__meta">
                    <span>源 {status.sourceFingerprint === null ? '—' : status.sourceFingerprint.slice(0, 8)}</span>
                    <span>成品 {status.exportedFingerprint === null ? '—' : status.exportedFingerprint.slice(0, 8)}</span>
                    <span>{status.lastSuccessAt !== null ? '更新于 ' + status.lastSuccessAt : '尚无成功记录'}</span>
                  </div>
                  {status.targetPath !== null ? (
                    <p className="export-item__target" title={status.targetPath}>
                      {status.targetPresent ? '文件存在' : '文件当前不存在'}：{status.targetPath}
                    </p>
                  ) : null}
                  {status.error !== null ? (
                    <p className="export-item__error" role="alert">{status.error}</p>
                  ) : null}
                  {status.resourceDiagnostics.length > 0 ? (
                    <ul className="export-item__resources">
                      {status.resourceDiagnostics.map((d, index) => (
                        <li key={d.code + String(index)}>{d.message}</li>
                      ))}
                    </ul>
                  ) : null}
                  {notice[status.topicId] !== undefined && notice[status.topicId] !== '' ? (
                    <p className="export-item__notice" role="status">{notice[status.topicId]}</p>
                  ) : null}
                  {status.targetPath !== null ? (
                    <button type="button" disabled={busy} onClick={() => { void doRetry(status.topicId); }}>
                      {busy ? '处理中…' : '重新生成'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}