import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkspaceDocuments, type WorkspaceDocument, type WorkspaceMeta } from "../../src/core/index.js";
import { buildIndex, searchIndex } from "../../src/index/index.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const v2Root = join(fixturesRoot, "workspace-v2");

function listMarkdown(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(absolute);
      } else if (entry.toLowerCase().endsWith(".md")) {
        found.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

const documents: WorkspaceDocument[] = listMarkdown(v2Root).map((path) => ({
  path,
  text: readFileSync(join(v2Root, ...path.split("/")), "utf8"),
}));
const workspace = JSON.parse(readFileSync(join(v2Root, "workspace.json"), "utf8")) as WorkspaceMeta;

function build() {
  const parsed = parseWorkspaceDocuments({ workspace, documents });
  if (!parsed.ok || !parsed.graph) throw new Error("V2 fixture 未通过");
  return buildIndex({
    workspaceId: workspace.workspaceId,
    graph: parsed.graph,
    topics: parsed.topics.map((topic) => {
      const entry = documents.find((document) => document.path === topic.document.path)!;
      const fileHashes: Record<string, string> = {};
      for (const path of topic.sourcePaths) fileHashes[path] = "h:" + path;
      return {
        topicId: topic.topicId,
        title: topic.title,
        path: topic.document.path,
        fileHash: "h:" + entry.path,
        raw: entry.text,
        nodes: topic.nodes,
        schemaVersion: 2 as const,
        sourcePaths: topic.sourcePaths,
        fileHashes,
      };
    }),
    generatedAt: "2026-02-02T00:00:00.000Z",
  });
}

describe("格式 2 索引", () => {
  it("manifest 收录每个节点真实路径与哈希，搜索指向节点文件", () => {
    const { manifest, search } = build();
    const skill = manifest.nodes.find((node) => node.title === "模板方案与准备材料")!;
    expect(skill.sourcePath).toBe("topics/协作方式/n_1815f87dbd6a40ce9a0745db4cf5345d.md");
    expect(skill.topicPath).toBe("topics/协作方式/topic.md");
    expect(skill.description).toContain("把模板路线单独列为待讨论方案");
    expect(skill.number).toBe("06-03-01");

    for (const node of manifest.nodes) {
      expect(manifest.fileHashes[node.sourcePath]).toBe("h:" + node.sourcePath);
    }
    for (const topic of manifest.topics) {
      expect(topic.fileHashes[topic.path]).toBeDefined();
      expect(topic.sourcePaths).toContain(topic.path);
      expect(topic.sourcePaths.length).toBe(topic.nodeIds.length + 1);
    }
    expect(Object.keys(manifest.fileHashes).sort()).toEqual(
      documents.map((document) => document.path).sort(),
    );
    // 摘要会进 manifest，但正文第二段不会：它不是卡片摘要。
    expect(JSON.stringify(manifest)).not.toContain("此 Canvas 保留既有讨论");

    const hit = searchIndex(search, "实现载体尚可重新选择").hits[0]!;
    expect(hit.nodeId).toBe(skill.id);
    expect(hit.path).toBe(skill.sourcePath);
    const document = search.documents.find((entry) => entry.id === skill.id)!;
    expect(document.path).toBe(skill.sourcePath);
    expect(search.documents.every((entry) => entry.path !== "topics/协作方式/topic.md")).toBe(true);
  });

  it("格式 1 索引保持单文件来源，sourcePath 等于 topicPath", () => {
    const v1Root = join(fixturesRoot, "workspace");
    const v1Documents: WorkspaceDocument[] = listMarkdown(v1Root).map((path) => ({
      path,
      text: readFileSync(join(v1Root, ...path.split("/")), "utf8"),
    }));
    const v1Workspace = JSON.parse(readFileSync(join(v1Root, "workspace.json"), "utf8")) as WorkspaceMeta;
    const parsed = parseWorkspaceDocuments({ workspace: v1Workspace, documents: v1Documents });
    expect(parsed.ok).toBe(true);
    const built = buildIndex({
      workspaceId: v1Workspace.workspaceId,
      graph: parsed.graph!,
      topics: parsed.topics.map((topic) => ({
        topicId: topic.topicId,
        title: topic.title,
        path: topic.document.path,
        fileHash: "h:" + topic.document.path,
        raw: topic.document.text,
        nodes: topic.nodes,
      })),
      generatedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(built.manifest.nodes.every((node) => node.sourcePath === node.topicPath)).toBe(true);
    expect(built.manifest.nodes.every((node) => node.description === undefined)).toBe(true);
    expect(built.manifest.topics.every((topic) => topic.sourcePaths.length === 1)).toBe(true);
  });
});