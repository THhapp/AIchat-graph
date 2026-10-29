import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportEvent, GraphResponse, TopicExportStatus, WorkspaceResponse } from '../../next/protocol.js';
import { errorMessage, getJson } from './client.js';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'stopped';

export interface SnapshotState {
  /** Latest export status pushed by the service, keyed by topic id. */
  exportStatuses: Record<string, TopicExportStatus>;
  graph: GraphResponse | null;
  workspace: WorkspaceResponse | null;
  /** null while the first load is in flight. */
  error: Error | null;
  loading: boolean;
  connection: ConnectionState;
  /** The local service was stopped from this page; no reconnect is attempted. */
  stopped: boolean;
}

function isUsable(next: GraphResponse, current: GraphResponse | null): boolean {
  if (current === null) return true;
  if (next.instanceId !== current.instanceId) return true;
  return next.revision >= current.revision;
}

/**
 * Loads workspace + graph, follows SSE, and only applies responses from the current
 * instance with revision >= known. A failed load is surfaced as an error, never as
 * an empty graph.
 */
export function useSnapshot(): SnapshotState & { refresh: () => void; halt: () => void } {
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [stopped, setStopped] = useState(false);
  const [exportStatuses, setExportStatuses] = useState<Record<string, TopicExportStatus>>({});

  const graphRef = useRef<GraphResponse | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const queued = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Once the service is stopped on purpose, nothing may reconnect or refetch. */
  const halted = useRef(false);
  const eventSource = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    if (halted.current) return;
    if (inFlight.current !== null) {
      queued.current = true;
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const [nextWorkspace, nextGraph] = await Promise.all([
        getJson<WorkspaceResponse>('/api/workspace', controller.signal),
        getJson<GraphResponse>('/api/graph', controller.signal),
      ]);
      if (controller.signal.aborted || halted.current) return;
      if (isUsable(nextGraph, graphRef.current)) {
        graphRef.current = nextGraph;
        setGraph(nextGraph);
        setWorkspace(nextWorkspace);
      }
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted || halted.current) return;
      const nextError = cause instanceof Error ? cause : new Error(String(cause));
      // Keep an already-loaded graph while showing the failure; do not blank it.
      setError(nextError);
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      if (mounted.current) {
        setLoading(false);
      }
      if (queued.current && !halted.current) {
        queued.current = false;
        if (mounted.current) setTimeout(() => { void load(); }, 50);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    if (halted.current) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void load();
    }, 80);
  }, [load]);

  /**
   * Closes the event stream and forbids every future reconnect/refetch. The
   * loaded graph, workspace and detail stay in memory, so the reader can keep
   * showing the last content while the service is gone. A page reload starts a
   * fresh connection attempt, but this page never starts a service by itself.
   */
  const halt = useCallback(() => {
    if (halted.current) return;
    halted.current = true;
    queued.current = false;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    inFlight.current?.abort();
    inFlight.current = null;
    eventSource.current?.close();
    eventSource.current = null;
    setConnection('stopped');
    setStopped(true);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [load]);

  useEffect(() => {
    const source = new EventSource('/api/events');
    eventSource.current = source;
    // Any reopen (first connect or reconnect) re-reads the full graph: missed
    // events are never assumed to be recoverable individually.
    const onOpen = (): void => {
      if (halted.current) return;
      setConnection('open');
      void load();
    };
    const onSnapshot = (): void => {
      if (halted.current) return;
      refresh();
    };
    const onError = (): void => {
      // A deliberate stop closed the stream; it must never look like a reconnect.
      if (halted.current) return;
      setConnection(source.readyState === EventSource.CONNECTING ? 'reconnecting' : 'closed');
      // A closed stream can leave stale UI indefinitely; schedule a refetch so the
      // status bar can prove whether the service is really gone.
      if (source.readyState === EventSource.CLOSED) refresh();
    };
    // Export progress arrives as its own event: a target write can finish without a
    // new snapshot revision, so waiting for 'snapshot' would never refresh the panel.
    const onExport = (event: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(event.data) as ExportEvent;
        if (parsed.status === undefined || typeof parsed.status.topicId !== 'string') return;
        setExportStatuses((current) => ({ ...current, [parsed.status.topicId]: parsed.status }));
      } catch {
        // A malformed event must not break live reading; the panel can re-fetch.
      }
    };
    source.addEventListener('open', onOpen);
    source.addEventListener('snapshot', onSnapshot);
    source.addEventListener('diagnostics', onSnapshot);
    source.addEventListener('export', onExport as EventListener);
    source.addEventListener('error', onError);
    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('snapshot', onSnapshot);
      source.removeEventListener('diagnostics', onSnapshot);
      source.removeEventListener('export', onExport as EventListener);
      source.removeEventListener('error', onError);
      source.close();
      if (eventSource.current === source) eventSource.current = null;
    };
  }, [load, refresh]);

  return {
    exportStatuses,
    graph,
    workspace,
    error: error === null ? null : new Error(errorMessage(error)),
    loading,
    connection,
    stopped,
    refresh,
    halt,
  };
}
