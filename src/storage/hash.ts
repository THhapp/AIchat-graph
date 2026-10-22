import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 对原始字节计算小写十六进制 SHA-256；字符串按 UTF-8 编码后计算。 */
export function sha256Bytes(data: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return hash.digest("hex");
}

/** 流式计算磁盘原始字节的 SHA-256。 */
export async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export function isSha256Hex(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isSha256Hex(normalized)) {
    throw new Error(`无效的 SHA-256 值: ${value}`);
  }
  return normalized;
}

export const EMPTY_SHA256 = sha256Bytes(new Uint8Array(0));
