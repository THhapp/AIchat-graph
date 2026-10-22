import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initWorkspace, sha256Bytes } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import { readExportMarkers } from "../../src/export/index.js";
import { WorkspaceRuntime } from "../../src/service/workspace.js";
import { ExportCoordinator } from "../../src/service/export.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const ROOT_NODE = "n_" + "a".repeat(32);
const NEXT_NODE = "n_" + "b".repeat(32);
const TOPIC_ID = "t_" + "c".repeat(32);
const DIR = "导出";

function nodeFile(nodeId: string, title: string, flow: "root" | "next", from: string | null, body: string): string {
  const lines = [
    "---",
    "nodeId: " + nodeId,
    "title: " + title,
    "state: agreed",
    "from: " + (from ?? "null"),
    "flow: " + flow,
  ];
  if (from !== null) lines.push("description: 承接上一张卡片");
  lines.push("---", "", body, "");
  return lines.join("\n");
}

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-export-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "export-test" });
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 导出样例\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, ROOT_NODE + ".md"),
    nodeFile(ROOT_NODE, "起点", "root", null, "第一段正文。"),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, NEXT_NODE + ".md"),
    nodeFile(NEXT_NODE, "继续", "next", ROOT_NODE, "第二段正文。"),
    "utf8",
  );
  return fs.realpath(root);
}

async function newOutputDir(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-export-out-"));
  temporaryRoots.push(parent);
  return fs.realpath(parent);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const value = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(value));
    });
  });
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function headers(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待导出状态超时");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface StatusView {
  topicId: string;
  state: string;
  targetPath: string | null;
  sourceFingerprint: string | null;
  exportedFingerprint: string | null;
  error: string | null;
  targetPresent: boolean;
}

async function statusOf(url: string, topicId: string): Promise<StatusView> {
  const body = (await (await fetch(url + "/api/exports")).json()) as { topics: StatusView[] };
  const status = body.topics.find((entry) => entry.topicId === topicId);
  if (status === undefined) throw new Error("缺少主题状态");
  return status;
}

describe("自动导出", () => {
  it("未绑定时 unset；绑定后在有效发布上自动生成，但不会覆盖无关文件", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const initial = await statusOf(handle.url, TOPIC_ID);
    expect(initial.state).toBe("unset");
    expect(initial.targetPath).toBeNull();

    // 目标已有无关文件：拒绝绑定。
    const occupied = path.join(output, "occupied.html");
    await fs.writeFile(occupied, "<html>用户自己的文件</html>", "utf8");
    const rejected = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: occupied }),
    });
    expect(rejected.status).toBe(422);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe(
      "EXPORT_TARGET_OCCUPIED",
    );
    expect(await fs.readFile(occupied, "utf8")).toBe("<html>用户自己的文件</html>");

    // 工作区内部：拒绝。
    const insideWorkspace = await fetch(
      handle.url + "/api/exports/" + TOPIC_ID + "/target",
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ path: path.join(root, "out.html") }),
      },
    );
    expect(insideWorkspace.status).toBe(422);
    expect(
      ((await insideWorkspace.json()) as { error: { code: string } }).error.code,
    ).toBe("EXPORT_TARGET_FORBIDDEN");

    // 非 .html / 相对路径：拒绝。
    const wrongExt = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: path.join(output, "x.md") }),
    });
    expect(wrongExt.status).toBe(422);

    // 合法目标：绑定后自动生成。
    const target = path.join(output, "topic.html");
    const bound = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: target }),
    });
    expect(bound.status).toBe(200);
    // 首次合法绑定：目标文件尚未生成是正常的"待生成"，响应不能报错。
    const boundBody = (await bound.json()) as { state: string; targetPath: string | null };
    expect(boundBody.state).not.toBe("error");
    expect(["pending", "writing", "ready"]).toContain(boundBody.state);
    expect(boundBody.targetPath).toBe(target);

    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");
    const ready = await statusOf(handle.url, TOPIC_ID);
    expect(ready.targetPresent).toBe(true);
    expect(ready.exportedFingerprint).toBeTruthy();
    expect(ready.exportedFingerprint).toBe(ready.sourceFingerprint);
    const html = await fs.readFile(target, "utf8");
    const markers = readExportMarkers(html);
    expect(markers?.workspaceId).toBe(handle.workspaceId);
    expect(markers?.topicId).toBe(TOPIC_ID);
    expect(markers?.contentFingerprint).toBe(ready.sourceFingerprint);
    expect(html).toContain("aichat-export-data");
    // 自包含：没有外部脚本／样式引用。
    expect(html).not.toMatch(/<script[^>]+src="http/);
    expect(html).not.toMatch(/<link[^>]+href="http/);
    // 成品文件不在工作区内，且是单文件。
    expect(target.startsWith(root)).toBe(false);
  });

  it("源变化触发重导出；目标被外部改动时拒绝覆盖并保留旧成品", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);
    const target = path.join(output, "topic.html");
    await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: target }),
    });
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");
    const firstHtml = await fs.readFile(target, "utf8");
    const firstMarkers = readExportMarkers(firstHtml);

    // 外部占位修改：模拟用户/其他程序改了这个文件。
    await fs.writeFile(target, firstHtml + "\n<!-- 外部改动 -->\n", "utf8");
    const tampered = await fs.readFile(target, "utf8");

    // 源更新：托管写入触发新 revision 与导出。
    const read = (await (await fetch(handle.url + "/api/agent/nodes/" + ROOT_NODE)).json()) as {
      editRef: { ref: string };
    };
    const changed = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        action: {
          action: "patchNode",
          editRef: read.editRef.ref,
          append: "补充一段新的正文。",
        },
      }),
    });
    expect(changed.status).toBe(200);

    await waitFor(async () => {
      const status = await statusOf(handle.url, TOPIC_ID);
      return status.state === "error" && (status.error ?? "").length > 0;
    });
    const failed = await statusOf(handle.url, TOPIC_ID);
    expect(failed.error).toContain("目标文件已被外部改动");
    // 旧成品（含外部改动）保留，不被新内容覆盖。
    expect(await fs.readFile(target, "utf8")).toBe(tampered);
    expect(failed.exportedFingerprint).toBe(firstMarkers?.contentFingerprint);

    // 用户把目标恢复成上次写出的内容：重试成功，成品更新。
    await fs.writeFile(target, firstHtml, "utf8");
    const retry = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/retry", {
      method: "POST",
      headers: headers(),
    });
    expect(retry.status).toBe(200);
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");
    const refreshed = await fs.readFile(target, "utf8");
    expect(refreshed).not.toBe(firstHtml);
    expect(refreshed).toContain("补充一段新的正文。");
    const status = await statusOf(handle.url, TOPIC_ID);
    expect(status.exportedFingerprint).toBe(status.sourceFingerprint);
  });

  it("重启后配置保留；相同内容不重写；删除目标可经 retry 或重启自动补齐", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const target = path.join(output, "topic.html");
    const port = await freePort();
    const first = await startService({ root, port });
    await fetch(first.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: target }),
    });
    await waitFor(async () => (await statusOf(first.url, TOPIC_ID)).state === "ready");
    const firstHtml = await fs.readFile(target, "utf8");
    const statBefore = await fs.stat(target);
    await first.stop();

    // 重新启动：配置仍在；内容未变、目标哈希一致 → 不重写。
    const second = await startService({ root, port: await freePort() });
    running.push(second);
    await waitFor(async () => (await statusOf(second.url, TOPIC_ID)).state === "ready");
    const statAfter = await fs.stat(target);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(await fs.readFile(target, "utf8")).toBe(firstHtml);

    // 用户删掉成品：状态立刻不再假装 ready（targetPresent 按磁盘核实）。
    await fs.rm(target, { force: true });
    const missing = await statusOf(second.url, TOPIC_ID);
    expect(missing.targetPresent).toBe(false);
    expect(missing.targetPath).toBe(target);

    // retry 安全重建：绑定保留、没有可覆盖的旧字节，不报冲突。
    const retry = await fetch(second.url + "/api/exports/" + TOPIC_ID + "/retry", {
      method: "POST",
      headers: headers(),
    });
    expect(retry.status).toBe(200);
    await waitFor(async () => (await statusOf(second.url, TOPIC_ID)).state === "ready");
    const rebuilt = await fs.readFile(target, "utf8");
    expect(readExportMarkers(rebuilt)?.topicId).toBe(TOPIC_ID);
    const rebuiltStatus = await statusOf(second.url, TOPIC_ID);
    expect(rebuiltStatus.targetPath).toBe(target);
    expect(rebuiltStatus.exportedFingerprint).toBe(rebuiltStatus.sourceFingerprint);

    // 再次删除后重启：启动补齐（内容未变也重建缺失的成品），绑定保持不变。
    await fs.rm(target, { force: true });
    await second.stop();
    running.splice(running.indexOf(second), 1);
    const third = await startService({ root, port: await freePort() });
    running.push(third);
    await waitFor(async () => (await statusOf(third.url, TOPIC_ID)).state === "ready", 25_000);
    const recreated = await fs.readFile(target, "utf8");
    // 每次渲染的 generatedAt／instanceId／revision 会变，字节不必相同；
    // 内容+读者+格式的组合指纹必须稳定。
    expect(readExportMarkers(recreated)?.exportFingerprint).toBe(
      readExportMarkers(rebuilt)?.exportFingerprint,
    );
    expect(readExportMarkers(recreated)?.topicId).toBe(TOPIC_ID);
    const finalStatus = await statusOf(third.url, TOPIC_ID);
    expect(finalStatus.targetPath).toBe(target);
    expect(finalStatus.targetPresent).toBe(true);
  }, 40_000);

  it("解除绑定保留已有成品；写停用时不导出", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const target = path.join(output, "topic.html");
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: target }),
    });
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");
    expect(await fs.access(target).then(() => true).catch(() => false)).toBe(true);

    const unbound = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: null }),
    });
    expect(unbound.status).toBe(200);
    expect((await statusOf(handle.url, TOPIC_ID)).state).toBe("unset");
    // 成品保留（不删除用户文件）。
    expect(await fs.access(target).then(() => true).catch(() => false)).toBe(true);
  });
});
describe("导出目标的真实路径边界", () => {
  it("Windows junction 指向工作区或应用根时拒绝，且不产生任何成品", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const link = path.join(output, "into-workspace");
    try {
      await fs.symlink(root, link, "junction");
    } catch {
      // 无创建权限的环境跳过（不伪造通过）。
      return;
    }
    const attempted = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: path.join(link, "escaped.html") }),
    });
    expect(attempted.status).toBe(422);
    const code = ((await attempted.json()) as { error: { code: string } }).error.code;
    expect(["EXPORT_TARGET_FORBIDDEN", "EXPORT_TARGET_UNSAFE"]).toContain(code);
    // 不产生成品，且工作区内容未变。
    expect(await fs.access(path.join(root, "escaped.html")).then(() => true).catch(() => false)).toBe(false);
    const status = await statusOf(handle.url, TOPIC_ID);
    expect(status.state).toBe("unset");
    expect(status.targetPath).toBeNull();

    // 应用根（本仓库）同样拒绝。
    const appRoot = path.resolve(process.cwd());
    const intoApp = path.join(output, "into-app");
    let appLink: string | null = null;
    try {
      await fs.symlink(appRoot, intoApp, "junction");
      appLink = intoApp;
    } catch {
      appLink = null;
    }
    if (appLink !== null) {
      const appAttempt = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ path: path.join(appLink, "escaped.html") }),
      });
      expect(appAttempt.status).toBe(422);
      expect(await fs.access(path.join(appRoot, "escaped.html")).then(() => true).catch(() => false)).toBe(false);
    }
  });

  it("父路径含 junction 即使指向普通外部目录也拒绝，且不产生成品", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const plain = await newOutputDir();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const alias = path.join(output, "plain-alias");
    try {
      await fs.symlink(plain, alias, "junction");
    } catch {
      return; // 无创建权限的环境跳过（不伪造通过）
    }
    const attempted = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: path.join(alias, "via-alias.html") }),
    });
    expect(attempted.status).toBe(422);
    const body = (await attempted.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("EXPORT_TARGET_UNSAFE");
    // 真实目录与 alias 目录都没有产物。
    expect(
      await fs.access(path.join(plain, "via-alias.html")).then(() => true).catch(() => false),
    ).toBe(false);
    expect(
      await fs.access(path.join(alias, "via-alias.html")).then(() => true).catch(() => false),
    ).toBe(false);
    const status = await statusOf(handle.url, TOPIC_ID);
    expect(status.state).toBe("unset");
    expect(status.targetPath).toBeNull();

    // 用真实路径绑定则允许。
    const direct = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: path.join(plain, "direct.html") }),
    });
    expect(direct.status).toBe(200);
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");
    expect(
      await fs.access(path.join(plain, "direct.html")).then(() => true).catch(() => false),
    ).toBe(true);
  });

  it("目标本身是符号链接时拒绝绑定", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const real = path.join(output, "real.html");
    const link = path.join(output, "link.html");
    const target = path.join(output, "somewhere.html");
    await fs.writeFile(target, "<html></html>", "utf8");
    try {
      await fs.symlink(target, link, "file");
    } catch {
      return;
    }
    const attempted = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: link }),
    });
    expect(attempted.status).toBe(422);
    expect(await fs.access(real).then(() => true).catch(() => false)).toBe(false);
  });
});
describe("导出记账顺序", () => {
  it("exports.json 被目录占据时不替换旧成品；恢复配置后 retry 可继续", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const target = path.join(output, "topic.html");
    const configPath = path.join(root, ".aichat", "local", "exports.json");
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: target }),
    });
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready");
    const before = await fs.readFile(target);
    const configBackup = await fs.readFile(configPath);

    // 让 exports.json 位置变成目录：写前 pending 记账必然失败。
    await fs.rm(configPath, { force: true });
    await fs.mkdir(configPath);

    const read = (await (await fetch(handle.url + "/api/agent/nodes/" + ROOT_NODE)).json()) as {
      editRef: { ref: string };
    };
    const changed = await fetch(handle.url + "/api/agent/changes", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workspaceId: handle.workspaceId,
        requestId: "1c8fad5b-d9cb-469f-a165-70867728950e",
        action: { action: "patchNode", editRef: read.editRef.ref, append: "记账失败期间的新正文。" },
      }),
    });
    expect(changed.status).toBe(200);

    // 等待导出尝试失败：旧 HTML 字节完全不变。
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "error", 20_000);
    const failed = await statusOf(handle.url, TOPIC_ID);
    expect(failed.error ?? "").toBeTruthy();
    expect(await fs.readFile(target)).toEqual(before);
    expect(failed.exportedFingerprint).not.toBe(failed.sourceFingerprint);

    // 恢复配置文件后再 retry：pending 重新记账成功，成品更新。
    await fs.rm(configPath, { recursive: true, force: true });
    await fs.writeFile(configPath, configBackup);
    const retry = await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/retry", {
      method: "POST",
      headers: headers(),
    });
    expect(retry.status).toBe(200);
    await waitFor(async () => (await statusOf(handle.url, TOPIC_ID)).state === "ready", 20_000);
    const after = await fs.readFile(target, "utf8");
    expect(after).toContain("记账失败期间的新正文。");
    const status = await statusOf(handle.url, TOPIC_ID);
    expect(status.exportedFingerprint).toBe(status.sourceFingerprint);
    // 配置里不再有未完成的 pending 记账。
    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      topics: Record<string, { pending: unknown; targetHash: string }>;
    };
    expect(saved.topics[TOPIC_ID]?.pending).toBeNull();
    expect(saved.topics[TOPIC_ID]?.targetHash).toBe(sha256Bytes(await fs.readFile(target)));
  }, 60_000);

  it("磁盘已是 pending.nextHash 时，重启按实际字节补完成记账", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const target = path.join(output, "topic.html");
    const configPath = path.join(root, ".aichat", "local", "exports.json");
    const port = await freePort();
    const first = await startService({ root, port });
    await fetch(first.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ path: target }),
    });
    await waitFor(async () => (await statusOf(first.url, TOPIC_ID)).state === "ready");
    await first.stop();

    // 模拟"HTML 已替换、完成记账未落盘"：写一条 pending，nextHash 就是实际字节。
    const html = await fs.readFile(target);
    const actualHash = sha256Bytes(html);
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      format: number;
      workspaceId: string;
      topics: Record<string, Record<string, unknown>>;
    };
    const record = config.topics[TOPIC_ID] as Record<string, unknown>;
    record["pending"] = {
      baseHash: "0".repeat(64),
      nextHash: actualHash,
      contentFingerprint: record["exportedContentFingerprint"],
      readerFingerprint: record["exportedReaderFingerprint"],
      exportFingerprint: record["exportedExportFingerprint"],
      revision: record["exportedRevision"],
      recordedAt: new Date().toISOString(),
    };
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const mtimeBefore = (await fs.stat(target)).mtimeMs;

    const second = await startService({ root, port: await freePort() });
    running.push(second);
    await waitFor(async () => (await statusOf(second.url, TOPIC_ID)).state === "ready", 25_000);
    const status = await statusOf(second.url, TOPIC_ID);
    expect(status.targetPresent).toBe(true);
    // 字节已是最新：确认后不需要重写。
    expect((await fs.stat(target)).mtimeMs).toBe(mtimeBefore);
    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      topics: Record<string, { pending: unknown; targetHash: string }>;
    };
    expect(saved.topics[TOPIC_ID]?.pending).toBeNull();
    expect(saved.topics[TOPIC_ID]?.targetHash).toBe(actualHash);
  }, 60_000);
});
describe("导出配置写入守卫", () => {
  it("受控写入停用时不再改 exports.json（同一队列 + 守卫，无恢复旁路）", async () => {
    const root = await newWorkspace();
    const output = await newOutputDir();
    const runtime = await WorkspaceRuntime.create(root);
    const coordinator = new ExportCoordinator({
      runtime,
      appRoot: path.resolve(process.cwd()),
      offlineDirectory: path.resolve(process.cwd(), "dist", "offline"),
    });
    const configPath = path.join(root, ".aichat", "local", "exports.json");
    try {
      await coordinator.init();
      const first = path.join(output, "one.html");
      const status = await coordinator.setTarget(TOPIC_ID, first);
      expect(status.targetPath).toBe(first);
      const saved = await fs.readFile(configPath, "utf8");

      // 模拟丢锁／未恢复事务：受控写入停用。
      runtime.writable = false;
      runtime.writableReason = "WRITER_LOCK_COMPROMISED";

      const second = path.join(output, "two.html");
      await expect(coordinator.setTarget(TOPIC_ID, second)).rejects.toMatchObject({
        code: "WRITE_DISABLED",
      });
      // 配置文件未被改写，绑定仍是第一个目标。
      expect(await fs.readFile(configPath, "utf8")).toBe(saved);
      expect(coordinator.configStore.entries.get(TOPIC_ID)?.targetPath).toBe(first);

      // 取消绑定也受同一守卫。
      await expect(coordinator.setTarget(TOPIC_ID, null)).rejects.toMatchObject({
        code: "WRITE_DISABLED",
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(saved);
      expect(coordinator.configStore.entries.get(TOPIC_ID)?.targetPath).toBe(first);

      // 恢复写入能力后可以正常换绑并落盘。
      runtime.writable = true;
      runtime.writableReason = null;
      await coordinator.setTarget(TOPIC_ID, second);
      const after = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        topics: Record<string, { targetPath: string }>;
      };
      expect(after.topics[TOPIC_ID]?.targetPath).toBe(second);
    } finally {
      await coordinator.stop().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
    }
  }, 30_000);
});
describe("导出队列边界", () => {
  it("调度器 finalize 持有队列时第二个 setTarget 必须排队，放行后顺序完成且两条绑定都在", async () => {
    const root = await newWorkspace();
    // 第二个主题：验证两条独立绑定都保留（单一 root 的合法图）。
    const otherTopic = "t_" + "9".repeat(32);
    const otherNode = "n_" + "8".repeat(32);
    const otherDir = path.join(root, "topics", "第二个主题");
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(
      path.join(otherDir, "topic.md"),
      "---\ntopicId: " + otherTopic + "\ntitle: 第二个主题\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(otherDir, otherNode + ".md"),
      [
        "---",
        "nodeId: " + otherNode,
        "title: 第二棵树",
        "state: agreed",
        "from: " + ROOT_NODE,
        "flow: branch",
        "description: 从根展开的第二个主题",
        "side: left",
        "order: 10",
        "---",
        "",
        "第二个主题的正文。",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = await newOutputDir();
    const runtime = await WorkspaceRuntime.create(root);
    const coordinator = new ExportCoordinator({
      runtime,
      appRoot: path.resolve(process.cwd()),
      offlineDirectory: path.resolve(process.cwd(), "dist", "offline"),
    });
    const configPath = path.join(root, ".aichat", "local", "exports.json");
    try {
      await coordinator.init();
      const firstTarget = path.join(output, "first.html");
      await coordinator.setTarget(TOPIC_ID, firstTarget);
      const waitReady = async (): Promise<void> => {
        const startedAt = Date.now();
        for (;;) {
          const status = coordinator.statusOf(TOPIC_ID);
          if (status.state === "ready") return;
          if (Date.now() - startedAt > 25_000) throw new Error("导出未就绪：" + status.state);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      await waitReady();

      // 让内容真的变化，这样下一次 finalize 一定会写盘（不是 alreadyCurrent 短路）。
      const nodeAbs = path.join(root, "topics", DIR, ROOT_NODE + ".md");
      const nodeText = await fs.readFile(nodeAbs, "utf8");
      await fs.writeFile(nodeAbs, nodeText.replace("第一段正文。", "第一段正文，已更新。"), "utf8");
      const reloaded = await runtime.reloadFromDisk();
      expect(reloaded.ok).toBe(true);

      const configBefore = await fs.readFile(configPath, "utf8");

      // 停住"已在队列内"的 finalize 的 persist：旧实现正是此刻把实例级标志置 true。
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const internals = coordinator as unknown as { persist: () => Promise<void> };
      const originalPersist = internals.persist.bind(coordinator);
      let held = false;
      internals.persist = async () => {
        if (!held) {
          held = true;
          entered();
          await blocked;
        }
        await originalPersist();
      };

      const holding = coordinator.schedule(TOPIC_ID, "queue-boundary-test");
      await enteredPromise;

      // 队列仍被 finalize 占用：第二个公开写入口必须排队，不能内联执行。
      const secondTarget = path.join(output, "second.html");
      const second = coordinator.setTarget(otherTopic, secondTarget);
      let secondDone = false;
      void second.then(
        () => {
          secondDone = true;
        },
        () => {
          secondDone = true;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(secondDone).toBe(false);
      // 盘上配置仍是 finalize 卡住之前的字节（第二个请求没有抢跑写盘）。
      expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);

      release();
      await holding;
      await second;

      // 顺序完成后两条绑定都在：第一个仍是 first.html，第二个是新目标。
      const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        topics: Record<string, { targetPath: string }>;
      };
      expect(saved.topics[TOPIC_ID]?.targetPath).toBe(firstTarget);
      expect(saved.topics[otherTopic]?.targetPath).toBe(secondTarget);
      expect(Object.keys(saved.topics).sort()).toEqual([TOPIC_ID, otherTopic].sort());
    } finally {
      await coordinator.stop().catch(() => undefined);
      await runtime.stop().catch(() => undefined);
    }
  }, 40_000);
});
