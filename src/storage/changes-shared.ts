/**
 * 候选变更的共享契约：错误类型、结果形状与错误展开工具。
 *
 * 单独成文件的理由：格式 1（changes.ts）与格式 2（changes-v2.ts）互相需要对方的
 * schema 与实现来组装联合入口，但错误类型和结果形状是两者共同的下游。
 * 把它们放在最底层，两个实现都只依赖这里，就不会形成"互相初始化"的循环。
 */
import type { z } from "zod";
import type { Diagnostic } from "../core/index.js";
import type { StorageDiagnostic } from "./errors.js";
import type { CommitFileInput } from "./transactions.js";

export type ChangeErrorCode =
  | "BAD_REQUEST"
  | "VERSION_CONFLICT"
  | "OPERATION_CONFLICT"
  | "VALIDATION_FAILED";

export interface ChangeErrorOptions {
  details?: Record<string, unknown> | undefined;
  diagnostics?: readonly Diagnostic[] | undefined;
  cause?: unknown;
}

/**
 * 候选编辑的稳定错误契约：
 * - BAD_REQUEST：请求结构／字段不合法，未进入候选计算；
 * - VERSION_CONFLICT：expectedFiles 与实际文件不符（412，details.conflicts）；
 * - OPERATION_CONFLICT：语义操作冲突或缺前置声明（409，缺声明时 details.missingFiles）；
 * - VALIDATION_FAILED：候选内容的 parse／graph 校验失败（422，diagnostics 为 core Diagnostic）。
 */
export class ChangeError extends Error {
  readonly code: ChangeErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly diagnostics: readonly Diagnostic[] | undefined;

  constructor(code: ChangeErrorCode, message: string, options: ChangeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChangeError";
    this.code = code;
    this.details = options.details;
    this.diagnostics = options.diagnostics;
  }
}

/** 两版候选的共同返回形状；调用方把 files 直接交给 commitFiles。 */
export interface PreparedChanges {
  readonly files: CommitFileInput[];
  readonly changedNodeIds: string[];
  /**
   * 节点文件内容被真实新建或改写的节点。
   * 格式 2 由候选层精确给出（不含删除、不含仅改重要性的节点）；缺省时按 changedNodeIds 理解。
   */
  readonly contentNodeIds?: string[];
  readonly diagnostics: StorageDiagnostic[];
  readonly summary: string;
}

export function badRequest(message: string, details?: Record<string, unknown>): ChangeError {
  return new ChangeError("BAD_REQUEST", message, { details });
}

export function conflict(message: string, details?: Record<string, unknown>): ChangeError {
  return new ChangeError("OPERATION_CONFLICT", message, { details });
}

export function validationError(
  message: string,
  diagnostics: readonly Diagnostic[] = [],
  details?: Record<string, unknown>,
): ChangeError {
  return new ChangeError("VALIDATION_FAILED", message, { diagnostics, details });
}

export interface FlatIssue {
  readonly code: string;
  /** zod 的 path 元素是 PropertyKey；统一成字符串，便于直接拼进诊断。 */
  readonly path: string[];
  readonly message: string;
  readonly keys?: readonly string[];
}

function toStringPath(path: readonly PropertyKey[]): string[] {
  return path.map((part) => String(part));
}

/**
 * 把联合失败展开成具体字段问题。
 *
 * zod 的 union 只报一条 path 为空的 invalid_union，service／CLI 无法据此指出哪个字段错了。
 * 这里挑"最接近通过"的那一支（报错最少）并平铺它的实际 issue；非联合问题原样保留。
 * 只改善错误可读性，不改变接受／拒绝判定。
 */
export function flattenChangeRequestIssues(error: z.ZodError): FlatIssue[] {
  const flattened: FlatIssue[] = [];
  for (const issue of error.issues) {
    const nested = (issue as { errors?: unknown }).errors;
    if (issue.code !== "invalid_union" || !Array.isArray(nested)) {
      const keys = (issue as { keys?: readonly string[] }).keys;
      flattened.push({
        code: issue.code,
        path: toStringPath(issue.path),
        message: issue.message,
        ...(keys !== undefined ? { keys } : {}),
      });
      continue;
    }
    let best: FlatIssue[] | null = null;
    for (const branch of nested) {
      // zod 4 的 union 嵌套项既可能是 {issues:[...]}，也可能直接就是一组 issue。
      const issues = Array.isArray(branch)
        ? branch
        : (branch as { issues?: readonly unknown[] }).issues;
      if (!Array.isArray(issues)) continue;
      const candidates: FlatIssue[] = [];
      for (const entry of issues) {
        const record = entry as {
          code?: string;
          path?: (string | number)[];
          message?: string;
          keys?: readonly string[];
          errors?: unknown;
        };
        if (record.code === "invalid_union" && Array.isArray(record.errors)) {
          const deeper = record.errors
            .map((inner) => (Array.isArray(inner) ? inner : []))
            .find((inner) => inner.length > 0) as readonly unknown[] | undefined;
          if (deeper) {
            for (const sub of deeper) {
              const subRecord = sub as {
                code?: string;
                path?: (string | number)[];
                message?: string;
              };
              candidates.push({
                code: subRecord.code ?? "invalid",
                path: Array.isArray(subRecord.path) ? toStringPath(subRecord.path) : [],
                message: subRecord.message ?? "结构不合法",
              });
            }
            continue;
          }
        }
        candidates.push({
          code: record.code ?? "invalid",
          path: Array.isArray(record.path) ? toStringPath(record.path) : [],
          message: record.message ?? "结构不合法",
          ...(record.keys !== undefined ? { keys: record.keys } : {}),
        });
      }
      if (candidates.length === 0) continue;
      if (best === null || candidates.length < best.length) best = candidates;
    }
    if (best === null) {
      flattened.push({ code: issue.code, path: toStringPath(issue.path), message: issue.message });
    } else {
      flattened.push(...best);
    }
  }
  return flattened;
}
