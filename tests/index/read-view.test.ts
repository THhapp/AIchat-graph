import { describe, expect, it } from "vitest";
import {
  buildReadView,
  decodeReadCursor,
  ReadViewError,
  DEFAULT_READ_BUDGET,
} from "../../src/index/read-view.js";
import type {
  ReadViewBuildInput,
  ReadViewNode,
} from "../../src/index/read-view.js";
import type {
  AgentEditRef,
  NodeFlow,
  ReadContentItem,
  ReadOverviewItem,
  ReadStructureItem,
  ReadViewResponse,
} from "../../src/shared/protocol.js";

const T1 = "t_1";
const T2 = "t_2";
const W = "w_test";

function makeNode(
  id: string,
  title: string,
  from: string | null,
  flow: NodeFlow,
  extra: Partial<ReadViewNode> = {},
): ReadViewNode {
  return {
    id,
    topicId: T1,
    title,
    summary: "摘要 " + id,
    number: id,
    state: "agreed",
    flow,
    from,
    important: false,
    ...extra,
  };
}

/**
 * 图顺序：r → (br1 → (br1n, br1b), br2) → a → (ba) → b
 * 编号顺序与真实 graph.ts 一致，输入顺序即稳定顺序。
 */
const FIXTURE: ReadViewNode[] = [
  makeNode("r", "根", null, "root", { number: "01" }),
  makeNode("br1", "根的分支一", "r", "branch", {
    number: "01-01",
    order: 10,
    side: "right",
    description: "从根展开背景",
  }),
  makeNode("br1n", "分支内部主线", "br1", "next", {
    number: "01-01-01",
    description: "分支内部继续",
  }),
  makeNode("br1b", "分支内部侧枝", "br1", "branch", {
    number: "01-01-02",
    order: 10,
    side: "left",
    description: "分支内部侧枝",
  }),
  makeNode("br2", "根的分支二", "r", "branch", {
    number: "01-02",
    order: 20,
    description: "根的第二个分支",
  }),
  makeNode("a", "主线 A", "r", "next", {
    number: "02",
    description: "沿主线继续",
  }),
  makeNode("ba", "A 的分支", "a", "branch", {
    number: "02-01",
    order: 5,
    description: "A 的侧枝",
  }),
  makeNode("b", "主线 B", "a", "next", {
    number: "03",
    description: "再沿主线继续",
  }),
];

const OVERVIEW_ORDER = [
  "mainline:r",
  "branch:br1",
  "branch:br2",
  "mainline:a",
  "branch:ba",
  "mainline:b",
];

function makeInput(
  overrides: Partial<ReadViewBuildInput> & Pick<ReadViewBuildInput, "view" | "scope">,
): ReadViewBuildInput {
  return {
    workspaceId: W,
    mode: "online",
    topicId: T1,
    topicTitle: "主题一",
    rootIds: ["r"],
    nodes: FIXTURE,
    budget: DEFAULT_READ_BUDGET,
    envelope: {
      source: "online",
      root: "D:/workspace",
      online: { available: true, instanceId: "inst-1", revision: 7, workspaceId: W },
    },
    ...overrides,
  };
}

function collectPages(
  make: (cursor: string | undefined) => ReadViewResponse,
  budget: number,
): ReadViewResponse[] {
  const responses: ReadViewResponse[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page += 1) {
    const response = make(cursor);
    expect(response.budget.used).toBe(JSON.stringify(response).length);
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(budget);
    expect(response.budget.limit).toBe(budget);
    responses.push(response);
    if (!response.page.hasMore) return responses;
    expect(typeof response.page.next).toBe("string");
    cursor = response.page.next as string;
  }
  throw new Error("分页没有终止");
}

function overviewPage(
  cursor: string | undefined,
  budget: number,
  scope: ReadViewBuildInput["scope"] = { kind: "topic" },
): ReadViewResponse {
  return buildReadView(
    makeInput({
      view: "overview",
      scope,
      budget,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
  );
}

function structurePage(
  cursor: string | undefined,
  budget: number,
  scope: ReadViewBuildInput["scope"] = { kind: "topic" },
  nodes: readonly ReadViewNode[] = FIXTURE,
): ReadViewResponse {
  return buildReadView(
    makeInput({
      view: "structure",
      scope,
      nodes,
      budget,
      ...(cursor !== undefined ? { cursor } : {}),
    }),
  );
}

function contentPage(
  cursor: string | undefined,
  budget: number,
  nodes: readonly ReadViewNode[],
  content?: ReadViewBuildInput["content"],
  extra: Partial<ReadViewBuildInput> = {},
): ReadViewResponse {
  return buildReadView(
    makeInput({
      view: "content",
      scope: { kind: "nodes", nodeIds: nodes.map((node) => node.id) },
      nodes,
      budget,
      ...(content !== undefined ? { content } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...extra,
    }),
  );
}

function expectError(fn: () => unknown, code: ReadViewError["code"]): ReadViewError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReadViewError);
    const readError = error as ReadViewError;
    expect(readError.code).toBe(code);
    return readError;
  }
  throw new Error("预期抛出 " + code + "，但没有报错");
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("overview", () => {
  it("输出主线与直接分支入口，不展开分支内部", () => {
    const response = overviewPage(undefined, DEFAULT_READ_BUDGET);
    const items = response.items as ReadOverviewItem[];
    expect(items.map((item) => item.role + ":" + item.id)).toEqual(OVERVIEW_ORDER);

    const br1 = items.find((item) => item.id === "br1") as ReadOverviewItem;
    expect(br1.role).toBe("branch");
    expect(br1.from).toBe("r");
    expect(br1.subtreeNodeCount).toBe(3);
    expect(br1.read).toEqual({ view: "structure", from: "br1" });
    expect(br1.description).toBe("从根展开背景");

    const br2 = items.find((item) => item.id === "br2") as ReadOverviewItem;
    expect(br2.subtreeNodeCount).toBe(1);

    // 分支内部节点只出现在结构范围内，不在 overview 顶层。
    expect(items.some((item) => item.id === "br1n" || item.id === "br1b")).toBe(false);
    expect(response.scope).toMatchObject({ kind: "topic", nodeCount: FIXTURE.length });
    expect(response.scope.note).toContain("分支内部未展开");
    expect(response.budget).toMatchObject({ unit: "utf16", limit: DEFAULT_READ_BUDGET, mode: "auto" });
  });

  it("分页覆盖全部导航记录且不重复", () => {
    const budget = 1200;
    const pages = collectPages((cursor) => overviewPage(cursor, budget), budget);
    const items = pages.flatMap((page) => page.items as ReadOverviewItem[]);
    expect(items.map((item) => item.role + ":" + item.id)).toEqual(OVERVIEW_ORDER);
    const keys = items.map((item) => item.role + ":" + item.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[pages.length - 1]?.page.hasMore).toBe(false);
  });

  it("subtree 从主线中段开始时包含其后的主线延续", () => {
    const response = overviewPage(undefined, DEFAULT_READ_BUDGET, { kind: "subtree", from: "a" });
    const items = response.items as ReadOverviewItem[];
    expect(items.map((item) => item.role + ":" + item.id)).toEqual([
      "mainline:a",
      "branch:ba",
      "mainline:b",
    ]);
    expect(response.scope).toMatchObject({ kind: "subtree", from: "a", nodeCount: 3 });
    expect(response.scope.note).toContain("不含起点之前的节点");
  });
});

describe("structure", () => {
  it("topic 范围返回结构字段且不含正文、路径或凭据", () => {
    const response = structurePage(undefined, DEFAULT_READ_BUDGET);
    const items = response.items as ReadStructureItem[];
    expect(items.map((item) => item.id)).toEqual(FIXTURE.map((node) => node.id));
    expect(items[1]).toMatchObject({
      id: "br1",
      title: "根的分支一",
      from: "r",
      flow: "branch",
      side: "right",
      order: 10,
      description: "从根展开背景",
    });
    expect(items[0]).not.toHaveProperty("description");
    for (const item of items as unknown as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty("body");
      expect(item).not.toHaveProperty("path");
      expect(item).not.toHaveProperty("fileHash");
      expect(item).not.toHaveProperty("editRef");
      expect(item).not.toHaveProperty("sourcePath");
    }
    expect(response.boundaries).toBeUndefined();
    expect(response.scope).toMatchObject({ kind: "topic", nodeCount: FIXTURE.length });
  });

  it("subtree 返回穿越边界的真实连接", () => {
    const response = structurePage(undefined, DEFAULT_READ_BUDGET, { kind: "subtree", from: "a" });
    const items = response.items as ReadStructureItem[];
    expect(items.map((item) => item.id)).toEqual(["a", "ba", "b"]);
    expect(response.boundaries).toEqual([
      {
        from: "r",
        to: "a",
        flow: "next",
        description: "沿主线继续",
        external: { id: "r", title: "根", topicId: T1 },
      },
    ]);
    expect(response.scope).toMatchObject({ kind: "subtree", from: "a", nodeCount: 3 });
  });

  it("subtree 从分支入口开始时的边界为 branch 连接", () => {
    const response = structurePage(undefined, DEFAULT_READ_BUDGET, {
      kind: "subtree",
      from: "br1",
    });
    expect((response.items as ReadStructureItem[]).map((item) => item.id)).toEqual([
      "br1",
      "br1n",
      "br1b",
    ]);
    expect(response.boundaries?.[0]).toMatchObject({
      from: "r",
      to: "br1",
      flow: "branch",
      external: { id: "r", title: "根", topicId: T1 },
    });
  });

  it("分页覆盖结构记录且每页不超预算", () => {
    const budget = 1200;
    const pages = collectPages((cursor) => structurePage(cursor, budget), budget);
    const ids = pages.flatMap((page) => (page.items as ReadStructureItem[]).map((item) => item.id));
    expect(ids).toEqual(FIXTURE.map((node) => node.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("约 500 条导航记录在小预算下连续分页且不超预算", () => {
    const many: ReadViewNode[] = Array.from({ length: 500 }, (_, index) =>
      makeNode(
        "m" + String(index),
        "节点 " + String(index),
        index === 0 ? null : "m" + String(index - 1),
        index === 0 ? "root" : "next",
        { number: String(index + 1).padStart(4, "0") },
      ),
    );
    const budget = 2500;
    const pages = collectPages(
      (cursor) =>
        structurePage(cursor, budget, { kind: "topic" }, many),
      budget,
    );
    const ids = pages.flatMap((page) =>
      (page.items as ReadStructureItem[]).map((item) => item.id),
    );
    expect(ids).toEqual(many.map((node) => node.id));
    expect(new Set(ids).size).toBe(many.length);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.items.length).toBeGreaterThan(0);
  });
});

describe("content", () => {
  const BODY_A = "甲".repeat(5000);
  const BODY_B = "😀".repeat(1200) + "终点";
  const CONTENT_NODES: ReadViewNode[] = [
    makeNode("a", "主线 A", "r", "next", {
      number: "02",
      description: "沿主线继续",
      sourcePath: "topics/t1/a.md",
      fileHash: "hash-a",
      body: BODY_A,
    }),
    makeNode("b", "主线 B", "a", "next", {
      number: "03",
      description: "再沿主线继续",
      sourcePath: "topics/t1/b.md",
      fileHash: "hash-b",
      body: BODY_B,
    }),
  ];

  it("默认多卡按预算分页，最终覆盖全部节点与正文且不重复", () => {
    const budget = 2400;
    const pages = collectPages(
      (cursor) => contentPage(cursor, budget, CONTENT_NODES),
      budget,
    );
    const items = pages.flatMap((page) => page.items as ReadContentItem[]);
    expect(pages.length).toBeGreaterThan(1);

    const expected = new Map([
      ["a", BODY_A],
      ["b", BODY_B],
    ]);
    const assembled = new Map<string, string>();
    const nextStart = new Map<string, number>();
    const nodeOrder = CONTENT_NODES.map((node) => node.id);
    const sequence: number[] = [];

    for (const item of items) {
      const id = item.node.id;
      const full = expected.get(id) as string;
      sequence.push(nodeOrder.indexOf(id));
      expect(item.range.total).toBe(full.length);
      expect(item.range.start).toBe(nextStart.get(id) ?? 0);
      expect(item.body).toBe(full.slice(item.range.start, item.range.end));
      expect(item.body.length).toBe(item.range.end - item.range.start);
      expect(item.truncated).toBe(item.range.end < item.range.total);
      expect(hasUnpairedSurrogate(item.body)).toBe(false);
      nextStart.set(id, item.range.end);
      assembled.set(id, (assembled.get(id) ?? "") + item.body);
    }

    // 只要结尾已到全文末尾，就不再表示“还有正文未返回”。
    expect(items.some((item) => item.truncated)).toBe(true);
    for (const item of items) {
      if (item.range.end === item.range.total) expect(item.truncated).toBe(false);
    }

    expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
    expect(assembled.get("a")).toBe(BODY_A);
    expect(assembled.get("b")).toBe(BODY_B);
    expect(nextStart.get("a")).toBe(BODY_A.length);
    expect(nextStart.get("b")).toBe(BODY_B.length);
    expect(pages[pages.length - 1]?.budget.mode).toBe("auto");
    expect(pages[0]?.scope.note).toContain("按预算续读");
  });

  it("显式 full 超预算抛 BUDGET_EXCEEDED，不返回半份数据", () => {
    const budget = 1200;
    const error = expectError(
      () => contentPage(undefined, budget, CONTENT_NODES, { full: true }),
      "BUDGET_EXCEEDED",
    );
    expect(error.details).toMatchObject({ limit: budget, view: "content" });
    expect(Number(error.details?.["required"])).toBeGreaterThan(budget);
  });

  it("显式 start/length 精确切片且不使用自动续读", () => {
    const response = contentPage(
      undefined,
      DEFAULT_READ_BUDGET,
      CONTENT_NODES,
      { start: 1, length: 5 },
    );
    const item = response.items[0] as ReadContentItem;
    expect(item.body).toBe(BODY_A.slice(1, 6));
    expect(item.range).toEqual({ start: 1, end: 6, total: BODY_A.length, unit: "utf16" });
    expect(item.truncated).toBe(true);
    expect(response.page).toEqual({ hasMore: false });
    expect(response.budget.mode).toBe("explicit");

    const fullPage = contentPage(undefined, DEFAULT_READ_BUDGET, CONTENT_NODES, {
      start: 0,
      length: 10,
    });
    expect((fullPage.items[0] as ReadContentItem).body).toBe(BODY_A.slice(0, 10));

    // 从 --start 中段一直读到末尾：没有后续正文，不再标记 truncated。
    const tailStart = BODY_A.length - 10;
    const tailPage = contentPage(
      undefined,
      DEFAULT_READ_BUDGET,
      [CONTENT_NODES[0] as ReadViewNode],
      { start: tailStart },
    );
    const tailItem = tailPage.items[0] as ReadContentItem;
    expect(tailItem.range).toEqual({
      start: tailStart,
      end: BODY_A.length,
      total: BODY_A.length,
      unit: "utf16",
    });
    expect(tailItem.body).toBe(BODY_A.slice(tailStart));
    expect(tailItem.truncated).toBe(false);
  });

  it("meta 无正文但在线保留真实 editRef，缺失时为 null", () => {
    const ref: AgentEditRef = {
      ref: "er_test",
      workspaceId: W,
      topicId: T1,
      nodeId: "a",
      path: "topics/t1/a.md",
      fileHash: "hash-a",
      instanceId: "inst-1",
      revision: 7,
      issuedAt: "2026-01-01T00:00:00.000Z",
    };
    const response = contentPage(
      undefined,
      DEFAULT_READ_BUDGET,
      CONTENT_NODES,
      { meta: true },
      { editRefs: { a: ref } },
    );
    const items = response.items as ReadContentItem[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      body: "",
      bodyOmitted: true,
      range: { start: 0, end: 0, total: BODY_A.length, unit: "utf16" },
      truncated: false,
      path: "topics/t1/a.md",
      fileHash: "hash-a",
    });
    expect(items[0]?.editRef).toEqual(ref);
    expect(items[1]?.editRef).toBeNull();
    expect(response.budget.mode).toBe("auto");
    // meta 续读只继续元数据，不能借用“多卡正文续读”的范围说明。
    expect(response.scope.note).not.toContain("正文");
    expect(response.scope.note).not.toContain("按预算续读");
  });

  it("meta 跨页续读仍只返回元数据并保留 editRef", () => {
    const refFor = (nodeId: string, hash: string): AgentEditRef => ({
      ref: "er_" + nodeId,
      workspaceId: W,
      topicId: T1,
      nodeId,
      path: "topics/t1/" + nodeId + ".md",
      fileHash: hash,
      instanceId: "inst-1",
      revision: 7,
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    const refs: Record<string, AgentEditRef> = {
      a: refFor("a", "hash-a"),
      b: refFor("b", "hash-b"),
    };
    const budget = 1500;
    const all: ReadContentItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const decoded = cursor === undefined ? undefined : decodeReadCursor(cursor);
      const contentOptions: ReadViewBuildInput["content"] =
        decoded === undefined || decoded.meta === true ? { meta: true } : {};
      const response = contentPage(
        cursor,
        budget,
        CONTENT_NODES,
        contentOptions,
        { editRefs: refs },
      );
      expect(response.budget.used).toBe(JSON.stringify(response).length);
      expect(JSON.stringify(response).length).toBeLessThanOrEqual(budget);
      const items = response.items as ReadContentItem[];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.bodyOmitted).toBe(true);
        expect(item.body).toBe("");
        expect(item.truncated).toBe(false);
        expect(item.editRef).toEqual(refs[item.node.id]);
      }
      all.push(...items);
      pages += 1;
      if (!response.page.hasMore) break;
      cursor = response.page.next as string;
      expect(decodeReadCursor(cursor).meta).toBe(true);
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(all.map((item) => item.node.id)).toEqual(["a", "b"]);
    expect(new Set(all.map((item) => item.node.id)).size).toBe(2);
  });

  it("BUDGET_TOO_SMALL.minimum 计入最小候选卡片", () => {
    const node = CONTENT_NODES[0] as ReadViewNode;
    const failingBudget = 1;
    const error = expectError(
      () => contentPage(undefined, failingBudget, [node], {}),
      "BUDGET_TOO_SMALL",
    );
    const minimum = Number(error.details?.["minimum"]);
    expect(minimum).toBeGreaterThan(failingBudget);

    // minimum 不是偏小的空页长度：按它读取必须真正返回一张最小候选卡片。
    const smallest = contentPage(undefined, minimum, [node], {});
    expect(smallest.items.length).toBeGreaterThan(0);
    expect(smallest.budget.used).toBe(JSON.stringify(smallest).length);
    expect(JSON.stringify(smallest).length).toBeLessThanOrEqual(minimum);

    // 再少一个单元就放不下。
    const below = expectError(
      () => contentPage(undefined, minimum - 1, [node], {}),
      "BUDGET_TOO_SMALL",
    );
    expect(Number(below.details?.["minimum"])).toBeGreaterThanOrEqual(minimum);
  });

  it("离线 content 的 editRef 必须为 null", () => {
    const response = contentPage(
      undefined,
      DEFAULT_READ_BUDGET,
      [CONTENT_NODES[0] as ReadViewNode],
      { meta: true },
      {
        mode: "disk",
        editRefs: {},
        envelope: {
          source: "disk",
          root: "D:/workspace",
          online: {
            available: false,
            code: "OFFLINE_REQUESTED",
            reason: "--offline 指定只读磁盘",
          },
        },
      },
    );
    const item = response.items[0] as ReadContentItem;
    expect(item.editRef).toBeNull();
    expect(item.bodyOmitted).toBe(true);
    expect(response.source).toBe("disk");
    expect(response.online.available).toBe(false);
  });

  it("极小预算抛 BUDGET_TOO_SMALL，不用空页循环", () => {
    const overviewError = expectError(
      () => overviewPage(undefined, 1),
      "BUDGET_TOO_SMALL",
    );
    expect(overviewError.details).toMatchObject({ limit: 1, view: "overview" });
    expect(Number(overviewError.details?.["minimum"])).toBeGreaterThan(1);

    const contentError = expectError(
      () => contentPage(undefined, 1, [CONTENT_NODES[0] as ReadViewNode], {}),
      "BUDGET_TOO_SMALL",
    );
    expect(contentError.details).toMatchObject({ limit: 1, view: "content" });
    expect(Number(contentError.details?.["minimum"])).toBeGreaterThan(1);
  });
});

describe("fingerprint 与续读", () => {
  function structureToken(): string {
    const response = structurePage(undefined, 1200);
    expect(response.page.hasMore).toBe(true);
    return response.page.next as string;
  }

  it("范围内元数据变化使 token stale", () => {
    const token = structureToken();
    const changed = FIXTURE.map((node) =>
      node.id === "b" ? { ...node, title: "改名后的主线 B" } : node,
    );
    const error = expectError(
      () => structurePage(token, 1200, { kind: "topic" }, changed),
      "STALE_READ",
    );
    expect(error.details).toMatchObject({ view: "structure", topicId: T1 });
    expect(error.details?.["scope"]).toBeDefined();
  });

  it("范围外节点变化不使 token 失效", () => {
    const token = (() => {
      const response = structurePage(undefined, 1140, { kind: "subtree", from: "br1" });
      expect(response.page.hasMore).toBe(true);
      return response.page.next as string;
    })();
    const changed = FIXTURE.map((node) =>
      node.id === "b" ? { ...node, title: "范围外改名" } : node,
    );
    const response = structurePage(token, 1140, { kind: "subtree", from: "br1" }, changed);
    expect(response.ok).toBe(true);
    expect(response.budget.used).toBe(JSON.stringify(response).length);
  });

  it("subtree 边界外部父节点标题变化使 token stale", () => {
    const response = structurePage(undefined, 1140, { kind: "subtree", from: "br1" });
    expect(response.page.hasMore).toBe(true);
    const token = response.page.next as string;
    const changed = FIXTURE.map((node) =>
      node.id === "r" ? { ...node, title: "改名后的根" } : node,
    );
    const error = expectError(
      () => structurePage(token, 1140, { kind: "subtree", from: "br1" }, changed),
      "STALE_READ",
    );
    expect(error.details).toMatchObject({ view: "structure", topicId: T1 });
  });

  it("content 指纹包含请求节点的哈希与正文长度，范围外变化不失效", () => {
    const nodeA = makeNode("a", "主线 A", "r", "next", {
      sourcePath: "topics/t1/a.md",
      fileHash: "hash-a",
      body: "甲".repeat(5000),
    });
    const nodeB = makeNode("b", "主线 B", "a", "next", {
      sourcePath: "topics/t1/b.md",
      fileHash: "hash-b",
      body: "乙".repeat(5000),
    });
    const response = contentPage(undefined, 2400, [nodeA]);
    expect(response.page.hasMore).toBe(true);
    const token = response.page.next as string;

    // 范围外的 b 变化：scope 仍是 [a]，content 只解析请求节点 a，指纹不变。
    const withOutsideChange = contentPage(
      token,
      2400,
      [nodeA, { ...nodeB, title: "范围外改名", body: "乙".repeat(4000) }],
      undefined,
      { scope: { kind: "nodes", nodeIds: ["a"] } },
    );
    expect(withOutsideChange.ok).toBe(true);

    // 请求节点本身哈希变化：stale。
    const staleNode = { ...nodeA, fileHash: "hash-a-changed" };
    expectError(() => contentPage(token, 2400, [staleNode]), "STALE_READ");

    // 正文长度变化（即使哈希未变）也会 stale。
    const lengthChanged = { ...nodeA, body: (nodeA.body as string).slice(0, 4900) };
    expectError(() => contentPage(token, 2400, [lengthChanged]), "STALE_READ");
  });

  it("mode / workspace / view / scope 不匹配时拒绝续读", () => {
    const token = structureToken();
    expectError(
      () =>
        buildReadView(
          makeInput({
            view: "structure",
            scope: { kind: "topic" },
            budget: 1200,
            cursor: token,
            mode: "disk",
            envelope: {
              source: "disk",
              root: "D:/workspace",
              online: { available: false, code: "OFFLINE", reason: "offline" },
            },
          }),
        ),
      "INVALID_CURSOR",
    );
    expectError(
      () =>
        buildReadView(
          makeInput({
            view: "structure",
            scope: { kind: "topic" },
            budget: 1200,
            cursor: token,
            workspaceId: "other_workspace",
          }),
        ),
      "INVALID_CURSOR",
    );
    expectError(
      () =>
        buildReadView(
          makeInput({
            view: "overview",
            scope: { kind: "topic" },
            budget: 1200,
            cursor: token,
          }),
        ),
      "INVALID_CURSOR",
    );
    expectError(
      () =>
        buildReadView(
          makeInput({
            view: "structure",
            scope: { kind: "subtree", from: "a" },
            budget: 1200,
            cursor: token,
          }),
        ),
      "INVALID_CURSOR",
    );
  });

  it("decodeReadCursor 暴露稳定字段并拒绝坏 token", () => {
    const token = structureToken();
    const decoded = decodeReadCursor(token);
    expect(decoded).toMatchObject({
      version: 1,
      mode: "online",
      workspaceId: W,
      topicId: T1,
      view: "structure",
      scope: { kind: "topic" },
    });
    expect(typeof decoded.fingerprint).toBe("string");
    expect(typeof decoded.offset).toBe("number");
    expectError(() => decodeReadCursor("not-json"), "INVALID_CURSOR");
    expectError(() => decodeReadCursor(""), "INVALID_CURSOR");
  });
});

describe("确定性、预算与切片细节", () => {
  it("相同输入得到完全相同的响应", () => {
    const input = makeInput({ view: "overview", scope: { kind: "topic" }, budget: 2000 });
    const first = buildReadView(input);
    const second = buildReadView(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("显式切片不切断代理对", () => {
    const node = makeNode("s", "代理对", null, "root", {
      sourcePath: "topics/t1/s.md",
      fileHash: "hash-s",
      body: "ab😀cd",
    });
    const response = contentPage(undefined, DEFAULT_READ_BUDGET, [node], {
      start: 0,
      length: 3,
    });
    const item = response.items[0] as ReadContentItem;
    // 原始 end=3 落在代理对中间，sliceBody 向后收一格到 4。
    expect(item.body).toBe("ab😀");
    expect(item.range.end).toBe(4);
    expect(item.truncated).toBe(true);
    expect(hasUnpairedSurrogate(item.body)).toBe(false);
  });

  it("章节切片复用 locateSection 且代码围栏里的 # 不算标题", () => {
    const body = "# 内容\n\n正文\n\n## 小节\n\n细节\n\n```\n# 代码里的标题\n```\n";
    const node = makeNode("s", "章节", null, "root", {
      sourcePath: "topics/t1/s.md",
      fileHash: "hash-s",
      body,
    });
    const response = contentPage(undefined, DEFAULT_READ_BUDGET, [node], {
      section: "小节",
    });
    const item = response.items[0] as ReadContentItem;
    const expectedStart = body.indexOf("## 小节");
    expect(item.range.start).toBe(expectedStart);
    expect(item.body.startsWith("## 小节")).toBe(true);

    const duplicate = "# 前言\n\n## 同名\n\nA\n\n## 同名\n\nB\n";
    const dupNode = { ...node, body: duplicate };
    expectError(
      () => contentPage(undefined, DEFAULT_READ_BUDGET, [dupNode], { section: "同名" }),
      "INVALID_SECTION",
    );
    const second = contentPage(undefined, DEFAULT_READ_BUDGET, [dupNode], {
      section: "同名",
      sectionIndex: 1,
    });
    expect((second.items[0] as ReadContentItem).range.start).toBe(
      duplicate.lastIndexOf("## 同名"),
    );
    expectError(
      () =>
        contentPage(undefined, DEFAULT_READ_BUDGET, [dupNode], {
          sectionIndex: 0,
        }),
      "INVALID_SECTION",
    );
  });

  it("自动分页的每张卡都不含未配对代理项", () => {
    const body = "字😀".repeat(1500);
    const node = makeNode("s", "代理对自动分页", null, "root", {
      sourcePath: "topics/t1/s.md",
      fileHash: "hash-s",
      body,
    });
    const budget = 2200;
    const pages = collectPages(
      (cursor) => contentPage(cursor, budget, [node]),
      budget,
    );
    const items = pages.flatMap((page) => page.items as ReadContentItem[]);
    expect(items.map((item) => item.body).join("")).toBe(body);
    for (const item of items) {
      expect(hasUnpairedSurrogate(item.body)).toBe(false);
      expect(item.range.start <= item.range.end).toBe(true);
    }
  });
});
