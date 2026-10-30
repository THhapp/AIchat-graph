import { afterEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importV2 } from "../../src/next/import.js";
import { GraphStore } from "../../src/next/store.js";

/**
 * One-time import of a format-2 isolated Markdown workspace.
 *
 * Everything runs against real temporary directories: no workspace is copied,
 * no service is started. The import is expected to keep stable IDs, bodies,
 * explicit summaries, structure, recent updates and the old workspace identity,
 * while leaving the original files untouched.
 */

const TOPIC_ID = "t_" + "a".repeat(32);
const ROOT_ID = "n_" + "1".repeat(32);
const NEXT_ID = "n_" + "2".repeat(32);
const BRANCH_ID = "n_" + "3".repeat(32);
const STALE_ID = "n_" + "9".repeat(32);
const WORKSPACE_ID = "w_" + "f".repeat(32);
const DIR = "旧主题目录";
const AT = "2026-10-01T00:00:00.000Z";

const temporaryParents: string[] = [];

function frontmatter(fields: string[], body: string): string {
  return ["---", ...fields, "---", "", body, ""].join("\n");
}

async function makeV2Workspace(files: Record<string, string>): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-import-"));
  temporaryParents.push(parent);
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text, "utf8");
  }
  return fs.realpath(root);
}

function standardFiles(): Record<string, string> {
  const workspaceJson = JSON.stringify(
    { schemaVersion: 2, topicMode: "isolated", workspaceId: WORKSPACE_ID, name: "旧资料库", activeNode: NEXT_ID },
    null,
    2,
  );
  return {
    "workspace.json": workspaceJson + "\n",
    ["topics/" + DIR + "/topic.md"]: frontmatter(["topicId: " + TOPIC_ID, "title: 旧主题标题"], ""),
    ["topics/" + DIR + "/root.md"]: frontmatter(
      ["nodeId: " + ROOT_ID, "title: 根问题", "state: agreed", "from: null", "flow: root", "important: true", "summary: 根节点显式摘要"],
      "根节点正文。\n\n第二段。",
    ),
    ["topics/" + DIR + "/next.md"]: frontmatter(
      ["nodeId: " + NEXT_ID, "title: 下一步问题", "state: proposed", "from: " + ROOT_ID, "flow: next", "description: 由根问题推进"],
      "下一步正文。",
    ),
    ["topics/" + DIR + "/branch.md"]: frontmatter(
      [
        "nodeId: " + BRANCH_ID,
        "title: 旁支问题",
        "state: reference",
        "from: " + ROOT_ID,
        "flow: branch",
        "side: right",
        "order: 20",
        "description: 另一个方向",
      ],
      "旁支正文。",
    ),
    ".aichat/runtime/last-change.json": JSON.stringify(
      { schemaVersion: 2, topics: { [TOPIC_ID]: { at: AT, nodeIds: [NEXT_ID, STALE_ID] } } },
      null,
      2,
    ) + "\n",
  };
}

afterEach(async () => {
  for (const parent of temporaryParents.splice(0)) {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

describe("importV2", () => {
  it("imports stable IDs, bodies, structure, explicit summary and recent updates", async () => {
    const root = await makeV2Workspace(standardFiles());
    const workspaceJsonBefore = readFileSync(path.join(root, "workspace.json"), "utf8");
    const nextFileBefore = readFileSync(path.join(root, "topics", DIR, "next.md"), "utf8");

    const summary = await importV2(root);

    expect(summary).toMatchObject({
      ok: true,
      root,
      dbPath: path.join(root, "graph.sqlite"),
      workspaceId: WORKSPACE_ID,
      name: "旧资料库",
      topicCount: 1,
      nodeCount: 3,
      lastChangeTopicCount: 1,
    });
    expect(existsSync(summary.dbPath)).toBe(true);
    // The old source files stay untouched (no backup tree, no rewrite).
    expect(readFileSync(path.join(root, "workspace.json"), "utf8")).toBe(workspaceJsonBefore);
    expect(readFileSync(path.join(root, "topics", DIR, "next.md"), "utf8")).toBe(nextFileBefore);

    const store = GraphStore.open(root);
    try {
      const snapshot = store.snapshot();
      expect(snapshot.workspaceId).toBe(WORKSPACE_ID);
      expect(snapshot.name).toBe("旧资料库");
      expect(snapshot.activeNode).toBe(NEXT_ID);
      expect(snapshot.topics).toHaveLength(1);
      const topic = snapshot.topics[0];
      expect(topic).toMatchObject({
        id: TOPIC_ID,
        key: DIR,
        title: "旧主题标题",
        revision: 1,
        lastChangeAt: AT,
        lastChangeIds: [NEXT_ID],
      });

      const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
      expect([...nodes.keys()].sort()).toEqual([NEXT_ID, ROOT_ID, BRANCH_ID].sort());
      // 旧 Markdown 的 state: 字段仍由旧解析器接受，但 NodeRecord 不保留它。
      for (const node of snapshot.nodes) {
        expect(Object.prototype.hasOwnProperty.call(node, "state")).toBe(false);
      }
      const rootNode = nodes.get(ROOT_ID);
      expect(rootNode).toMatchObject({
        topicId: TOPIC_ID,
        title: "根问题",
        flow: "root",
        from: null,
        important: true,
        summary: "根节点显式摘要",
        revision: 1,
      });
      expect(rootNode?.body).toBe("根节点正文。\n\n第二段。");
      expect(rootNode?.nextId).toBe(NEXT_ID);
      expect(rootNode?.branchIds).toEqual([BRANCH_ID]);

      const nextNode = nodes.get(NEXT_ID);
      expect(nextNode).toMatchObject({
        from: ROOT_ID,
        flow: "next",
        description: "由根问题推进",
        summary: null,
        revision: 1,
      });
      expect(nextNode?.body).toBe("下一步正文。");

      const branchNode = nodes.get(BRANCH_ID);
      expect(branchNode).toMatchObject({
        from: ROOT_ID,
        flow: "branch",
        side: "right",
        order: 20,
        description: "另一个方向",
      });
      expect(branchNode?.body).toBe("旁支正文。");
    } finally {
      store.close();
    }
  });

  it("rejects a second import into a workspace that already has graph.sqlite", async () => {
    const root = await makeV2Workspace(standardFiles());
    await importV2(root);
    await expect(importV2(root)).rejects.toMatchObject({ code: "IMPORT_WORKSPACE_EXISTS" });
    const store = GraphStore.open(root);
    try {
      expect(store.snapshot().nodes).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("rejects V1 and shared sources and leaves no database", async () => {
    const v1Root = await makeV2Workspace({
      "workspace.json": JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE_ID, name: "旧版", activeNode: null }, null, 2),
    });
    await expect(importV2(v1Root)).rejects.toMatchObject({ code: "IMPORT_UNSUPPORTED_WORKSPACE" });
    expect(existsSync(path.join(v1Root, "graph.sqlite"))).toBe(false);

    const sharedRoot = await makeV2Workspace({
      "workspace.json": JSON.stringify(
        { schemaVersion: 2, topicMode: "shared", workspaceId: WORKSPACE_ID, name: "共享版", activeNode: null },
        null,
        2,
      ),
    });
    await expect(importV2(sharedRoot)).rejects.toMatchObject({ code: "IMPORT_UNSUPPORTED_WORKSPACE" });
    expect(existsSync(path.join(sharedRoot, "graph.sqlite"))).toBe(false);
  });

  it("reports malformed old files as source diagnostics and leaves no database", async () => {
    const files = standardFiles();
    delete files["topics/" + DIR + "/topic.md"];
    const root = await makeV2Workspace(files);
    await expect(importV2(root)).rejects.toMatchObject({ code: "IMPORT_SOURCE_INVALID" });
    expect(existsSync(path.join(root, "graph.sqlite"))).toBe(false);
  });

  it("keeps the old name unless an explicit name is given", async () => {
    const preservedRoot = await makeV2Workspace(standardFiles());
    const preserved = await importV2(preservedRoot);
    expect(preserved.name).toBe("旧资料库");

    const renamedRoot = await makeV2Workspace(standardFiles());
    const renamed = await importV2(renamedRoot, "  导入后名称  ");
    expect(renamed.name).toBe("导入后名称");
    const store = GraphStore.open(renamedRoot);
    try {
      expect(store.snapshot().name).toBe("导入后名称");
    } finally {
      store.close();
    }

    const blankRoot = await makeV2Workspace(standardFiles());
    await expect(importV2(blankRoot, "   ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(existsSync(path.join(blankRoot, "graph.sqlite"))).toBe(false);
  });
});
