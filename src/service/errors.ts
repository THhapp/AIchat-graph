/**
 * 服务层错误与对外错误映射。
 *
 * 传输错误统一为 { error: { code, message, diagnostics?, details? } }；
 * 存储与候选编辑的错误码在这里映射为 HTTP 状态，不复制其业务规则。
 */
import type { Diagnostic as CoreDiagnostic } from "../core/index.js";
import { ChangeError, StorageError, type StorageDiagnostic } from "../storage/index.js";
import type { Diagnostic } from "../shared/protocol.js";

export interface ServiceErrorOptions {
  details?: unknown;
  diagnostics?: readonly Diagnostic[] | undefined;
  cause?: unknown;
}

/** 服务内部与传输层共享的错误类型。status 为对外 HTTP 状态。 */
export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly diagnostics: readonly Diagnostic[] | undefined;

  constructor(status: number, code: string, message: string, options: ServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.diagnostics = options.diagnostics;
  }
}

/** core 诊断转为传输 DTO：范围拆成 offset／endOffset，topicPath 改名 path。 */
export function toWireDiagnostic(diagnostic: CoreDiagnostic): Diagnostic {
  const output: Diagnostic = {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: "error",
  };
  if (diagnostic.topicPath !== undefined) output.path = diagnostic.topicPath;
  if (diagnostic.topicId !== undefined) output.topicId = diagnostic.topicId;
  if (diagnostic.nodeId !== undefined) output.nodeId = diagnostic.nodeId;
  if (diagnostic.range !== undefined) {
    output.offset = diagnostic.range.start;
    output.endOffset = diagnostic.range.end;
  }
  return output;
}

export function wireDiagnostic(
  code: string,
  message: string,
  path?: string | undefined,
  severity: Diagnostic["severity"] = "error",
): Diagnostic {
  const output: Diagnostic = { code, message };
  if (severity !== undefined) output.severity = severity;
  if (path !== undefined) output.path = path;
  return output;
}

/** 扫描／候选模块的 StorageDiagnostic 只是路径级提醒，不是内容校验错误。 */
export function toWireStorageDiagnostic(
  diagnostic: StorageDiagnostic,
  severity: Diagnostic["severity"] = "warning",
): Diagnostic {
  return wireDiagnostic(diagnostic.code, diagnostic.message, diagnostic.path, severity);
}

function changeDiagnostics(error: ChangeError): Diagnostic[] {
  return error.diagnostics?.map(toWireDiagnostic) ?? [];
}

export function serviceErrorFromChange(error: ChangeError): ServiceError {
  const status =
    error.code === "VERSION_CONFLICT"
      ? 412
      : error.code === "OPERATION_CONFLICT"
        ? 409
        : error.code === "VALIDATION_FAILED"
          ? 422
          : 400;
  const code =
    error.code === "VERSION_CONFLICT"
      ? "VERSION_CONFLICT"
      : error.code === "OPERATION_CONFLICT"
        ? "OPERATION_CONFLICT"
        : error.code === "VALIDATION_FAILED"
          ? "VALIDATION_FAILED"
          : "BAD_REQUEST";
  return new ServiceError(status, code, error.message, {
    details: error.details === undefined ? undefined : error.details,
    diagnostics: changeDiagnostics(error),
    cause: error,
  });
}

const BAD_PATH_CODES = new Set([
  "INVALID_ARGUMENT",
  "INVALID_PATH",
  "PATH_UNSAFE",
  "PATH_NOT_ALLOWED",
  "PATH_OUTSIDE_WORKSPACE",
  "DUPLICATE_PATH",
]);

export function serviceErrorFromStorage(error: StorageError): ServiceError {
  const details: Record<string, unknown> = {};
  if (error.details !== undefined) Object.assign(details, error.details);
  details["storageCode"] = error.code;
  if (error.path !== undefined) details["path"] = error.path;
  const diagnostics = error.path === undefined
    ? []
    : [{ code: error.code, message: error.message, path: error.path, severity: "error" as const }];

  if (error.code === "VERSION_CONFLICT" || error.code === "FILE_EXISTS") {
    return new ServiceError(412, "VERSION_CONFLICT", error.message, {
      details,
      diagnostics,
      cause: error,
    });
  }
  if (error.code === "PENDING_TRANSACTION") {
    return new ServiceError(409, "OPERATION_CONFLICT", error.message, {
      details,
      diagnostics,
      cause: error,
    });
  }
  if (BAD_PATH_CODES.has(error.code)) {
    return new ServiceError(400, "BAD_REQUEST", error.message, {
      details,
      diagnostics,
      cause: error,
    });
  }
  if (error.code === "WORKSPACE_INVALID" || error.code === "WORKSPACE_NOT_FOUND") {
    return new ServiceError(422, "VALIDATION_FAILED", error.message, {
      details,
      diagnostics,
      cause: error,
    });
  }
  return new ServiceError(500, error.code, error.message, {
    details,
    diagnostics,
    cause: error,
  });
}

/** 内部未知错误不把栈或原始对象带到传输层。 */
export function serviceErrorFromUnknown(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof ChangeError) return serviceErrorFromChange(error);
  if (error instanceof StorageError) return serviceErrorFromStorage(error);
  return new ServiceError(500, "INTERNAL", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}
