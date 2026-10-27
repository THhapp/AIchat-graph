/**
 * CLI 错误与退出码。错误码是稳定契约；用法错误走纯文本 usage，
 * 其他错误统一向 stderr 输出 { ok:false, error:{ code, message, details?, diagnostics? } }。
 */
import { StorageError } from "../storage/index.js";
import type { StorageErrorCode } from "../storage/index.js";

export const EXIT_CODES = {
  ok: 0,
  usage: 2,
  workspace: 3,
  versionConflict: 4,
  operationConflict: 5,
  validation: 6,
  service: 7,
  resultUnknown: 8,
  http: 9,
  internal: 10,
  notFound: 11,
} as const;

export type CliExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface CliErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly diagnostics?: readonly unknown[];
  /** 顶层附加字段（如 httpStatus、requestId、url、status），便于机器读取。 */
  readonly extras?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly diagnostics: readonly unknown[] | undefined;
  readonly extras: Record<string, unknown> | undefined;

  constructor(code: string, message: string, exitCode: number, options: CliErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = options.details;
    this.diagnostics = options.diagnostics;
    this.extras = options.extras;
  }
}

export class UsageError extends CliError {
  constructor(message: string, options: CliErrorOptions = {}) {
    super("USAGE", message, EXIT_CODES.usage, options);
    this.name = "UsageError";
  }
}

/** 参数值不合法（区别于缺命令／未知选项）：统一 INVALID_ARGUMENT + usage 退出码。 */
export function invalidArgument(
  message: string,
  details?: Record<string, unknown>,
): CliError {
  return new CliError("INVALID_ARGUMENT", message, EXIT_CODES.usage, {
    ...(details ? { details } : {}),
  });
}

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly diagnostics?: readonly unknown[];
}

export interface ErrorEnvelope {
  ok: false;
  error: ErrorBody;
  [key: string]: unknown;
}

const STORAGE_USAGE_CODES = new Set<StorageErrorCode>([
  "INVALID_ARGUMENT",
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "PATH_NOT_ALLOWED",
  "DUPLICATE_PATH",
]);

/** 把任意异常规范化为 CLI 错误；StorageError 的 code 原样保留。 */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof StorageError) {
    const details: Record<string, unknown> = {};
    if (error.path !== undefined) details["path"] = error.path;
    if (error.details !== undefined) Object.assign(details, error.details);
    return new CliError(
      error.code,
      error.message,
      STORAGE_USAGE_CODES.has(error.code) ? EXIT_CODES.usage : EXIT_CODES.workspace,
      Object.keys(details).length > 0 ? { details, cause: error } : { cause: error },
    );
  }
  if (error instanceof Error) {
    return new CliError("INTERNAL", error.message || "内部错误", EXIT_CODES.internal, {
      cause: error,
    });
  }
  return new CliError("INTERNAL", String(error), EXIT_CODES.internal, { cause: error });
}

export function errorEnvelope(error: unknown): { envelope: ErrorEnvelope; exitCode: number } {
  const cli = toCliError(error);
  const body: ErrorBody = {
    code: cli.code,
    message: cli.message,
    ...(cli.details !== undefined ? { details: cli.details } : {}),
    ...(cli.diagnostics !== undefined && cli.diagnostics.length > 0
      ? { diagnostics: cli.diagnostics }
      : {}),
  };
  const envelope: ErrorEnvelope = {
    ...(cli.extras ?? {}),
    ok: false,
    error: body,
  };
  return { envelope, exitCode: cli.exitCode };
}
