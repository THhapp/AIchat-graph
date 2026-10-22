import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../../src/storage/index.js";
import { main } from "../../src/cli/index.js";

const temporaryRoots: string[] = [];

async function newParent(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-migrate-"));
  temporaryRoots.push(parent);
  return parent;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const TOPIC_ID = "t_64e917c597fb4da4abd5467512fab596";
const ROOT_NODE = "n_ac6022c7b25c40c7bd5f849bf6cd36ef";
const CHILD_NODE = "n_0d2f6687895d435f8bd389558b0820f3";

function v1Topic(options: { withLabel: boolean }): string {
  const lines = [
    "---",
    "schemaVersion: 1",
    `topicId: ${TOPIC_ID}`,
    "title: 条目整理",
    "nodes:",
    `  ${ROOT_NODE}:`,
    "    from: null",
    "    flow: root",
    "    state: agreed",
    `  ${CHILD_NODE}:`,
    `    from: ${ROOT_NODE}`,
    "    flow: next",
    "    state: proposed",
  ];
  if (options.withLabel) lines.push("    label: 承接记录分寸的讨论");
  lines.push(
    "---",
    "",
    `## 条目整理 <!-- node:${ROOT_NODE} -->`,
    "",
    "保留有用的思路来路与关键转折。",
    "",
    `## 可以回查的现场 <!-- node:${CHILD_NODE} -->`,
    "",
    "记录既包括讨论过什么，也包括想法怎样走到这里。",
    "",
  );
  return lines.join("\n");
}

async function newV1Workspace(withLabel: boolean): Promise<{ parent: string; root: string }> {
  const parent = await newParent();
  const root = path.join(parent, "source-v1");
  await initWorkspace({ root, name: "migrate-source", schemaVersion: 1 });
  const topicFile = path.join(root, "topics", "条目整理.md");
  await fs.mkdir(path.dirname(topicFile), { recursive: true });
  await fs.writeFile(topicFile, v1Topic({ withLabel }), "utf8");
  return { parent, root };
}

describe("migrate", () => {
  it("preview 不写目标、不输出正文，只给路径／字节／哈希", async () => {
    const { parent, root } = await newV1Workspace(true);
    const destination = path.join(parent, "target-v2");
    const result = await main([
      "migrate",
      "--source",
      root,
      "--destination",
      destination,
      "--preview",
    ]);
    expect(result.exitCode).toBe(0);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body["preview"]).toBe(true);
    expect(body["published"]).toBe(false);
    expect(body["missingDescriptions"]).toEqual([]);
    const files = body["files"] as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(typeof file["path"]).toBe("string");
      expect(typeof file["bytes"]).toBe("number");
      expect(typeof file["sha256"]).toBe("string");
      // 预览绝不携带正文全文。
      expect(file["content"]).toBeUndefined();
      expect(file["text"]).toBeUndefined();
    }
    expect(result.stdout).not.toContain("记录既包括讨论过什么");
    expect(result.stdout).not.toContain("保留有用的思路来路");
    void TOPIC_ID;
  });

  it("缺 description 时明确列出 nodeId 并拒绝发布", async () => {
    const { parent, root } = await newV1Workspace(false);
    const destination = path.join(parent, "target-v2");
    const result = await main(["migrate", "--source", root, "--destination", destination]);
    expect(result.exitCode).toBe(6);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["published"]).toBe(false);
    expect(body["missingDescriptions"]).toEqual([CHILD_NODE]);
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    // 源未被改写。
    expect(await fs.readFile(path.join(root, "topics", "条目整理.md"), "utf8")).toContain(
      "## 条目整理 <!-- node:",
    );
  });

  it("补上 descriptions 后发布 V2，保留 ID／正文／状态／连接", async () => {
    const { parent, root } = await newV1Workspace(false);
    const destination = path.join(parent, "target-v2");
    const descriptionsFile = path.join(parent, "descriptions.json");
    await fs.writeFile(
      descriptionsFile,
      JSON.stringify({ [CHILD_NODE]: "承接记录分寸的讨论" }),
      "utf8",
    );
    const result = await main([
      "migrate",
      "--source",
      root,
      "--destination",
      destination,
      "--descriptions",
      descriptionsFile,
    ]);
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body["published"]).toBe(true);
    expect((body["counts"] as Record<string, number>)["nodes"]).toBe(2);

    const meta = JSON.parse(await fs.readFile(path.join(destination, "workspace.json"), "utf8"));
    expect(meta.schemaVersion).toBe(2);
    const childFile = path.join(
      destination,
      "topics",
      "条目整理",
      `${CHILD_NODE}.md`,
    );
    const childText = await fs.readFile(childFile, "utf8");
    expect(childText).toContain(`nodeId: ${CHILD_NODE}`);
    expect(childText).toContain("state: proposed");
    expect(childText).toContain(`from: ${ROOT_NODE}`);
    expect(childText).toContain("description: 承接记录分寸的讨论");
    expect(childText).toContain("记录既包括讨论过什么，也包括想法怎样走到这里。");
    // V1 的 H2 卡片标记不应混入 V2 正文。
    expect(childText).not.toContain("<!-- node:");

    // 目标能被 CLI 直接校验，说明是真实可用的工作区。
    const validated = await main(["validate", "--workspace", destination]);
    expect(validated.exitCode).toBe(0);
    const validatedBody = JSON.parse(validated.stdout) as Record<string, unknown>;
    expect(validatedBody["schemaVersion"]).toBe(2);
  });

  it("目标已存在时拒绝，不覆盖他人目录", async () => {
    const { parent, root } = await newV1Workspace(true);
    const destination = path.join(parent, "target-v2");
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, "keep.txt"), "他人的文件", "utf8");
    const result = await main([
      "migrate",
      "--source",
      root,
      "--destination",
      destination,
      "--preview",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error.code).toBe("WORKSPACE_EXISTS");
    expect(await fs.readFile(path.join(destination, "keep.txt"), "utf8")).toBe("他人的文件");
  });

  it("不接受源与目标相同（不原位迁移）", async () => {
    const { root } = await newV1Workspace(true);
    const result = await main(["migrate", "--source", root, "--destination", root]);
    expect(result.exitCode).not.toBe(0);
  });
});
