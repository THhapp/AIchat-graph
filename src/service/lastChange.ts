/**
 * 每个主题最近一次内容更新的服务端记录。
 *
 * 文件 `.aichat/runtime/last-change.json` 保存 v2 全量 `topics` 映射：
 * `{ schemaVersion: 2, topics: { [topicId]: { at, nodeIds } } }`。
 * 每个主题独立保留最近一批被新建或实际改写的节点；更新主题 B 不会清除或
 * 覆盖主题 A。它记录事实，不是修改历史，也不复制正文；重启后仍能读回，
 * 直到对应主题的下一次内容修改替换该主题的记录。
 *
 * 兼容旧 v1 单批文件（`{ schemaVersion: 1, at, nodeIds }`，或只有 at/nodeIds）：
 * 读取时按调用方给出的 nodeId → topicId 映射拆分到各主题，同一主题共用原 at；
 * 找不到归属的节点忽略。这是只读转换，绝不因读取而改写文件。
 *
 * 读失败不编造：文件缺失、损坏或 schema 无法识别都返回空对象（图上不出现记录）。
 * 单条主题记录损坏只丢弃该条，不影响其他主题。写入失败不阻断提交：
 * 源文件已经落盘，调用方只需报告诊断。
 */
import { promises as fs } from "node:fs";
import {
  assertPathInsideWorkspace,
  isErrnoCode,
  writeFileDurable,
} from "../storage/index.js";
import type { LastChange } from "../shared/protocol.js";

export const LAST_CHANGE_PATH = ".aichat/runtime/last-change.json";
const LAST_CHANGE_SCHEMA_VERSION = 2;
const LEGACY_LAST_CHANGE_SCHEMA_VERSION = 1;
const NODE_ID_PATTERN = /^n_[0-9a-f]{32}$/;
const TOPIC_ID_PATTERN = /^t_[0-9a-f]{32}$/;

interface LastChangeFile {
  readonly schemaVersion: number;
  readonly topics: Record<string, LastChange>;
}

type TopicOfNode = (nodeId: string) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ISO 时间戳；不可解析的 at 使该条记录无效。 */
function parseAt(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** 只接受稳定节点 ID 并去重；非法元素丢弃，保留同条记录里的合法节点。 */
function parseNodeIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !NODE_ID_PATTERN.test(item)) continue;
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

/** v2：逐主题校验；无效主题条目丢弃，不影响其他主题。 */
function parseV2(raw: Record<string, unknown>): Record<string, LastChange> {
  const topics = raw["topics"];
  if (!isRecord(topics)) return {};
  const result: Record<string, LastChange> = {};
  for (const [topicId, value] of Object.entries(topics)) {
    if (!TOPIC_ID_PATTERN.test(topicId) || !isRecord(value)) continue;
    const at = parseAt(value["at"]);
    const nodeIds = parseNodeIds(value["nodeIds"]);
    if (at === null || nodeIds === null || nodeIds.length === 0) continue;
    result[topicId] = { at, nodeIds };
  }
  return result;
}

/**
 * v1 单批记录：按当前快照把旧 nodeIds 分到主题，同一主题共用原 at。
 * 不认识的节点（含已删除节点）不伪造归属，直接忽略。
 */
function parseLegacy(
  raw: Record<string, unknown>,
  topicOfNode: TopicOfNode,
): Record<string, LastChange> {
  const at = parseAt(raw["at"]);
  if (at === null) return {};
  const nodeIds = raw["nodeIds"];
  if (!Array.isArray(nodeIds)) return {};
  const byTopic = new Map<string, string[]>();
  for (const item of nodeIds) {
    if (typeof item !== "string" || !NODE_ID_PATTERN.test(item)) continue;
    const topicId = topicOfNode(item);
    if (topicId === null || !TOPIC_ID_PATTERN.test(topicId)) continue;
    const ids = byTopic.get(topicId) ?? [];
    if (!ids.includes(item)) ids.push(item);
    byTopic.set(topicId, ids);
  }
  const result: Record<string, LastChange> = {};
  for (const [topicId, nodeIds] of byTopic) {
    result[topicId] = { at, nodeIds };
  }
  return result;
}

function parseLastChanges(text: string, topicOfNode: TopicOfNode): Record<string, LastChange> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const schemaVersion = raw["schemaVersion"];
  if (schemaVersion === LAST_CHANGE_SCHEMA_VERSION) return parseV2(raw);
  // 旧文件可能没有 schemaVersion，只带 at/nodeIds。
  if (
    schemaVersion === LEGACY_LAST_CHANGE_SCHEMA_VERSION ||
    (schemaVersion === undefined && raw["at"] !== undefined && raw["nodeIds"] !== undefined)
  ) {
    return parseLegacy(raw, topicOfNode);
  }
  return {};
}

/**
 * 读取各主题最近一次内容更新；缺失、损坏或未知 schema 返回空对象。
 * v1 记录只在内存里按 topicOfNode 转换，不写回文件。
 */
export async function readLastChanges(
  rootReal: string,
  topicOfNode: TopicOfNode,
): Promise<Record<string, LastChange>> {
  let absolute: string;
  try {
    absolute = await assertPathInsideWorkspace(rootReal, LAST_CHANGE_PATH);
  } catch {
    return {};
  }
  let text: string;
  try {
    text = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) return {};
    throw error;
  }
  return parseLastChanges(text, topicOfNode);
}

/** 覆盖写入 v2 全量 topics 映射；调用方保证 rootReal 是工作区真实路径。 */
export async function writeLastChanges(
  rootReal: string,
  changes: Record<string, LastChange>,
): Promise<void> {
  const absolute = await assertPathInsideWorkspace(rootReal, LAST_CHANGE_PATH);
  const topics: Record<string, LastChange> = {};
  for (const topicId of Object.keys(changes).sort()) {
    const change = changes[topicId];
    if (change === undefined) continue;
    topics[topicId] = change;
  }
  const file: LastChangeFile = {
    schemaVersion: LAST_CHANGE_SCHEMA_VERSION,
    topics,
  };
  await writeFileDurable(absolute, Buffer.from(JSON.stringify(file, null, 2) + "\n", "utf8"));
}
