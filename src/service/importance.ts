/**
 * POST /api/importance：翻转一张卡片的 important 元数据。
 *
 * 只做一件事：把 { topicId, nodeId, important } 编成一次格式 2 的 setImportance 操作，
 * 交回现有队列 → prepareChangesV2 → commitFiles → 快照发布链路；不直接改文件，
 * 也不复制候选逻辑。expectedHash 提供时按读取时的字节哈希校验，失配即 412。
 */
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "../storage/index.js";
import type { V2ChangeRequest } from "../storage/index.js";
import type { ImportanceRequest, ImportanceResponse } from "../shared/protocol.js";
import { applyChanges } from "./changes.js";
import { ServiceError } from "./errors.js";
import { toGraphNode } from "./snapshot.js";
import type { WorkspaceRuntime } from "./workspace.js";

/** 节点或它的真实源文件不在当前快照中：语义冲突，不猜路径。 */
function nodeMissing(details: Record<string, unknown>): ServiceError {
  return new ServiceError(409, "OPERATION_CONFLICT", "该主题下没有这张卡片（可能已被删除）；请刷新后重试", {
    details,
  });
}

export async function setNodeImportance(
  runtime: WorkspaceRuntime,
  request: ImportanceRequest,
): Promise<ImportanceResponse> {
  const snapshot = runtime.current.data;
  if (snapshot.schemaVersion !== 2) {
    // 格式 1 没有独立节点文件，也不提供重要性的写入口（读侧恒为 false）。
    throw new ServiceError(
      409,
      "OPERATION_CONFLICT",
      "重要标记只支持格式 2 工作区（一节点一份 Markdown）；格式 1 不提供该写入口",
      { details: { schemaVersion: snapshot.schemaVersion } },
    );
  }
  const node = snapshot.graph.nodes.find((entry) => entry.id === request.nodeId);
  if (node === undefined || node.topicId !== request.topicId) {
    throw nodeMissing({ topicId: request.topicId, nodeId: request.nodeId });
  }
  const topic = snapshot.topics.find((entry) => entry.topicId === node.topicId);
  const file = topic?.files.find((entry) => entry.path === node.sourcePath);
  if (file === undefined) {
    throw nodeMissing({ topicId: node.topicId, nodeId: node.id, sourcePath: node.sourcePath });
  }
  if (request.expectedHash !== undefined && request.expectedHash !== file.fileHash) {
    throw new ServiceError(
      412,
      "VERSION_CONFLICT",
      "节点源文件在读取后已变化；请重新读取这张卡片后再设置重要性",
      {
        details: {
          nodeId: node.id,
          path: file.path,
          expectedSha256: request.expectedHash,
          actualSha256: file.fileHash,
        },
      },
    );
  }
  // 值未变：不改文件、不产生事务，直接回当前快照里的节点。
  if (node.important === request.important) {
    return { ...runtime.snapshotVersion(), ok: true, node: toGraphNode(node) };
  }

  const changeRequest: V2ChangeRequest = {
    workspaceId: runtime.workspaceId,
    requestId: randomUUID(),
    expectedFiles: { [file.path]: file.fileHash },
    operations: [{ op: "setImportance", nodeId: node.id, important: request.important }],
  };
  const result = await applyChanges(runtime, changeRequest, sha256Bytes(JSON.stringify(changeRequest)));
  if (result.state === "committed_refresh_pending") {
    // 源文件已落盘但快照没刷新：不能拿旧快照里的节点冒充新值。
    throw new ServiceError(
      409,
      "COMMITTED_REFRESH_PENDING",
      "重要标记已写入源文件，但当前磁盘无法重建有效快照；修复后重启服务再确认",
      { details: { transactionId: result.transactionId } },
    );
  }

  const updated = runtime.current.data.graph.nodes.find((entry) => entry.id === node.id);
  if (updated === undefined) {
    throw nodeMissing({ topicId: request.topicId, nodeId: request.nodeId });
  }
  return { ...runtime.snapshotVersion(), ok: true, node: toGraphNode(updated) };
}
