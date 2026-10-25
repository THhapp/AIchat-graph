/**
 * 候选层的公共外壳。
 *
 * 这里只放纯函数：expectedFiles 规范化与全量核对、workspace.json 身份读取与序列化、
 * 摘要拼装、zod issue 平铺。节点模型、操作执行与字节保留策略仍留在候选实现中。
 */
import type { z } from "zod";
import { workspaceMetaSchema, type WorkspaceMeta } from "../../core/index.js";
import { detectLineEnding, normalizeNewlines } from "../../core/newlines.js";
import type { CommitFileInput } from "../transactions.js";
import type { WorkspaceFiles } from "../workspace.js";
import { ChangeError, badRequest, validationError } from "./shared.js";

export interface ZodIssueSummary {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export function zodIssues(error: z.ZodError): ZodIssueSummary[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * 按当前实现的路径规则规范化 expectedFiles 的键。
 * 规范化后若出现同一路径的重复声明则直接拒绝；调用方传入的 normalizePath 负责报路径错误。
 */
export function normalizeDeclaredFiles(
  expectedFiles: Record<string, string | null>,
  normalizePath: (rawPath: string) => string,
): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const [rawPath, hash] of Object.entries(expectedFiles)) {
    const path = normalizePath(rawPath);
    if (declared.has(path)) {
      throw badRequest("expectedFiles 规范化后重复声明同一路径：" + path);
    }
    declared.set(path, hash);
  }
  return declared;
}

/** 全量核对 expectedFiles：不只 touched，缺声明与哈希不符都拒绝。 */
export function verifyExpectedFiles(
  files: WorkspaceFiles,
  declared: Map<string, string | null>,
): void {
  const actual = new Map<string, string>();
  actual.set("workspace.json", files.workspaceFile.sha256);
  for (const topic of files.topics) actual.set(topic.path, topic.sha256);
  const conflicts: Array<{
    path: string;
    expectedSha256: string | null;
    actualSha256: string | null;
  }> = [];
  for (const [path, expected] of declared) {
    const actualSha256 = actual.get(path) ?? null;
    if (actualSha256 !== expected) conflicts.push({ path, expectedSha256: expected, actualSha256 });
  }
  if (conflicts.length > 0) {
    throw new ChangeError("VERSION_CONFLICT", "expectedFiles 与实际文件哈希不符", {
      details: { conflicts },
    });
  }
}

export interface WorkspaceIdentity {
  meta: WorkspaceMeta;
  raw: Record<string, unknown>;
  nl: string;
}

/** workspace.json 按完整原始 JSON 严格校验：不先丢弃 extra 字段再通过。 */
export function readWorkspaceIdentity(files: WorkspaceFiles): WorkspaceIdentity {
  const text = files.workspaceFile.text;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw validationError("workspace.json 不是合法 JSON", [], { reason: String(error) });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw validationError("workspace.json 必须是 JSON 对象");
  }
  const parsed = workspaceMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError("workspace.json 结构不合法", [], { issues: zodIssues(parsed.error) });
  }
  return { meta: parsed.data, raw: raw as Record<string, unknown>, nl: detectLineEnding(text) };
}

/** 保留 workspace.json 的既有字段与顺序，只替换 activeNode，并沿用原文件换行。 */
export function serializeWorkspace(
  raw: Record<string, unknown>,
  activeNode: string | null,
  nl: string,
): string {
  const record: Record<string, unknown> = { ...raw, activeNode };
  return normalizeNewlines(JSON.stringify(record, null, 2) + "\n", nl);
}

/** 候选层共用的摘要文本；输出为空时区分"没有操作"与"操作无文件变化"。 */
export function buildSummary(
  opNames: readonly string[],
  output: readonly CommitFileInput[],
): string {
  if (output.length === 0) {
    return opNames.length === 0
      ? "无操作，未产生文件变化"
      : "无实际文件变化（" + opNames.join("、") + "）";
  }
  return (
    opNames.length +
    " 个操作（" +
    [...new Set(opNames)].join("、") +
    "），影响 " +
    output.length +
    " 个文件：" +
    output.map((file) => file.path + (file.content === null ? "(删除)" : "")).join("、")
  );
}
