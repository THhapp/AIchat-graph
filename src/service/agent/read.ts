/**
 * Agent 有界读取：默认 4000 UTF-16 单元，单段最多 16000，显式 full 才返回全文；
 * 不切断代理对，并附带真实源路径／哈希与绑定该版本的 editRef。
 *
 * 章节定位与 CLI 离线读取共用 core 的 AST 实现；本模块不做 IO。
 */
import {
  MAX_READ_SEGMENT,
  locateSection,
  sectionAt,
  sectionsOf,
  sliceBody,
} from "../../core/index.js";
import type {
  AgentNodeReadResponse,
  AgentReadRange,
  AgentSection,
} from "../../shared/protocol.js";
import type { WorkspaceRuntime } from "../workspace.js";
import type { EditRefStore } from "../editref.js";
import { ServiceError } from "../errors.js";
import { toGraphNode } from "../snapshot.js";
import { findParsedNode } from "./shared.js";

/** 单次可请求的最大片段长度（与 core 一致，仅作为对外别名）。 */
export const MAX_READ_LENGTH = MAX_READ_SEGMENT;

export interface AgentReadQuery {
  readonly start?: number | undefined;
  readonly length?: number | undefined;
  readonly full?: boolean | undefined;
  /** 只取元数据与 editRef，不返回正文（不能与其他定位／切片参数同时使用）。 */
  readonly meta?: boolean | undefined;
  /** 按标题定位章节；start 取该章节起点。 */
  readonly section?: string | undefined;
  /** 同名标题中的第几个（0 起）；必须与 section 一起使用。 */
  readonly sectionIndex?: number | undefined;
}

function parseOffset(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ServiceError(400, "BAD_REQUEST", label + " 必须是非负整数", { details: { value: raw } });
  }
  return Number(raw);
}

export function parseAgentReadQuery(query: Record<string, string | undefined>): AgentReadQuery {
  const start = parseOffset(query["start"], "start");
  const length = parseOffset(query["length"], "length");
  if (start !== undefined && start > 100_000_000) {
    throw new ServiceError(400, "BAD_REQUEST", "start 超出可接受范围", {});
  }
  if (length !== undefined && (length < 1 || length > MAX_READ_LENGTH)) {
    throw new ServiceError(400, "BAD_REQUEST", "length 必须在 1-" + MAX_READ_LENGTH + " 之间", {
      details: { max: MAX_READ_LENGTH },
    });
  }
  const fullRaw = query["full"];
  if (fullRaw !== undefined && fullRaw !== "true" && fullRaw !== "false" && fullRaw !== "") {
    throw new ServiceError(400, "BAD_REQUEST", "full 只接受 true 或省略", {});
  }
  const metaRaw = query["meta"];
  if (metaRaw !== undefined && metaRaw !== "true" && metaRaw !== "false" && metaRaw !== "") {
    throw new ServiceError(400, "BAD_REQUEST", "meta 只接受 true 或省略", {});
  }
  const meta = metaRaw === "true" || metaRaw === "";

  let section: string | undefined;
  const sectionRaw = query["section"];
  if (sectionRaw !== undefined) {
    const trimmed = sectionRaw.trim();
    if (trimmed.length === 0) {
      throw new ServiceError(
        400,
        "BAD_REQUEST",
        "section 去空白后不能为空；请给出正文里的标题，例如 --section \"小节一\"",
        {},
      );
    }
    section = trimmed;
  }
  const sectionIndex = parseOffset(query["section-index"], "section-index");
  if (sectionIndex !== undefined && section === undefined) {
    throw new ServiceError(
      400,
      "BAD_REQUEST",
      "section-index 必须与 section 一起使用；单独给出无法定位章节",
      {},
    );
  }

  if (meta) {
    // meta 只返回元数据与 editRef；切片／章节参数会让人误以为正文仍被返回。
    const conflicts = [
      query["start"] !== undefined ? "start" : undefined,
      query["length"] !== undefined ? "length" : undefined,
      query["full"] !== undefined ? "full" : undefined,
      query["section"] !== undefined ? "section" : undefined,
      query["section-index"] !== undefined ? "section-index" : undefined,
    ].filter((item): item is string => item !== undefined);
    if (conflicts.length > 0) {
      throw new ServiceError(
        400,
        "BAD_REQUEST",
        "meta=true 不能与 " + conflicts.join("／") + " 同时使用；meta 读取不含正文，请去掉这些参数",
        { details: { conflicts } },
      );
    }
  }

  return {
    start,
    length,
    full: fullRaw === "true" || fullRaw === "",
    ...(meta ? { meta: true } : {}),
    ...(section !== undefined ? { section } : {}),
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
  };
}

export interface AgentReadContext {
  readonly runtime: WorkspaceRuntime;
  readonly editRefs: EditRefStore;
  readonly nodeId: string;
  readonly query: AgentReadQuery;
}

/**
 * 有界读取一个节点。正文来自有效快照（不与新磁盘字节拼装）；
 * editRef 绑定该快照版本与真实源文件哈希。
 */
export function readAgentNode(context: AgentReadContext): AgentNodeReadResponse {
  const { runtime, editRefs, nodeId, query } = context;
  const snapshot = runtime.current.data;
  const found = findParsedNode(snapshot, nodeId);
  if (found === null) {
    throw new ServiceError(404, "NOT_FOUND", "当前有效快照中没有节点 " + nodeId, {
      details: { nodeId },
    });
  }
  const { node, topic, view, fileHash } = found;
  const body = node.body;
  const sections = sectionsOf(body);

  // section 定位走 core 的 AST helper；在线与离线共用同一份实现。
  let rangeStart = query.start ?? 0;
  let locatedSection: AgentSection | null = null;
  if (query.section !== undefined) {
    let location;
    try {
      location = locateSection(body, query.section, query.sectionIndex);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ServiceError(400, "INVALID_SECTION", error.message, {
          details: {
            section: query.section,
            ...(query.sectionIndex !== undefined ? { sectionIndex: query.sectionIndex } : {}),
          },
        });
      }
      throw error;
    }
    rangeStart = location.start;
    // AgentSection.index 是全文标题顺序，不是 locateSection 的同名匹配序号。
    locatedSection =
      sections.find((entry) => entry.start === location.start) ??
      sectionAt(sections, location.start);
  }

  let fragment: string;
  let range: AgentReadRange;
  let truncated: boolean;
  let section: AgentSection | null;
  if (query.meta === true) {
    // meta 只给元数据与 editRef：正文明确省略，range 以 0/0 表达。
    fragment = "";
    range = { start: 0, end: 0, total: body.length, unit: "utf16" };
    truncated = false;
    section = null;
  } else {
    // 切片统一复用 core 的纯 helper：UTF-16 单位、不切断代理对、
    // truncated = start > 0 || end < total。
    const segment = sliceBody(body, {
      start: rangeStart,
      ...(query.length !== undefined ? { length: query.length } : {}),
      full: query.full === true,
    });
    fragment = segment.text;
    range = segment.range;
    truncated = segment.truncated;
    // 显式 section 返回定位到的章节；否则保留"包含 range.start 的最近章节"。
    section = locatedSection ?? sectionAt(sections, range.start);
  }

  const issued = editRefs.issue({
    workspaceId: snapshot.workspaceId,
    topicId: node.topicId,
    nodeId: node.id,
    path: node.sourcePath,
    fileHash,
    instanceId: runtime.instanceId,
    revision: runtime.current.revision,
  });

  return {
    ...runtime.snapshotVersion(),
    workspaceId: snapshot.workspaceId,
    node: toGraphNode(view),
    body: fragment,
    ...(query.meta === true ? { bodyOmitted: true } : {}),
    range,
    truncated,
    path: node.sourcePath,
    fileHash,
    topicPath: topic.path,
    editRef: issued,
    section,
  };
}
