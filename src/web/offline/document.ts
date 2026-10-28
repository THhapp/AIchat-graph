import type { Diagnostic, GraphNode, GraphResponse, OfflineTopicDocument } from '../../next/protocol.js';
import { isRecord } from '../../shared/guards.js';

/**
 * Reads the frozen document from the inert JSON block the exporter writes.
 * No fetch, no EventSource: the HTML is self-contained.
 */
export const EXPORT_DATA_ID = 'aichat-export-data';

export class OfflineDocumentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfflineDocumentError';
    this.code = code;
  }
}

/** Validates the parts this reader actually consumes; never silently invents content. */
export function parseOfflineDocument(raw: unknown): OfflineTopicDocument {
  if (!isRecord(raw)) throw new OfflineDocumentError('BAD_DOCUMENT', '导出的主题数据不是对象');
  if (raw['format'] !== 1) throw new OfflineDocumentError('UNSUPPORTED_FORMAT', '不支持的导出格式版本');
  const topic = raw['topic'];
  if (!isRecord(topic) || typeof topic['id'] !== 'string' || typeof topic['key'] !== 'string') {
    throw new OfflineDocumentError('BAD_TOPIC', '导出数据缺少主题信息');
  }
  if (!Array.isArray(raw['nodes'])) throw new OfflineDocumentError('BAD_NODES', '导出数据缺少节点列表');
  for (const node of raw['nodes']) {
    if (!isRecord(node) || typeof node['id'] !== 'string' || typeof node['body'] !== 'string') {
      throw new OfflineDocumentError('BAD_NODE', '导出数据中的节点缺少 id 或正文');
    }
  }
  if (typeof raw['instanceId'] !== 'string' || typeof raw['workspaceId'] !== 'string' || typeof raw['revision'] !== 'number') {
    throw new OfflineDocumentError('BAD_VERSION', '导出数据缺少快照版本信息');
  }
  return raw as unknown as OfflineTopicDocument;
}

export function readEmbeddedDocument(doc: Document): OfflineTopicDocument {
  const element = doc.getElementById(EXPORT_DATA_ID);
  if (element === null) {
    throw new OfflineDocumentError('NO_DATA', '找不到内嵌数据块 #' + EXPORT_DATA_ID);
  }
  const text = element.textContent ?? '';
  if (text.trim().length === 0) {
    throw new OfflineDocumentError('EMPTY_DATA', '内嵌数据块为空');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new OfflineDocumentError('BAD_JSON', '内嵌数据不是合法 JSON');
  }
  return parseOfflineDocument(parsed);
}

/** Project one frozen node into the display-only graph row (body stays in the detail). */
function offlineGraphNode(node: OfflineTopicDocument['nodes'][number]): GraphNode {
  const important = node.important === true;
  return {
    id: node.id,
    topicId: node.topicId,
    title: node.title,
    summary: node.summary,
    number: node.number,
    from: node.from,
    flow: node.flow,
    state: node.state,
    ...(node.side !== undefined ? { side: node.side } : {}),
    ...(node.order !== undefined ? { order: node.order } : {}),
    important,
    ...(node.description !== undefined ? { description: node.description } : {}),
    revision: node.revision,
  };
}

/**
 * Builds the same GraphResponse the live reader uses, so viewmodel, layout and
 * search behave identically offline. Boundary nodes are kept for context and are
 * intentionally not placed in the graph (they belong to another topic).
 */
export function toGraphResponse(doc: OfflineTopicDocument): GraphResponse {
  const diagnostics: Diagnostic[] = [
    ...(Array.isArray(doc.resourceDiagnostics) ? doc.resourceDiagnostics : []),
  ];
  return {
    instanceId: doc.instanceId,
    revision: doc.revision,
    workspaceId: doc.workspaceId,
    activeNode: null,
    stale: false,
    diagnostics,
    nodes: doc.nodes.map(offlineGraphNode),
    topics: [doc.topic],
  };
}

export function bodyById(doc: OfflineTopicDocument): Map<string, string> {
  return new Map(doc.nodes.map((node) => [node.id, node.body]));
}
