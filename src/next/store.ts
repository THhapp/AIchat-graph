/**
 * SQLite boundary for the discussion graph. One implementation, no ORM/plugin layer.
 * The whole small state is loaded and written inside one transaction; no file mirror.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DomainError,
  applyNodePatch,
  checkSelector,
  contentChanged,
  derivedSummary,
  findNode,
  findTopic,
  newTopicId,
  newNodeId,
  normalizeCreate,
  projectSnapshot,
  publicNode,
  topicKeyFromTitle,
  type NodeRecord,
  type NodeView,
  type Snapshot,
  type TopicRecord,
  type TopicView,
  type WorkspaceRecord,
} from './model.js';
import type {
  AgentChangeRequest,
  AgentChangeResponse,
  AgentCheckResponse,
  AgentChangeAction,
  AgentBatchOp,
  AgentCreateOp,
  AgentDeleteOp,
  AgentEditOp,
  NodePatch,
  NodeSelector,
  LocalSelector,
  ExistingSelector,
  NodeCreate,
  ChangeStatusResponse,
} from './protocol.js';

export const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const DB_FILE = 'graph.sqlite';

interface State {
  workspace: WorkspaceRecord;
  topics: TopicRecord[];
  nodes: NodeRecord[];
}

export interface OpenOptions { readonly readonly?: boolean }

export class GraphStore {
  readonly root: string;
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly instanceId: string;

  private constructor(root: string, db: DatabaseSync, instanceId: string) {
    this.root = root;
    this.dbPath = path.join(root, DB_FILE);
    this.db = db;
    this.instanceId = instanceId;
  }

  static create(root: string, name: string, instanceId = ''): GraphStore {
    const dbPath = path.join(root, DB_FILE);
    if (existsSync(dbPath)) throw new DomainError('WORKSPACE_EXISTS', '该工作区已有 graph.sqlite，拒绝覆盖', 409);
    mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(dbPath);
    configure(db);
    createSchema(db);
    const workspaceId = 'w_' + randomHex(32);
    db.prepare('INSERT INTO workspace(id,name,active_node,revision) VALUES(?,?,?,?)').run(
      workspaceId, name.trim() || '未命名讨论库', null, 1,
    );
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schemaVersion', String(SCHEMA_VERSION));
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('createdAt', new Date().toISOString());
    return new GraphStore(root, db, instanceId);
  }

  static open(root: string, options: OpenOptions & { instanceId?: string } = {}): GraphStore {
    const dbPath = path.join(root, DB_FILE);
    if (!existsSync(dbPath)) throw new DomainError('WORKSPACE_NOT_FOUND', '工作区没有 graph.sqlite：' + root, 404);
    const db = new DatabaseSync(dbPath, { readOnly: options.readonly === true });
    try {
      configure(db, options.readonly === true);
      const version = Number((db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as any)?.value);
      if (version === LEGACY_SCHEMA_VERSION) {
        // 旧库只读时按 v1 结构直接读取，不升级、不写库；下一次可写打开再迁移。
        if (options.readonly !== true) upgradeLegacySchema(db);
      } else if (version !== SCHEMA_VERSION) {
        throw new DomainError('DB_SCHEMA_UNSUPPORTED', '不支持的数据库 schema 版本：' + String(version), 422);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new GraphStore(root, db, options.instanceId ?? '');
  }

  /** One-time import path: replace an empty new DB with a validated full state. */
  importState(input: { workspace: WorkspaceRecord; topics: TopicRecord[]; nodes: NodeRecord[] }): Snapshot {
    const snapshot = projectSnapshot(input.workspace, input.topics, input.nodes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM topics');
      this.db.prepare('UPDATE workspace SET id=?,name=?,active_node=?,revision=? WHERE rowid=(SELECT rowid FROM workspace LIMIT 1)').run(
        input.workspace.id, input.workspace.name, input.workspace.activeNode, input.workspace.revision,
      );
      this.persist(input);
      this.db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schemaVersion');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
    return snapshot;
  }


  /** 一次性导入专用：工作区为空时全量重建；正常 commit 只走 persistDiff。 */
  private persist(state: State): void {
    this.db.exec('DELETE FROM nodes');
    this.db.exec('DELETE FROM topics');
    const insertTopic = this.db.prepare(
      'INSERT INTO topics(id,key,title,revision,last_change_at,last_change_ids) VALUES(?,?,?,?,?,?)',
    );
    for (const topic of state.topics) {
      insertTopic.run(topic.id, topic.key, topic.title, topic.revision, topic.lastChangeAt, JSON.stringify(topic.lastChangeIds));
    }
    const insertNode = this.db.prepare(
      'INSERT INTO nodes(id,topic_id,title,body,summary,from_id,flow,description,side,ord,important,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const node of state.nodes) {
      insertNode.run(node.id, node.topicId, node.title, node.body, node.summary, node.from,
        node.flow, node.description, node.side, node.order, node.important ? 1 : 0, node.revision);
    }
    this.db.prepare('UPDATE workspace SET active_node=?,revision=? WHERE id=?').run(
      state.workspace.activeNode, state.workspace.revision, state.workspace.id,
    );
  }

  close(): void { this.db.close(); }

  load(): State {
    const workspaceRow = this.db.prepare('SELECT * FROM workspace LIMIT 1').get() as any;
    if (!workspaceRow) throw new DomainError('WORKSPACE_INVALID', '数据库没有 workspace 记录', 422);
    const topics = this.db.prepare('SELECT * FROM topics ORDER BY id').all() as any[];
    const nodes = this.db.prepare('SELECT * FROM nodes ORDER BY topic_id,id').all() as any[];
    return {
      workspace: { id: workspaceRow.id, name: workspaceRow.name, activeNode: workspaceRow.active_node, revision: workspaceRow.revision },
      topics: topics.map((row) => ({
        id: row.id, key: row.key, title: row.title, revision: row.revision,
        lastChangeAt: row.last_change_at ?? null,
        lastChangeIds: parseIds(row.last_change_ids),
      })),
      nodes: nodes.map(nodeRow),
    };
  }

  snapshot(): Snapshot { const state = this.load(); return projectSnapshot(state.workspace, state.topics, state.nodes); }

  getRequest(requestId: string): { bodyHash: string; response: AgentChangeResponse | AgentCheckResponse; createdAt: string } | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE request_id=?').get(requestId) as any;
    if (!row) return null;
    try { return { bodyHash: row.body_hash, response: JSON.parse(row.response_json), createdAt: row.created_at }; }
    catch { return null; }
  }

  status(requestId: string): ChangeStatusResponse {
    const row = this.db.prepare('SELECT * FROM requests WHERE request_id=?').get(requestId) as any;
    if (!row) return { ok: true, requestId, status: 'unknown', httpStatus: null, state: 'unknown', recordedAt: null, source: 'unknown' };
    const state = String(row.state ?? 'committed');
    return {
      ok: true, requestId, status: state === 'noop' ? 'noop' : state === 'checked' ? 'unknown' : 'committed',
      httpStatus: row.http_status ?? null, state, recordedAt: row.created_at ?? null, source: 'database',
    };
  }

  commit(request: AgentChangeRequest, bodyHash: string): AgentChangeResponse | AgentCheckResponse {
    const existing = this.getRequest(request.requestId);
    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        throw new DomainError('REQUEST_CONFLICT', '同一 requestId 已用于不同请求体', 409, { requestId: request.requestId });
      }
      const stored = existing.response as AgentChangeResponse;
      // 旧的幂等记录可能早于 nodeRevisions 字段；缺省给空映射，避免伪造版本。
      return { ...stored, nodeRevisions: stored.nodeRevisions ?? {}, replayed: true };
    }
    const dryRun = request.dryRun === true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.load();
      const candidate: State = {
        workspace: { ...before.workspace },
        topics: before.topics.map((topic) => ({ ...topic, lastChangeIds: [...topic.lastChangeIds] })),
        nodes: before.nodes.map((node) => ({ ...node })),
      };
      const context = new CommitContext(candidate, request.action);
      const outcome = context.apply();
      // 以 before/candidate 的最终字段差异为准：同一动作里改回原值、rearrange 无差异
      // 都必须是 noop；不能只相信操作意图列表。
      const diff = diffNodes(before.nodes, candidate.nodes);
      const hasChanges =
        diff.created.length > 0 ||
        diff.updated.length > 0 ||
        diff.deleted.length > 0 ||
        candidate.workspace.activeNode !== before.workspace.activeNode;
      // 无论 noop 还是 dry-run 都先做完整图校验；失败整体回滚。
      projectSnapshot(candidate.workspace, candidate.topics, candidate.nodes);
      if (dryRun) {
        const response: AgentCheckResponse = {
          ok: true, command: request.action.action, dryRun: true, state: 'checked',
          requestId: request.requestId, workspaceId: before.workspace.id,
          topicId: outcome.primaryTopicId, summary: outcome.summary,
          diagnostics: [], changes: changesOf(diff),
        };
        this.db.exec('ROLLBACK');
        return response;
      }
      if (!hasChanges) {
        const response: AgentChangeResponse = {
          ok: true, requestId: request.requestId, action: request.action.action,
          workspaceId: before.workspace.id, topicId: outcome.primaryTopicId,
          state: 'noop',
          created: { topicId: outcome.createdTopicId, nodeIds: outcome.createdNodeIds, aliases: outcome.aliases },
          changedNodeIds: [],
          // noop 也给动作明确操作且仍存在目标的实际版本。
          nodeRevisions: revisionsOf(request.action, diff, before.nodes),
          summary: '无实际变化',
          diagnostics: [], revision: before.workspace.revision,
          instanceId: this.instanceId,
        };
        this.finishRequest(request.requestId, bodyHash, 'noop', response);
        return response;
      }
      this.applyRevisions(before, candidate, diff);
      this.persistDiff(before, candidate);
      const response: AgentChangeResponse = {
        ok: true, requestId: request.requestId, action: request.action.action,
        workspaceId: before.workspace.id, topicId: outcome.primaryTopicId,
        state: 'committed',
        created: { topicId: outcome.createdTopicId, nodeIds: outcome.createdNodeIds, aliases: outcome.aliases },
        changedNodeIds: [...diff.created, ...diff.updated, ...diff.deleted].map((node) => node.id),
        nodeRevisions: revisionsOf(request.action, diff, candidate.nodes),
        summary: outcome.summary,
        diagnostics: [], revision: candidate.workspace.revision,
        instanceId: this.instanceId,
      };
      this.finishRequest(request.requestId, bodyHash, 'committed', response);
      return response;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  }

  /** 幂等结果与提交在同一事务内写入。 */
  private finishRequest(
    requestId: string,
    bodyHash: string,
    state: 'committed' | 'noop',
    response: AgentChangeResponse,
  ): void {
    this.db.prepare(
      'INSERT INTO requests(request_id,body_hash,http_status,state,response_json,created_at) VALUES(?,?,?,?,?,?)',
    ).run(requestId, bodyHash, 200, state, JSON.stringify(response), new Date().toISOString());
    trimRequests(this.db);
    this.db.exec('COMMIT');
  }

  /**
   * 只为前后最终字段有差异的节点递增持久 revision、更新主题 lastChange 与 topic revision，
   * 并递增 workspace revision。created/updated/deleted 由调用方按真实差异给出。
   */
  private applyRevisions(before: State, candidate: State, diff: NodeDiff): void {
    const now = new Date().toISOString();
    const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
    const updated = new Set(diff.updated.map((node) => node.id));
    const contentByTopic = new Map<string, string[]>();
    for (const node of candidate.nodes) {
      const old = beforeNodes.get(node.id);
      if (old === undefined) {
        node.revision = 1;
        pushTopic(contentByTopic, node.topicId, node.id);
      } else if (updated.has(node.id)) {
        node.revision = old.revision + 1;
        if (contentChanged(old, node)) pushTopic(contentByTopic, node.topicId, node.id);
      }
    }
    for (const [topicId, ids] of contentByTopic) {
      const topic = candidate.topics.find((entry) => entry.id === topicId);
      if (topic === undefined) continue;
      topic.lastChangeAt = now;
      topic.lastChangeIds = [...new Set(ids)].filter((id) => candidate.nodes.some((node) => node.id === id));
    }
    for (const node of diff.deleted) {
      for (const topic of candidate.topics) {
        topic.lastChangeIds = topic.lastChangeIds.filter((id) => id !== node.id);
      }
    }
    const changedTopics = new Set<string>();
    for (const node of diff.created) {
      const found = candidate.nodes.find((entry) => entry.id === node.id);
      if (found) changedTopics.add(found.topicId);
    }
    for (const node of diff.updated) {
      const found = candidate.nodes.find((entry) => entry.id === node.id);
      if (found) changedTopics.add(found.topicId);
    }
    for (const node of diff.deleted) changedTopics.add(node.topicId);
    for (const topicId of changedTopics) {
      const topic = candidate.topics.find((entry) => entry.id === topicId);
      const old = before.topics.find((entry) => entry.id === topicId);
      // 本事务新建的主题保持 revision 1；已有主题才递增。
      if (topic && old) topic.revision = old.revision + 1;
    }
    candidate.workspace.revision = before.workspace.revision + 1;
    candidate.workspace.activeNode = before.workspace.activeNode;
  }

  /**
   * 按 before/candidate 最终值差异写库：新行 INSERT、真实改变 UPDATE、缺失行 DELETE。
   * 未改变的主题/节点不写；workspace 只在 revision/activeNode/name 改变时更新。
   * importState 仍使用一次性全量 persist。
   */
  private persistDiff(before: State, candidate: State): void {
    const beforeTopics = new Map(before.topics.map((topic) => [topic.id, topic] as const));
    const candidateTopics = new Map(candidate.topics.map((topic) => [topic.id, topic] as const));
    const beforeNodes = new Map(before.nodes.map((node) => [node.id, node] as const));
    const candidateNodes = new Map(candidate.nodes.map((node) => [node.id, node] as const));

    const insertTopic = this.db.prepare(
      'INSERT INTO topics(id,key,title,revision,last_change_at,last_change_ids) VALUES(?,?,?,?,?,?)',
    );
    const updateTopic = this.db.prepare(
      'UPDATE topics SET key=?,title=?,revision=?,last_change_at=?,last_change_ids=? WHERE id=?',
    );
    for (const topic of candidate.topics) {
      const old = beforeTopics.get(topic.id);
      const lastChangeIds = JSON.stringify(topic.lastChangeIds);
      if (old === undefined) {
        insertTopic.run(topic.id, topic.key, topic.title, topic.revision, topic.lastChangeAt, lastChangeIds);
      } else if (!topicRowsEqual(old, topic)) {
        updateTopic.run(topic.key, topic.title, topic.revision, topic.lastChangeAt, lastChangeIds, topic.id);
      }
    }

    const deleteNode = this.db.prepare('DELETE FROM nodes WHERE id=?');
    for (const node of before.nodes) {
      if (!candidateNodes.has(node.id)) deleteNode.run(node.id);
    }
    const insertNode = this.db.prepare(
      'INSERT INTO nodes(id,topic_id,title,body,summary,from_id,flow,description,side,ord,important,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const updateNode = this.db.prepare(
      'UPDATE nodes SET topic_id=?,title=?,body=?,summary=?,from_id=?,flow=?,description=?,side=?,ord=?,important=?,revision=? WHERE id=?',
    );
    for (const node of candidate.nodes) {
      const old = beforeNodes.get(node.id);
      if (old === undefined) {
        insertNode.run(node.id, node.topicId, node.title, node.body, node.summary, node.from,
          node.flow, node.description, node.side, node.order, node.important ? 1 : 0, node.revision);
      } else if (!nodeRowsEqual(old, node)) {
        updateNode.run(node.topicId, node.title, node.body, node.summary, node.from,
          node.flow, node.description, node.side, node.order, node.important ? 1 : 0, node.revision, node.id);
      }
    }

    const deleteTopic = this.db.prepare('DELETE FROM topics WHERE id=?');
    for (const topic of before.topics) {
      if (!candidateTopics.has(topic.id)) deleteTopic.run(topic.id);
    }

    const beforeWorkspace = before.workspace;
    const afterWorkspace = candidate.workspace;
    if (
      beforeWorkspace.name !== afterWorkspace.name ||
      beforeWorkspace.activeNode !== afterWorkspace.activeNode ||
      beforeWorkspace.revision !== afterWorkspace.revision
    ) {
      this.db.prepare('UPDATE workspace SET name=?,active_node=?,revision=? WHERE id=?').run(
        afterWorkspace.name,
        afterWorkspace.activeNode,
        afterWorkspace.revision,
        afterWorkspace.id,
      );
    }
  }
}

interface NodeDiff {
  readonly created: NodeRecord[];
  readonly updated: NodeRecord[];
  readonly deleted: NodeRecord[];
}

/** 节点最终字段差异（忽略 revision 本身；revision 由 applyRevisions 递增）。 */
function nodeFieldsEqual(left: NodeRecord, right: NodeRecord): boolean {
  return left.id === right.id &&
    left.topicId === right.topicId &&
    left.title === right.title &&
    left.body === right.body &&
    left.summary === right.summary &&
    left.from === right.from &&
    left.flow === right.flow &&
    left.description === right.description &&
    left.side === right.side &&
    left.order === right.order &&
    left.important === right.important;
}

/** 行级相等：写库前的最终值比较（含 revision）。 */
function nodeRowsEqual(left: NodeRecord, right: NodeRecord): boolean {
  return nodeFieldsEqual(left, right) && left.revision === right.revision;
}

function topicRowsEqual(left: TopicRecord, right: TopicRecord): boolean {
  return left.id === right.id &&
    left.key === right.key &&
    left.title === right.title &&
    left.revision === right.revision &&
    left.lastChangeAt === right.lastChangeAt &&
    left.lastChangeIds.join('\u0000') === right.lastChangeIds.join('\u0000');
}

function diffNodes(before: readonly NodeRecord[], candidate: readonly NodeRecord[]): NodeDiff {
  const beforeById = new Map(before.map((node) => [node.id, node] as const));
  const candidateById = new Map(candidate.map((node) => [node.id, node] as const));
  const created: NodeRecord[] = [];
  const updated: NodeRecord[] = [];
  const deleted: NodeRecord[] = [];
  for (const node of candidate) {
    const old = beforeById.get(node.id);
    if (old === undefined) created.push(node);
    else if (!nodeFieldsEqual(old, node)) updated.push(node);
  }
  for (const node of before) {
    if (!candidateById.has(node.id)) deleted.push(node);
  }
  return { created, updated, deleted };
}

function changesOf(diff: NodeDiff): AgentCheckResponse['changes'] {
  return [
    ...diff.created.map((node) => ({ nodeId: node.id, kind: 'create' as const })),
    ...diff.updated.map((node) => ({ nodeId: node.id, kind: 'update' as const })),
    ...diff.deleted.map((node) => ({ nodeId: node.id, kind: 'delete' as const })),
  ];
}

/** 动作明确操作过的已有节点（不含来源、precondition、delete 被删后自然省略）。 */
function explicitTargetIds(action: AgentChangeAction): string[] {
  switch (action.action) {
    case 'batch':
      return action.ops.flatMap((op) =>
        op.op === 'edit' ? [op.target.id] : op.op === 'delete' ? [op.target.id] : [],
      );
    case 'insert':
      return [action.before.id];
    case 'rearrange':
      return action.edits.map((edit) => edit.target.id);
    case 'setImportance':
      return [action.nodeId];
    case 'delete':
      return [action.target.id];
    case 'createTopic':
    case 'createNext':
    case 'createBranch':
      return [];
    default:
      return [];
  }
}

/**
 * nodeRevisions：新建、真实修改、动作明确操作且仍存在的节点 → 最终持久 revision。
 * 删除的节点不出现；noop 时传入 before 节点即可得到目标实际版本。
 */
function revisionsOf(
  action: AgentChangeAction,
  diff: NodeDiff,
  candidateNodes: readonly NodeRecord[],
): Record<string, number> {
  const candidateById = new Map(candidateNodes.map((node) => [node.id, node] as const));
  const revisions: Record<string, number> = {};
  for (const node of [...diff.created, ...diff.updated]) {
    const found = candidateById.get(node.id);
    if (found !== undefined) revisions[node.id] = found.revision;
  }
  for (const nodeId of explicitTargetIds(action)) {
    const found = candidateById.get(nodeId);
    if (found !== undefined) revisions[nodeId] = found.revision;
  }
  for (const node of diff.deleted) delete revisions[node.id];
  return revisions;
}

class CommitContext {
  readonly state: State;
  readonly action: AgentChangeAction;
  readonly aliases: Record<string, string> = {};
  readonly createdNodeIds: string[] = [];
  readonly deletedNodeIds: string[] = [];
  readonly changed: AgentCheckResponse['changes'] = [];
  readonly localIds = new Map<string, string>();
  primaryTopicId: string | null = null;
  createdTopicId: string | null = null;
  summary = '';

  constructor(state: State, action: AgentChangeAction) { this.state = state; this.action = action; }

  apply(): CommitOutcome {
    switch (this.action.action) {
      case 'batch': this.applyBatch(this.action.topicId, this.action.ops); break;
      case 'insert': this.applyInsert(this.action); break;
      case 'rearrange': this.applyRearrange(this.action.edits); break;
      case 'setImportance': this.applyImportance(this.action.nodeId, this.action.important, this.action.revision); break;
      case 'createTopic': this.applyCreateTopic(this.action.topicTitle, this.action.key, this.action.node); break;
      case 'createNext':
      case 'createBranch': this.applyCreateFrom(this.action.from, this.action.action === 'createNext' ? 'next' : 'branch', this.action.description, this.action.node); break;
      case 'delete': this.applyDelete(this.action.target); break;
      default: throw new DomainError('UNKNOWN_ACTION', '不支持的 action');
    }
    this.finishOrders();
    const topicIds = new Set(this.state.nodes.map((node) => node.topicId));
    const primary = this.primaryTopicId ?? (topicIds.size === 1 ? [...topicIds][0] ?? null : null);
    this.primaryTopicId = primary;
    return { primaryTopicId: primary, createdTopicId: this.createdTopicId, createdNodeIds: this.createdNodeIds, deletedNodeIds: this.deletedNodeIds, changedNodeIds: [...new Set(this.changed.map((item) => item.nodeId))], aliases: this.aliases, changes: this.changed, summary: this.summary || this.describe() };
  }

  private describe(): string {
    if (this.changed.length === 0) return '无实际变化';
    const counts: Record<string, number> = {};
    for (const item of this.changed) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return Object.entries(counts).map(([kind, count]) => count + ' ' + kind).join('，');
  }

  private view(): Snapshot { return projectSnapshot(this.state.workspace, this.state.topics, this.state.nodes); }

  private topic(topicId: string): TopicView {
    const topic = this.state.topics.find((entry) => entry.id === topicId);
    if (!topic) throw new DomainError('TOPIC_NOT_FOUND', '找不到主题 ' + topicId, 404);
    return { ...topic, nodeIds: this.state.nodes.filter((node) => node.topicId === topicId).map((node) => node.id) };
  }

  private applyBatch(topicId: string, ops: readonly AgentBatchOp[]): void {
    if (!this.topic(topicId)) return;
    this.primaryTopicId = topicId;
    for (const op of ops) {
      if (op.op === 'create') this.prepareCreate(topicId, op);
    }
    const pending = ops.filter((op): op is AgentCreateOp => op.op === 'create');
    while (pending.length > 0) {
      const ready = pending.filter((op) => {
        const local = isLocalSelector(op.from) ? op.from.local : null;
        return local === null || this.state.nodes.some((node) => node.id === this.localIds.get(local));
      });
      if (ready.length === 0) throw new DomainError('INVALID_BATCH_INPUT', 'create 的局部依赖形成环');
      for (const op of ready) {
        this.createFrom(topicId, op);
        pending.splice(pending.indexOf(op), 1);
      }
    }
    for (const op of ops) {
      if (op.op === 'edit') this.applyEdit(topicId, op);
      else if (op.op === 'delete') this.applyDeleteInTopic(topicId, op);
    }
  }

  private prepareCreate(topicId: string, op: AgentCreateOp): void {
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]+$/.test(op.as) || op.as.length === 0 || op.as.length > 80) {
      throw new DomainError('INVALID_BATCH_INPUT', 'create.as 必须是简短的非空局部名称');
    }
    if (this.localIds.has(op.as)) throw new DomainError('INVALID_BATCH_INPUT', 'create.as 重复：' + op.as);
    const id = newNodeId();
    this.localIds.set(op.as, id);
    this.aliases[op.as] = id;
    this.createdNodeIds.push(id);
  }

  private resolveSelector(topicId: string, selector: NodeSelector): NodeView | null {
    if ('local' in selector) {
      const id = this.localIds.get(selector.local);
      if (!id) throw new DomainError('INVALID_BATCH_INPUT', 'local 指向本批未创建节点：' + selector.local);
      const node = this.state.nodes.find((entry) => entry.id === id);
      if (!node) throw new DomainError('INVALID_BATCH_INPUT', 'local 节点尚未创建：' + selector.local);
      return this.view().nodes.find((entry) => entry.id === id) ?? null;
    }
    const view = this.view();
    const node = checkSelector(view, selector);
    if (node.topicId !== topicId) throw new DomainError('NODE_CROSS_TOPIC', '目标不属于本批主题');
    return node;
  }

  private applyEdit(topicId: string, op: AgentEditOp): void {
    const view = this.view();
    const before = checkSelector(view, op.target);
    if (before.topicId !== topicId) throw new DomainError('NODE_CROSS_TOPIC', '目标不属于本批主题');
    if (this.changed.some((item) => item.nodeId === before.id && item.kind !== 'create')) {
      throw new DomainError('INVALID_BATCH_INPUT', '同一节点只能 edit 一次：' + before.id);
    }
    const after = applyNodePatch(before, op.patch, (selector) => checkSelector(view, selector));
    this.replaceNode(before.id, after);
    if (contentChanged(before, after) || after.important !== before.important) {
      this.changed.push({ nodeId: before.id, kind: 'update' });
    }
  }

  private applyDeleteInTopic(topicId: string, op: AgentDeleteOp): void {
    const view = this.view();
    const target = checkSelector(view, op.target);
    if (target.topicId !== topicId) throw new DomainError('NODE_CROSS_TOPIC', '目标不属于本批主题');
    this.deleteNode(target);
  }

  private createFrom(topicId: string, op: AgentCreateOp): void {
    const view = this.view();
    const id = this.localIds.get(op.as) as string;
    const local = isLocalSelector(op.from) ? op.from.local : null;
    const source = local !== null
      ? this.state.nodes.find((entry) => entry.id === (this.localIds.get(local) as string))
      : checkSelector(view, op.from as ExistingSelector);
    if (!source) throw new DomainError('INVALID_BATCH_INPUT', 'create 来源不存在');
    if (source.topicId !== topicId) throw new DomainError('NODE_CROSS_TOPIC', 'create 来源不能跨主题');
    if (op.flow === 'next') {
      const occupied = this.state.nodes.find((node) => node.from === source.id && node.flow === 'next' && node.id !== id);
      if (occupied) throw new DomainError('OPERATION_CONFLICT', '来源已有 next 后继，不能隐式挤掉：' + occupied.id, 409, { sourceId: source.id, nextId: occupied.id });
    }
    const input = normalizeCreate(op.node, topicId);
    const node: NodeRecord = {
      ...input, id, from: source.id, flow: op.flow,
      description: op.description.trim(), side: op.flow === 'branch' ? input.side : null, order: op.flow === 'branch' ? input.order : null,
      revision: 1,
    };
    if (!node.description) throw new DomainError('INVALID_BATCH_INPUT', 'create.description 不能为空');
    this.state.nodes.push(node);
    this.changed.push({ nodeId: id, kind: 'create' });
  }

  private applyInsert(action: AgentChangeRequest['action'] & { action: 'insert' }): void {
    const view = this.view();
    const after = checkSelector(view, action.after);
    const before = checkSelector(view, action.before);
    if (after.topicId !== before.topicId) throw new DomainError('NODE_CROSS_TOPIC', 'insert 两端不属于同一主题');
    if (after.nextId !== before.id) throw new DomainError('OPERATION_CONFLICT', 'insert 只接受当前真实相邻 next', 409, { afterId: after.id, beforeId: before.id, actualNext: after.nextId });
    const id = newNodeId();
    const input = normalizeCreate(action.node, after.topicId);
    const node: NodeRecord = { ...input, id, from: after.id, flow: 'next', description: action.description.trim(), side: null, order: null, revision: 1 };
    if (!node.description) throw new DomainError('INVALID_BATCH_INPUT', 'insert.description 不能为空');
    this.state.nodes.push(node);
    this.createdNodeIds.push(id);
    const beforeNode = this.state.nodes.find((entry) => entry.id === before.id) as NodeRecord;
    beforeNode.from = id;
    beforeNode.flow = 'next';
    beforeNode.description = action.nextDescription.trim();
    beforeNode.side = null;
    beforeNode.order = null;
    if (!beforeNode.description) throw new DomainError('INVALID_BATCH_INPUT', 'insert.nextDescription 不能为空');
    this.changed.push({ nodeId: id, kind: 'create' }, { nodeId: before.id, kind: 'update' });
    this.primaryTopicId = after.topicId;
  }

  private applyRearrange(edits: readonly { target: ExistingSelector; from: ExistingSelector; flow: 'next'|'branch'; description: string; order?: number }[]): void {
    const view = this.view();
    const seen = new Set<string>();
    for (const edit of edits) {
      const target = checkSelector(view, edit.target);
      const source = checkSelector(view, edit.from);
      if (target.topicId !== source.topicId) throw new DomainError('NODE_CROSS_TOPIC', '改接不能跨主题');
      if (target.id === source.id) throw new DomainError('NODE_SELF_LINK', '节点不能以自身作为来源');
      if (seen.has(target.id)) throw new DomainError('INVALID_BATCH_INPUT', '同一节点只能改接一次');
      seen.add(target.id);
      if (edit.flow === 'next') {
        const occupied = this.state.nodes.find((node) => node.from === source.id && node.flow === 'next' && node.id !== target.id);
        if (occupied) throw new DomainError('OPERATION_CONFLICT', '来源已有 next 后继：' + occupied.id, 409);
      }
      if (!edit.description.trim()) throw new DomainError('INVALID_BATCH_INPUT', 'rearrange.description 不能为空');
      const node = this.state.nodes.find((entry) => entry.id === target.id) as NodeRecord;
      node.from = source.id;
      node.flow = edit.flow;
      node.description = edit.description.trim();
      node.side = edit.flow === 'branch' ? node.side : null;
      node.order = edit.flow === 'branch' ? (edit.order ?? node.order) : null;
      this.changed.push({ nodeId: node.id, kind: 'update' });
      this.primaryTopicId = target.topicId;
    }
  }

  private applyImportance(nodeId: string, important: boolean, revision?: number): void {
    const view = this.view();
    const node = revision === undefined ? findNode(view, nodeId) : checkSelector(view, { id: nodeId, revision });
    if (node.important === important) { this.primaryTopicId = node.topicId; return; }
    (this.state.nodes.find((entry) => entry.id === nodeId) as NodeRecord).important = important;
    this.changed.push({ nodeId, kind: 'update' });
    this.primaryTopicId = node.topicId;
  }

  private applyCreateTopic(topicTitle: string, key: string | undefined, nodeInput: NodeCreate): void {
    if (!topicTitle.trim()) throw new DomainError('INVALID_PATCH', '主题标题不能为空');
    let keyCandidate = (key ?? topicKeyFromTitle(topicTitle)).trim();
    if (!keyCandidate) keyCandidate = 'topic-' + Date.now();
    if (this.state.topics.some((topic) => topic.key.toLowerCase() === keyCandidate.toLowerCase())) {
      throw new DomainError('TOPIC_EXISTS', '主题 key 已存在：' + keyCandidate, 409, { key: keyCandidate });
    }
    const topicId = newTopicId();
    const topic: TopicRecord = { id: topicId, key: keyCandidate, title: topicTitle.trim(), revision: 1, lastChangeAt: null, lastChangeIds: [] };
    this.state.topics.push(topic);
    const nodeId = newNodeId();
    this.state.nodes.push({ ...normalizeCreate(nodeInput, topicId), id: nodeId, revision: 1 });
    this.createdTopicId = topicId;
    this.createdNodeIds.push(nodeId);
    this.changed.push({ nodeId, kind: 'create' });
    this.primaryTopicId = topicId;
    this.summary = '创建主题与根节点';
  }

  private applyCreateFrom(from: ExistingSelector, flow: 'next'|'branch', description: string, nodeInput: NodeCreate): void {
    const view = this.view();
    const source = checkSelector(view, from);
    if (flow === 'next') {
      const occupied = this.state.nodes.find((node) => node.from === source.id && node.flow === 'next');
      if (occupied) throw new DomainError('OPERATION_CONFLICT', '来源已有 next 后继，不能隐式挤掉：' + occupied.id, 409, { sourceId: source.id, nextId: occupied.id });
    }
    if (!description.trim()) throw new DomainError('INVALID_PATCH', 'description 不能为空');
    const id = newNodeId();
    const node: NodeRecord = {
      ...normalizeCreate(nodeInput, source.topicId), id, from: source.id, flow,
      description: description.trim(), side: flow === 'branch' ? nodeInput.side ?? null : null,
      order: flow === 'branch' ? nodeInput.order ?? null : null, revision: 1,
    };
    this.state.nodes.push(node);
    this.createdNodeIds.push(id);
    this.changed.push({ nodeId: id, kind: 'create' });
    this.primaryTopicId = source.topicId;
    this.summary = flow === 'next' ? '新增纵向后继' : '新增分支';
  }

  private applyDelete(target: ExistingSelector): void {
    const view = this.view();
    this.deleteNode(checkSelector(view, target));
  }

  private deleteNode(target: NodeView): void {
    if (target.flow === 'root') throw new DomainError('ROOT_DELETE_FORBIDDEN', '不能删除主题 root；可取消重要或修改内容', 422, { nodeId: target.id });
    const children = this.state.nodes.filter((node) => node.from === target.id);
    if (children.length > 0) throw new DomainError('NODE_NOT_LEAF', '只能删除最终叶卡；先明确重接子节点', 409, { nodeId: target.id, childIds: children.map((node) => node.id) });
    this.state.nodes = this.state.nodes.filter((node) => node.id !== target.id);
    this.deletedNodeIds.push(target.id);
    this.changed.push({ nodeId: target.id, kind: 'delete' });
    this.primaryTopicId = target.topicId;
  }

  private replaceNode(id: string, after: NodeRecord): void {
    const index = this.state.nodes.findIndex((node) => node.id === id);
    if (index < 0) throw new DomainError('NODE_NOT_FOUND', '找不到节点 ' + id, 404);
    const before = this.state.nodes[index] as NodeRecord;
    this.state.nodes[index] = {
      id: before.id, topicId: before.topicId, title: after.title, body: after.body, summary: after.summary,
      from: after.from, flow: after.flow, description: after.description, side: after.side,
      order: after.order, important: after.important, revision: before.revision,
    };
  }

  private finishOrders(): void {
    for (const node of this.state.nodes) {
      if (node.flow !== 'branch' || node.order !== null || node.from === null) continue;
      const used = this.state.nodes.filter((entry) => entry.from === node.from && entry.flow === 'branch' && entry.id !== node.id && entry.order !== null).map((entry) => entry.order as number);
      node.order = used.length === 0 ? 10 : Math.max(...used) + 10;
    }
  }
}

interface CommitOutcome {
  primaryTopicId: string | null;
  createdTopicId: string | null;
  createdNodeIds: string[];
  deletedNodeIds: string[];
  changedNodeIds: string[];
  aliases: Record<string, string>;
  changes: AgentCheckResponse['changes'];
  summary: string;
}

function isLocalSelector(selector: NodeSelector): selector is LocalSelector { return 'local' in selector; }

function pushTopic(map: Map<string, string[]>, topicId: string, nodeId: string): void {
  const list = map.get(topicId);
  if (list) list.push(nodeId);
  else map.set(topicId, [nodeId]);
}

function randomHex(length: number): string {
  let out = '';
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, length);
}

function configure(db: DatabaseSync, readonly = false): void {
  if (!readonly) db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  else db.exec('PRAGMA busy_timeout=5000;');
}

/**
 * One-time v1 → v2 upgrade on writable open. Rebuild the nodes table without the
 * retired state column. Only the schema changes: ids, content, connections,
 * important flags, revisions and topic last-change metadata are copied as-is.
 * Read-only opens never call this.
 */
function upgradeLegacySchema(db: DatabaseSync): void {
  try {
    db.exec('BEGIN IMMEDIATE');
    const columns = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name?: unknown }>;
    const hasState = columns.some((column) => column.name === 'state');
    if (!hasState) throw new Error('nodes 表缺少预期的 state 列');
    db.exec(`
      CREATE TABLE nodes_v2(
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        summary TEXT,
        from_id TEXT,
        flow TEXT NOT NULL,
        description TEXT,
        side TEXT,
        ord INTEGER,
        important INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL
      );
      INSERT INTO nodes_v2(id,topic_id,title,body,summary,from_id,flow,description,side,ord,important,revision)
        SELECT id,topic_id,title,body,summary,from_id,flow,description,side,ord,important,revision FROM nodes;
      DROP TABLE nodes;
      ALTER TABLE nodes_v2 RENAME TO nodes;
      CREATE INDEX nodes_topic ON nodes(topic_id);
      CREATE INDEX nodes_from ON nodes(from_id);
    `);
    const updated = db.prepare("UPDATE meta SET value=? WHERE key='schemaVersion'").run(String(SCHEMA_VERSION));
    if (Number(updated.changes) !== 1) throw new Error('meta.schemaVersion 更新失败');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw new DomainError(
      'DB_SCHEMA_UPGRADE_FAILED',
      '旧数据库结构升级失败，原有数据未变：' + (error instanceof Error ? error.message : String(error)),
      500,
      { fromSchemaVersion: LEGACY_SCHEMA_VERSION, toSchemaVersion: SCHEMA_VERSION },
    );
  }
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE workspace(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active_node TEXT,
      revision INTEGER NOT NULL
    );
    CREATE TABLE topics(
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL,
      last_change_at TEXT,
      last_change_ids TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE nodes(
      id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      summary TEXT,
      from_id TEXT,
      flow TEXT NOT NULL,
      description TEXT,
      side TEXT,
      ord INTEGER,
      important INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL
    );
    CREATE INDEX nodes_topic ON nodes(topic_id);
    CREATE INDEX nodes_from ON nodes(from_id);
    CREATE TABLE requests(
      request_id TEXT PRIMARY KEY,
      body_hash TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      state TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function nodeRow(row: any): NodeRecord {
  return {
    id: row.id, topicId: row.topic_id, title: row.title, body: row.body,
    summary: row.summary ?? null, from: row.from_id ?? null,
    flow: row.flow, description: row.description ?? null, side: row.side ?? null,
    order: row.ord ?? null, important: row.important === 1 || row.important === true,
    revision: row.revision,
  };
}
function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []; }
  catch { return []; }
}
function trimRequests(db: DatabaseSync): void {
  db.exec('DELETE FROM requests WHERE request_id NOT IN (SELECT request_id FROM requests ORDER BY created_at DESC LIMIT 200)');
}
