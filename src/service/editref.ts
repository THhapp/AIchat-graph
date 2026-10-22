/**
 * 实例内写入凭据（editRef）。
 *
 * 一次真实读取签发一个短凭据，绑定工作区、主题、节点、真实源路径、
 * 读取时的文件哈希与快照版本。修改请求必须带回凭据，服务用它核对
 * "改动所依据的正是调用方读到的那份字节"，不接受用编号重新定位，
 * 服务重启或源文件变化后一律拒绝。
 *
 * 凭据只存在于本实例内存中；不落盘、不伪造给离线读取。
 */
import { randomBytes } from "node:crypto";
import type { AgentEditRef } from "../shared/protocol.js";

export interface EditRefBinding {
  readonly workspaceId: string;
  readonly topicId: string;
  readonly nodeId: string;
  /** 节点真实源文件（格式 2 为节点自己的 Markdown）。 */
  readonly path: string;
  readonly fileHash: string;
  readonly instanceId: string;
  readonly revision: number;
}

interface StoredRef extends EditRefBinding {
  readonly issuedAt: string;
}

/** 有界凭据表：旧凭据被淘汰后按"未知"处理，不会悄悄重定位。 */
const MAX_EDITS = 512;

export class EditRefStore {
  readonly instanceId: string;
  private readonly refs = new Map<string, StoredRef>();

  constructor(instanceId: string) {
    this.instanceId = instanceId;
  }

  /** 为一次真实读取签发凭据。 */
  issue(binding: EditRefBinding): AgentEditRef {
    const ref = "er_" + randomBytes(18).toString("base64url");
    const stored: StoredRef = { ...binding, issuedAt: new Date().toISOString() };
    this.refs.set(ref, stored);
    while (this.refs.size > MAX_EDITS) {
      const oldest = this.refs.keys().next();
      if (oldest.done === true) break;
      this.refs.delete(oldest.value);
    }
    return {
      ref,
      workspaceId: stored.workspaceId,
      topicId: stored.topicId,
      nodeId: stored.nodeId,
      path: stored.path,
      fileHash: stored.fileHash,
      instanceId: stored.instanceId,
      revision: stored.revision,
      issuedAt: stored.issuedAt,
    };
  }

  /** 读取凭据绑定；不存在或不属于本实例时返回 null，由调用方明确拒绝。 */
  resolve(ref: unknown): StoredRef | null {
    if (typeof ref !== "string" || ref.length === 0) return null;
    const stored = this.refs.get(ref);
    if (stored === undefined) return null;
    if (stored.instanceId !== this.instanceId) return null;
    return stored;
  }

  /** 该节点当前有效的最近凭据（用于写成功后的新凭据与读回）。 */
  latestForNode(nodeId: string): StoredRef | null {
    let found: StoredRef | null = null;
    for (const stored of this.refs.values()) {
      if (stored.nodeId === nodeId) found = stored;
    }
    return found;
  }

  clear(): void {
    this.refs.clear();
  }
}
