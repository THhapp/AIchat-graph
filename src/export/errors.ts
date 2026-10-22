import type { ExportErrorCode } from './types.js';

export interface ExportErrorOptions {
  cause?: unknown;
  path?: string;
}

/** 导出失败时抛出；调用方据 code 显示具体原因，不静默降级。 */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly path?: string;

  constructor(code: ExportErrorCode, message: string, options: ExportErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExportError';
    this.code = code;
    if (options.path !== undefined) this.path = options.path;
  }
}
