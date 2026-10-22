/**
 * ChangeRequest 的读取与形状检查（低层 check／apply 用）。
 *
 * 权威校验在 storage：`anyChangeRequestSchema` 是 V1／V2 两个 strict schema 的联合，
 * 不在这里复制任何操作字段。CLI 只负责：
 * - 从 --input 文件读取 JSON（避免 Windows 命令行长度限制）；
 * - 用该联合 schema 做一次结构检查，失败时摊开具体字段问题；
 * - 原样发送文件里的 JSON 文本：不补 expectedFiles 哈希、不改写 workspaceId。
 *
 * 联合 schema 与错误摊平函数都由 storage 公共入口提供（单一来源，不复制规则）。
 */
import { promises as fs } from "node:fs";
import {
  anyChangeRequestSchema,
  flattenChangeRequestIssues,
  type AnyChangeRequest,
} from "../storage/index.js";
import { CliError, EXIT_CODES } from "./errors.js";

export type { AnyChangeRequest };
export { anyChangeRequestSchema };

export interface ChangeRequestFile {
  /** 文件原始文本，原样发送给服务。 */
  readonly text: string;
  readonly request: AnyChangeRequest;
}

function shapeError(message: string, details?: Record<string, unknown>): CliError {
  return new CliError("INVALID_CHANGE_REQUEST", message, EXIT_CODES.usage, {
    ...(details ? { details } : {}),
  });
}

/** 用 storage 的 V1／V2 联合 schema 校验；不修改输入。 */
export function validateChangeRequestShape(raw: unknown): AnyChangeRequest {
  const parsed = anyChangeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // 联合失败时 zod 只报一个空 path 的 invalid_union；摊开后才能指出具体字段。
    const issues = flattenChangeRequestIssues(parsed.error).map((issue) => ({
      path: issue.path.map((part) => String(part)).join("."),
      code: issue.code,
      message: issue.message,
    }));
    throw shapeError("ChangeRequest 结构不合法（V1／V2 操作字段由 storage schema 判定）", {
      issues,
    });
  }
  return parsed.data;
}

/** 读取 --input 文件；解析失败与结构错误都明确区分。 */
export async function readChangeRequestFile(inputPath: string): Promise<ChangeRequestFile> {
  let text: string;
  try {
    text = await fs.readFile(inputPath, "utf8");
  } catch (error) {
    throw new CliError("INPUT_UNREADABLE", `无法读取 --input 文件: ${inputPath}`, EXIT_CODES.usage, {
      details: { path: inputPath },
      cause: error,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(
      "INPUT_INVALID_JSON",
      `--input 文件不是合法 JSON: ${inputPath}`,
      EXIT_CODES.usage,
      { details: { path: inputPath }, cause: error },
    );
  }
  return { text, request: validateChangeRequestShape(raw) };
}