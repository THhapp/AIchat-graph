/**
 * 服务公共入口。
 *
 * 导入本模块没有任何自动启动副作用；只有调用 startService 才创建监听、
 * 获取写锁并发布 .aichat/runtime/service.json。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.js";
import { ExportCoordinator } from "./export.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  WorkspaceRuntime,
  type WorkspaceHandle,
} from "./workspace.js";
import { ServiceError, serviceErrorFromUnknown } from "./errors.js";

export interface StartServiceOptions {
  /** 工作区目录；解析为真实路径后作为信任锚。 */
  readonly root: string;
  /** 默认 127.0.0.1:4317；端口被占用时明确失败，不静默换端口。 */
  readonly port?: number | undefined;
}

export interface ServiceHandle {
  readonly url: string;
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly rootPath: string;
  stop(): Promise<void>;
}

export { DEFAULT_HOST, DEFAULT_PORT };
export type { WorkspaceHandle };

/**
 * 定位构建后的前端产物：从当前模块向上找到包根（package.json），
 * 再用 <包根>/dist/web。源码运行时同样指向已构建产物，不误用 src/web。
 */
/** 从当前模块向上找到包根（含 package.json）；找不到时返回 null。 */
function packageRoot(): string | null {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function defaultWebRoot(): string | null {
  const root = packageRoot();
  return root === null ? null : path.join(root, "dist", "web");
}

/** 构建好的离线读者资源目录（dist/offline）；导出只读取，不执行构建。 */
function defaultOfflineDirectory(): string {
  const root = packageRoot();
  return root === null ? path.join(process.cwd(), "dist", "offline") : path.join(root, "dist", "offline");
}

async function existsDirectory(target: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceError(400, "INVALID_ARGUMENT", "port 必须是 1-65535 的整数", {
      details: { port },
    });
  }
}

/**
 * 启动单工作区本地服务。
 *
 * 顺序：realpath → runtime 目录 → 写锁 → 恢复事务 → 全量加载验证 →
 * HTTP 监听 → watcher → 发布 service.json。任何一步失败都清理自己已获取的资源，
 * 不删除别人的描述文件。
 */
export async function startService(options: StartServiceOptions): Promise<ServiceHandle> {
  const port = options.port ?? DEFAULT_PORT;
  assertPort(port);

  let runtime: WorkspaceRuntime | null = null;
  let coordinator: ExportCoordinator | null = null;
  try {
    runtime = await WorkspaceRuntime.create(options.root);
    const webRootCandidate = defaultWebRoot();
    const webRoot =
      webRootCandidate !== null && (await existsDirectory(webRootCandidate))
        ? webRootCandidate
        : null;
    const appRoot = packageRoot() ?? process.cwd();
    coordinator = new ExportCoordinator({
      runtime,
      appRoot,
      offlineDirectory: defaultOfflineDirectory(),
    });
    // 导出失败只影响导出状态，不能阻断服务启动（读者资源缺失时状态说明原因）。
    await coordinator.init().catch(() => undefined);
    const active = runtime;
    active.onPublished = async (reason: string) => {
      await coordinator?.scheduleAll(reason);
    };

    const app = createApp({ runtime, webRoot, exports: coordinator });
    await runtime.listen(port, app.fetch);
    await runtime.startWatching();
    await runtime.publishDescriptor();

    const handle: ServiceHandle = {
      url: runtime.url,
      workspaceId: runtime.workspaceId,
      instanceId: runtime.instanceId,
      rootPath: runtime.rootReal,
      stop: async () => {
        active.onPublished = null;
        await coordinator?.stop().catch(() => undefined);
        await active.stop();
        runtime?.editRefs.clear();
      },
    };
    return handle;
  } catch (error) {
    await coordinator?.stop().catch(() => undefined);
    await runtime?.stop().catch(() => undefined);
    throw serviceErrorFromUnknown(error);
  }
}

export type {
  ChangeRecord,
  ReloadResult,
} from "./workspace.js";
export type { CurrentSnapshot } from "./state.js";
export type { SnapshotData, TopicSnapshot } from "./snapshot.js";
export type { CheckResult, ApplyResult, CheckedFile, CommittedFileView } from "./changes.js";
export { CLIENT_HEADER, CLIENT_HEADER_VALUE, MAX_BODY_BYTES } from "./server.js";