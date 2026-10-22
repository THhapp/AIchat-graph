import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

/** replace: 覆盖既有文件；create: 目标必须不存在，绝不覆盖。 */
export type AtomicWriteMode = "create" | "replace";

/** 底层原子写入函数：接收绝对路径、完整新字节与写入模式。 */
export type AtomicWriter = (
  absolutePath: string,
  data: Uint8Array,
  mode: AtomicWriteMode,
) => Promise<void>;

/** 目录 fsync 在 Windows 上通常不可用，属于尽力而为。 */
export async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // 源文件本身已 fsync；目录项持久化失败不单独升级为错误。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * 覆盖写入使用 write-file-atomic（静态依赖，缺失时构建期即失败）。
 * 该库负责临时文件、fsync 与 rename，不在这里另造替代实现。
 */
export async function writeFileDurable(
  absolutePath: string,
  data: Uint8Array,
): Promise<void> {
  await writeFileAtomic(absolutePath, Buffer.from(data), { fsync: true });
}

/**
 * 新建文件：先写同目录临时文件并 fsync，再用硬链接发布。
 * link 在目标已存在时以 EEXIST 失败，因此并发创建的第三方文件不会被覆盖。
 * 这是 write-file-atomic 不具备的独占创建原语，不是覆盖提交的替代实现。
 */
export async function writeFileCreateExclusive(
  absolutePath: string,
  data: Uint8Array,
): Promise<void> {
  const directory = path.dirname(absolutePath);
  const temporary = path.join(
    directory,
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fs.link(temporary, absolutePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await fs.rm(temporary, { force: true }).catch(() => undefined);
  await syncDirectoryBestEffort(directory);
}

export const defaultAtomicWriter: AtomicWriter = async (absolutePath, data, mode) => {
  if (mode === "create") {
    await writeFileCreateExclusive(absolutePath, data);
    return;
  }
  await writeFileDurable(absolutePath, data);
};