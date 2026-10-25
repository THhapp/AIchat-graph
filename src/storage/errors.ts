/**
 * 存储层的错误与诊断类型。
 *
 * 错误码是稳定的调用契约：service／CLI 依此映射 412 冲突、409 操作冲突等。
 * 这里不引入 core 的类型，保持纯文件层可独立使用。
 */

export type StorageErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_UNSAFE"
  | "PATH_NOT_ALLOWED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_INVALID"
  | "WORKSPACE_EXISTS"
  | "INIT_FAILED"
  | "FILE_EXISTS"
  | "VERSION_CONFLICT"
  | "DUPLICATE_PATH"
  | "PENDING_TRANSACTION"
  | "TRANSACTION_INVALID"
  | "RECOVERY_CONFLICT"
  | "WRITE_FAILED"
  | "WRITE_VERIFICATION_FAILED"
  | "RECOVERY_REQUIRED"
  | "COMMITTED_REFRESH_PENDING";

export interface StorageDiagnostic {
  code: string;
  message: string;
  /** 工作区相对路径（POSIX 分隔符），适用于文件相关诊断。 */
  path?: string;
}

export interface StorageErrorOptions {
  path?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** 存储层统一错误；cause 保留底层 fs／解析错误，便于日志定位。 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly path: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorageError";
    this.code = code;
    this.path = options.path;
    this.details = options.details;
  }
}

/** 供内部捕获 fs 错误码使用。 */
export function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}
