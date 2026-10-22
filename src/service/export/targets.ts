/** 导出目标的规范化与路径防护；调用时机和覆盖字节授权由协调器保持。 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { isErrnoCode } from "../../storage/index.js";
import { ServiceError } from "../errors.js";
import type { WorkspaceRuntime } from "../workspace.js";

export function isAbsoluteHtml(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  if (value.startsWith("\\\\") || value.startsWith("//")) return false;
  // 目录名之外的冒号（NTFS ADS）一律拒绝；盘符后的冒号不算。
  const withoutDrive = /^[A-Za-z]:/.test(value) ? value.slice(2) : value;
  if (withoutDrive.includes(":")) return false;
  if (value.includes("\u0000")) return false;
  return path.extname(value).toLowerCase() === ".html";
}

export interface TargetResolution {
  /** 用户给出的绝对路径（仅用于报告）。 */
  absolute: string;
  /** 规范化后的真实目标：父目录 realpath + 文件名；所有安全判断与写入都用它。 */
  canonical: string;
  /** 目标自身的真实路径（不存在时为 null）。 */
  canonicalExisting: string | null;
  exists: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

/**
 * 逐级检查用户给出的父路径链：任何一级是 symlink／junction 都不接受。
 *
 * 合同要求"拒绝链接"，不只是拒绝指向工作区／应用根的链接：否则授权后把父 alias
 * 改指别处，同一字面路径就会悄悄写到另一个真实位置。这里在授权与 finalize 共用，
 * 提示调用方改用真实路径。只检查真实存在的祖先，第一段不存在即止（其余更深的
 * 段也不可能存在）。
 */
async function assertNoLinkedParent(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const parent = path.dirname(absolute);
  // 用相对 root 的段累加，避免把 "C:" 当成第一段拼出 "C:\C:"（Windows 下会
  // 立刻 ENOENT，等于整条检查被跳过）。
  const root = path.parse(parent).root;
  const segments = path.relative(root, parent).split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return parent; // 更深的祖先不存在
      throw new ServiceError(
        422,
        "EXPORT_TARGET_INVALID",
        "无法检查导出目标路径：" + current,
        { details: { path: value }, cause: error },
      );
    }
    if (stat.isSymbolicLink()) {
      throw new ServiceError(
        422,
        "EXPORT_TARGET_UNSAFE",
        "导出目标的父路径含有符号链接或 junction：" + current + "；请改用真实目录路径",
        { details: { path: value, linkedAncestor: current } },
      );
    }
  }
  return parent;
}

/**
 * 外部绝对路径归一化。
 *
 * 1) 逐级拒绝父链中的 symlink／junction（不是只拒指向保护根的链接）；
 * 2) 用 realpath 解析父目录后再拼文件名，后续的工作区／应用根判断与写入
 *    都使用 canonical 路径；仅比较用户输入的字面路径会被目录 alias 绕过。
 */
export async function resolveTarget(value: string): Promise<TargetResolution> {
  const absolute = path.resolve(value);
  const parent = await assertNoLinkedParent(absolute);
  let parentReal: string;
  try {
    parentReal = await fs.realpath(parent);
  } catch (error) {
    throw new ServiceError(
      422,
      "EXPORT_TARGET_INVALID",
      "导出目标的父目录不存在或不可访问：" + parent,
      { details: { path: value }, cause: error },
    );
  }
  const canonical = path.join(parentReal, path.basename(absolute));
  const stat = await fs.lstat(canonical).catch((error: unknown) => {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw error;
  });
  if (stat === null) {
    return {
      absolute,
      canonical,
      canonicalExisting: null,
      exists: false,
      isFile: false,
      isSymlink: false,
    };
  }
  // 目标本身是符号链接／junction：拒绝（不跟随到别处写入）。
  let canonicalExisting: string | null = null;
  if (stat.isSymbolicLink()) {
    return {
      absolute,
      canonical,
      canonicalExisting: null,
      exists: true,
      isFile: false,
      isSymlink: true,
    };
  }
  canonicalExisting = await fs.realpath(canonical).catch(() => canonical);
  return {
    absolute,
    canonical,
    canonicalExisting,
    exists: true,
    isFile: stat.isFile(),
    isSymlink: false,
  };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

/** 工作区与应用根的 canonical 形式；用于和真实目标比较。 */
async function canonicalRoots(runtime: WorkspaceRuntime, appRoot: string): Promise<{
  workspace: string;
  app: string;
}> {
  const workspace = await fs.realpath(runtime.rootReal).catch(() => runtime.rootReal);
  const app = await fs.realpath(appRoot).catch(() => appRoot);
  return { workspace, app };
}

/** 目标是否落在工作区或应用根内部（都按 canonical 比较）。 */
export async function targetInsideRoots(
  runtime: WorkspaceRuntime,
  appRoot: string,
  resolution: TargetResolution,
): Promise<{ insideWorkspace: boolean; insideApp: boolean }> {
  const roots = await canonicalRoots(runtime, appRoot);
  const candidate = resolution.canonicalExisting ?? resolution.canonical;
  return {
    insideWorkspace: isInside(roots.workspace, candidate),
    insideApp: isInside(roots.app, candidate),
  };
}
