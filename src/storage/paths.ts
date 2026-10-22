import { promises as fs } from "node:fs";
import path from "node:path";
import { StorageError, isErrnoCode } from "./errors.js";

/**
 * 路径规则（storage 的信任边界）：
 * - 所有对外路径都是工作区相对路径，使用 "/" 分隔；
 * - 拒绝绝对路径、盘符、"."／".."、空段、NUL、Windows 保留名与尾随点／空格；
 * - 写入只允许 workspace.json 与 topics/**\/*.md（不含隐藏文件）；
 * - 任何已存在的路径分量是符号链接／junction 时拒绝，防止越界。
 */

const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;
const MAX_DEPTH = 32;

export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new StorageError("INVALID_PATH", "路径不能为空");
  }
  if (input.includes("\u0000")) {
    throw new StorageError("INVALID_PATH", "路径不能包含 NUL 字符", { path: input });
  }
  const raw = input.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/")) {
    throw new StorageError("PATH_OUTSIDE_WORKSPACE", `只接受工作区相对路径: ${input}`, {
      path: input,
    });
  }
  const segments = raw.split("/");
  if (segments.length > MAX_DEPTH) {
    throw new StorageError("INVALID_PATH", `路径层级过深: ${input}`, { path: input });
  }
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "") {
      throw new StorageError("INVALID_PATH", `路径不能包含空段: ${input}`, { path: input });
    }
    if (segment === ".") {
      throw new StorageError("INVALID_PATH", `路径不能包含 "." 段: ${input}`, { path: input });
    }
    if (segment === "..") {
      throw new StorageError("PATH_OUTSIDE_WORKSPACE", `路径不能包含 "..": ${input}`, {
        path: input,
      });
    }
    if (INVALID_SEGMENT_CHARS.test(segment)) {
      throw new StorageError("INVALID_PATH", `路径包含非法字符: ${input}`, { path: input });
    }
    if (/[. ]$/.test(segment)) {
      throw new StorageError("INVALID_PATH", `路径段不能以点或空格结尾: ${input}`, {
        path: input,
      });
    }
    if (WINDOWS_RESERVED_SEGMENT.test(segment)) {
      throw new StorageError("INVALID_PATH", `路径包含 Windows 保留名: ${input}`, {
        path: input,
      });
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}

/**
 * 写入允许的内容文件：workspace.json 或 topics 下非隐藏的 .md。
 * 与 readWorkspaceFiles 的扫描规则一致：隐藏目录里的文件不会被读取，也不允许写入。
 */
export function isWritableContentPath(relativePath: string): boolean {
  if (relativePath === "workspace.json") return true;
  if (!relativePath.startsWith("topics/")) return false;
  if (!relativePath.toLowerCase().endsWith(".md")) return false;
  const segments = relativePath.split("/");
  return segments.every((segment, index) => index === 0 || !segment.startsWith("."));
}

/**
 * 规范化工作区根；根目录本身可为符号链接，返回其真实路径。
 * 工作区根用作信任锚，必须是非符号链接的真实目录（或其链接目标），
 * 之后所有相对路径都在该真实路径下逐级校验。
 */
export async function resolveWorkspaceRoot(root: string): Promise<string> {
  if (typeof root !== "string" || root.trim().length === 0) {
    throw new StorageError("WORKSPACE_NOT_FOUND", "工作区路径不能为空");
  }
  const absolute = path.resolve(root);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
      throw new StorageError("WORKSPACE_NOT_FOUND", `工作区目录不存在: ${absolute}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new StorageError("WORKSPACE_NOT_FOUND", `工作区路径不是目录: ${absolute}`);
  }
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    throw new StorageError("WORKSPACE_NOT_FOUND", `无法解析工作区真实路径: ${absolute}`, {
      cause: error,
    });
  }
  const realStat = await fs.stat(real);
  if (!realStat.isDirectory()) {
    throw new StorageError("WORKSPACE_NOT_FOUND", `工作区路径不是目录: ${absolute}`);
  }
  return real;
}

/** 结合根与相对路径得到绝对路径，并验证未越界。 */
export function resolveWorkspacePath(rootReal: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(rootReal, ...normalized.split("/"));
  const relative = path.relative(rootReal, absolute);
  if (
    relative === "" ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new StorageError("PATH_OUTSIDE_WORKSPACE", `路径越过工作区: ${relativePath}`, {
      path: relativePath,
    });
  }
  return absolute;
}

async function lstatOrNull(absolutePath: string) {
  try {
    return await fs.lstat(absolutePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) return null;
    throw error;
  }
}

/**
 * 校验相对路径的每一级已存在分量：不允许符号链接／junction，
 * 中间分量必须是目录，并再次用 realpath 确认仍在工作区内。
 * 返回绝对路径（文件或目录可以尚不存在）。
 */
export async function assertPathInsideWorkspace(
  rootReal: string,
  relativePath: string,
): Promise<string> {
  const absolute = resolveWorkspacePath(rootReal, relativePath);
  const segments = normalizeRelativePath(relativePath).split("/");
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string);
    const stat = await lstatOrNull(current);
    if (stat === null) {
      // 后续分量也不可能存在；已有部分已逐级检查。
      return absolute;
    }
    if (stat.isSymbolicLink()) {
      throw new StorageError(
        "PATH_UNSAFE",
        `路径包含符号链接，拒绝访问: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new StorageError(
        "PATH_UNSAFE",
        `路径的上级分量不是目录: ${relativePath}`,
        { path: relativePath },
      );
    }
    const real = await fs.realpath(current);
    const fromRoot = path.relative(rootReal, real);
    if (fromRoot.startsWith(".." + path.sep) || path.isAbsolute(fromRoot)) {
      throw new StorageError("PATH_OUTSIDE_WORKSPACE", `路径越过工作区: ${relativePath}`, {
        path: relativePath,
      });
    }
  }
  return absolute;
}

/**
 * 逐级确保工作区内的目录存在；已存在分量必须是真实目录（不能是符号链接）。
 * 仅用于 .aichat 运行时目录和 topics 子目录的受控创建。
 */
export async function ensureWorkspaceDirectory(
  rootReal: string,
  relativeDir: string,
): Promise<string> {
  const normalized = normalizeRelativePath(relativeDir);
  const segments = normalized.split("/");
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat === null) {
      try {
        await fs.mkdir(current);
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
      }
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new StorageError("PATH_UNSAFE", `无法创建安全目录: ${relativeDir}`, {
          path: relativeDir,
        });
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new StorageError("PATH_UNSAFE", `目录路径不安全: ${relativeDir}`, {
        path: relativeDir,
      });
    }
    const real = await fs.realpath(current);
    const fromRoot = path.relative(rootReal, real);
    if (fromRoot.startsWith(".." + path.sep) || path.isAbsolute(fromRoot)) {
      throw new StorageError("PATH_OUTSIDE_WORKSPACE", `目录越界: ${relativeDir}`, {
        path: relativeDir,
      });
    }
  }
  return current;
}

/** 校验可写内容路径并返回绝对路径；.aichat 等目录不可通过提交写入。 */
export async function resolveWritableContentPath(
  rootReal: string,
  relativePath: string,
): Promise<string> {
  const normalized = normalizeRelativePath(relativePath);
  if (!isWritableContentPath(normalized)) {
    throw new StorageError(
      "PATH_NOT_ALLOWED",
      `受控写入只允许 workspace.json 与 topics 下的 Markdown: ${relativePath}`,
      { path: normalized },
    );
  }
  return assertPathInsideWorkspace(rootReal, normalized);
}