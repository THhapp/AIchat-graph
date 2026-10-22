/**
 * 文件监听：只关心 workspace.json 与 topics 下的 Markdown。
 *
 * - 不使用 glob 作为过滤契约；用目录 + ignored 规则，忽略 .aichat、.git、
 *   node_modules、隐藏/临时文件，并拒绝跟随工作区外的符号链接；
 * - atomic + awaitWriteFinish(300ms/100ms)，事件再批处理 150ms；
 * - 只上报"有变化"这一事实，重读、校验与发布由协调器在统一队列里完成。
 */
import { watch, type FSWatcher } from "chokidar";
import type { Stats } from "node:fs";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([".aichat", ".git", "node_modules"]);
const TEMPORARY_SUFFIXES = [".tmp", ".temp", ".swp", ".swx", "~"];
const TEMPORARY_PATTERN = /(^|\/)\.[^/]*\.(tmp|temp|swp|swx)$|(^|\/)[^/]*~$/;

export const WATCH_STABILITY_MS = 300;
export const WATCH_POLL_MS = 100;
export const WATCH_BATCH_MS = 150;

export interface WorkspaceWatcherOptions {
  readonly rootReal: string;
  /** 任何相关文件变化后的回调；实现方在自身队列里重读。 */
  readonly onChange: (paths: readonly string[]) => void;
  /** watcher 自身错误；调用方记录诊断，不据此自动改内容。 */
  readonly onError?: (error: unknown) => void;
}

export interface WorkspaceWatcher {
  close(): Promise<void>;
}

function toRelative(rootReal: string, changed: string): string | null {
  const absolute = path.isAbsolute(changed) ? changed : path.resolve(changed);
  const relative = path.relative(rootReal, absolute);
  if (relative === "" || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

/** 会被正文引用的栅格资源扩展名；与 export 的资源捕获范围一致。 */
const RESOURCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function hasWatchedExtension(relative: string): boolean {
  const lowered = relative.toLowerCase();
  if (lowered.startsWith("topics/")) return lowered.endsWith(".md");
  if (lowered.startsWith("resources/")) {
    const dot = lowered.lastIndexOf(".");
    return dot >= 0 && RESOURCE_EXTENSIONS.has(lowered.slice(dot));
  }
  return false;
}

/**
 * 只接受 workspace.json、topics 下的 Markdown，以及 resources 下的栅格资源。
 *
 * 资源变化同样会改变快照指纹并触发导出；隐藏文件、临时文件与目录越界
 * 仍被忽略（路径已由 watcher 归一为工作区相对路径）。
 */
export function isWatchedRelativePath(relative: string): boolean {
  if (relative === "workspace.json") return true;
  if (!hasWatchedExtension(relative)) return false;
  const segments = relative.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (segment.startsWith(".")) return false;
  }
  if (TEMPORARY_PATTERN.test(relative)) return false;
  return true;
}

function isTemporaryName(name: string): boolean {
  if (name.startsWith(".") && name !== "." && name !== "..") return true;
  return TEMPORARY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** ignored 规则：目录级忽略 + 临时文件 + 外部 symlink。 */
function makeIgnored(rootReal: string) {
  return (candidate: string, stats?: Stats): boolean => {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    const relative = path.relative(rootReal, absolute);
    if (relative === "") return false;
    if (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return true;
    const segments = relative.split(path.sep);
    for (const segment of segments) {
      if (IGNORED_DIRECTORIES.has(segment)) return true;
      if (isTemporaryName(segment)) return true;
    }
    if (stats?.isSymbolicLink()) return true;
    const base = path.basename(absolute);
    if (base.startsWith(".") && base !== "workspace.json") return true;
    if (isTemporaryName(base)) return true;
    // 非 workspace.json、非 topics／resources 的条目不是监听目标。
    const normalized = relative.split(path.sep).join("/");
    if (normalized === "topics" || normalized === "resources") return false;
    if (normalized.startsWith("topics/")) {
      return stats?.isFile() === true && !normalized.toLowerCase().endsWith(".md");
    }
    if (normalized.startsWith("resources/")) {
      return stats?.isFile() === true && !hasWatchedExtension(normalized);
    }
    return normalized !== "workspace.json";
  };
}

/**
 * 启动监听。初始扫描不触发重读（协调器启动时已经全量加载），
 * 事件按 150ms 批处理，重复路径合并。
 */
export async function startWatcher(options: WorkspaceWatcherOptions): Promise<WorkspaceWatcher> {
  const { rootReal, onChange, onError } = options;
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const flush = (): void => {
    timer = null;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    if (!closed) onChange(paths);
  };

  const schedule = (relative: string): void => {
    if (closed) return;
    if (!isWatchedRelativePath(relative)) return;
    pending.add(relative);
    if (timer !== null) return;
    timer = setTimeout(flush, WATCH_BATCH_MS);
    timer.unref();
  };

  const watcher: FSWatcher = watch(rootReal, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: WATCH_STABILITY_MS,
      pollInterval: WATCH_POLL_MS,
    },
    // 与 storage 的路径深度上限保持一致（MAX_DEPTH=32）。
    depth: 32,
    ignored: makeIgnored(rootReal),
  });

  watcher.on("all", (event, changedPath) => {
    if (event !== "add" && event !== "change" && event !== "unlink") return;
    const relative = toRelative(rootReal, changedPath);
    if (relative === null) return;
    schedule(relative);
  });
  watcher.on("error", (error) => {
    onError?.(error);
  });

  return {
    async close(): Promise<void> {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      await watcher.close();
    },
  };
}