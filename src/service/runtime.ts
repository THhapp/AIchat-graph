/**
 * .aichat/runtime 下的服务描述文件与锁路径。
 *
 * service.json 只写本实例身份；退出时只有在文件仍属于本 instanceId 时才删除，
 * 绝不清理其他会话的描述文件。写入使用 storage 的原子写与路径校验。
 */
import { promises as fs } from "node:fs";
import {
  assertPathInsideWorkspace,
  ensureWorkspaceDirectory,
  isErrnoCode,
  writeFileDurable,
} from "../storage/index.js";

export const RUNTIME_DIR = ".aichat/runtime";
export const SERVICE_DESCRIPTOR_PATH = ".aichat/runtime/service.json";
export const WRITER_LOCK_PATH = ".aichat/runtime/writer.lock";

export interface ServiceDescriptor {
  readonly url: string;
  readonly rootPath: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly pid: number;
}

/** 安全创建 runtime 目录；祖先出现符号链接／junction 时由 storage 拒绝。 */
export async function ensureRuntimeDirectory(rootReal: string): Promise<string> {
  return ensureWorkspaceDirectory(rootReal, RUNTIME_DIR);
}

export async function writeServiceDescriptor(
  rootReal: string,
  descriptor: ServiceDescriptor,
): Promise<void> {
  const absolutePath = await assertPathInsideWorkspace(rootReal, SERVICE_DESCRIPTOR_PATH);
  await writeFileDurable(
    absolutePath,
    Buffer.from(JSON.stringify(descriptor, null, 2) + "\n", "utf8"),
  );
}

async function readDescriptorRaw(rootReal: string): Promise<Record<string, unknown> | null> {
  const absolutePath = await assertPathInsideWorkspace(rootReal, SERVICE_DESCRIPTOR_PATH);
  let text: string;
  try {
    text = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 只删除仍属于本 instanceId 的描述文件。 */
export async function removeOwnDescriptor(
  rootReal: string,
  instanceId: string,
): Promise<boolean> {
  const raw = await readDescriptorRaw(rootReal);
  if (raw === null || raw["instanceId"] !== instanceId) return false;
  const absolutePath = await assertPathInsideWorkspace(rootReal, SERVICE_DESCRIPTOR_PATH);
  try {
    await fs.rm(absolutePath, { force: true });
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
  return true;
}
