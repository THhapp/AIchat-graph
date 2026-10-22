import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import { CACHE_DIR } from "../../src/service/cache.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const ROOT_NODE = "n_" + "d".repeat(32);
const NEXT_NODE = "n_" + "e".repeat(32);
const TOPIC_ID = "t_" + "f".repeat(32);
const DIR = "资源";

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

/** 1x1 PNG（固定字节，便于比较哈希）。 */
const PNG_ONE = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf00000003000100" +
    "f6f0d3b70000000049454e44ae426082",
  "hex",
);
const PNG_TWO = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf00000003000100" +
    "f6f0d3b70000000049454e44ae426083",
  "hex",
);

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-rsrc-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "resource-test" });
  const topicDir = path.join(root, "topics", DIR);
  await fs.mkdir(topicDir, { recursive: true });
  await fs.mkdir(path.join(root, "resources"), { recursive: true });
  await fs.writeFile(path.join(root, "resources", "pic.png"), PNG_ONE);
  await fs.writeFile(
    path.join(topicDir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 资源样例\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, ROOT_NODE + ".md"),
    nodeFile(ROOT_NODE, "带图的卡片", "root", null, "见图：\n\n![一张图](../../resources/pic.png)"),
    "utf8",
  );
  await fs.writeFile(
    path.join(topicDir, NEXT_NODE + ".md"),
    nodeFile(NEXT_NODE, "后续", "next", ROOT_NODE, "后续正文。"),
    "utf8",
  );
  return fs.realpath(root);
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

describe("资源变化进入有效快照", () => {
  it("只改现有 PNG、不动 Markdown：仍发布新 revision 并更新成品指纹", async () => {
    const root = await newWorkspace();
    const output = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-rsrc-out-"));
    temporaryRoots.push(output);
    const port = await freePort();
    const handle = await startService({ root, port });
    running.push(handle);

    const target = path.join(await fs.realpath(output), "topic.html");
    const headers = { "content-type": "application/json", "x-aichat-client": "cli" };
    await fetch(handle.url + "/api/exports/" + TOPIC_ID + "/target", {
      method: "PUT",
      headers,
      body: JSON.stringify({ path: target }),
    });
    const waitReady = async (): Promise<{ exportedFingerprint: string | null; state: string }> => {
      const startedAt = Date.now();
      for (;;) {
        const body = (await (await fetch(handle.url + "/api/exports")).json()) as {
          topics: Array<{ topicId: string; state: string; exportedFingerprint: string | null }>;
        };
        const status = body.topics.find((entry) => entry.topicId === TOPIC_ID);
        if (status !== undefined && status.state === "ready") return status;
        if (Date.now() - startedAt > 20_000) throw new Error("导出未就绪: " + JSON.stringify(status));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const first = await waitReady();
    const graphBefore = (await (await fetch(handle.url + "/api/graph")).json()) as {
      revision: number;
    };
    const htmlBefore = await fs.readFile(target, "utf8");
    expect(htmlBefore).toContain("data:image/png;base64,");

    // 只替换 PNG 字节，不改任何 Markdown。
    await fs.writeFile(path.join(root, "resources", "pic.png"), PNG_TWO);

    const startedAt = Date.now();
    let revision = graphBefore.revision;
    while (Date.now() - startedAt < 20_000) {
      const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
        revision: number;
      };
      revision = graph.revision;
      if (revision > graphBefore.revision) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(revision).toBeGreaterThan(graphBefore.revision);

    const second = await waitReady();
    expect(second.exportedFingerprint).not.toBe(first.exportedFingerprint);
    const htmlAfter = await fs.readFile(target, "utf8");
    expect(htmlAfter).not.toBe(htmlBefore);
    expect(htmlAfter).toContain("data:image/png;base64,");
  });
});

describe("snapshot 与 disk 详情资源一致", () => {
  it("引用式图片在两条路径都被捕获（不再靠正则门控）", async () => {
    const root = await newWorkspace();
    // 用引用式图片替换直接图片：正则门控会漏掉它。
    const nodeAbs = path.join(root, "topics", DIR, ROOT_NODE + ".md");
    await fs.writeFile(
      nodeAbs,
      nodeFile(ROOT_NODE, "带图的卡片", "root", null, "见图：\n\n![一张图][pic]\n\n[pic]: ../../resources/pic.png"),
      "utf8",
    );
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    // 带版本 pin → snapshot 详情；不带版本 → 真实磁盘详情。两者资源集合必须一致。
    const graph = (await (await fetch(handle.url + "/api/graph")).json()) as {
      instanceId: string;
      revision: number;
    };
    const version = "?instanceId=" + graph.instanceId + "&revision=" + String(graph.revision);
    const snapshotDetail = (await (
      await fetch(handle.url + "/api/topics/" + TOPIC_ID + version)
    ).json()) as { resources: Record<string, string>; source: string };
    expect(snapshotDetail.source).toBe("snapshot");
    expect(Object.keys(snapshotDetail.resources).length).toBeGreaterThan(0);

    const diskDetail = (await (
      await fetch(handle.url + "/api/topics/" + TOPIC_ID)
    ).json()) as { resources: Record<string, string>; source: string; valid: boolean };
    expect(diskDetail.source).toBe("disk");
    expect(diskDetail.valid).toBe(true);
    expect(Object.keys(diskDetail.resources).sort()).toEqual(
      Object.keys(snapshotDetail.resources).sort(),
    );
  });
});

describe("缓存不保存正文", () => {
  it("snapshot.json 只有路径与哈希，不含节点正文或 data URI", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const cacheFile = path.join(root, ...CACHE_DIR.split("/"), "snapshot.json");
    const text = await fs.readFile(cacheFile, "utf8");
    // 源正文与内联数据都不能出现在缓存里。
    expect(text).not.toContain("带图的卡片");
    expect(text).not.toContain("后续正文。");
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("nodeId");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["workspaceId"]).toBe(handle.workspaceId);
    expect(typeof parsed["fileHashes"]).toBe("object");
    expect(Object.keys(parsed["fileHashes"] as object).length).toBeGreaterThan(0);
    // 每条记录都是哈希，不是正文。
    for (const hash of Object.values(parsed["fileHashes"] as Record<string, string>)) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});