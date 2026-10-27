/**
 * batch / insert 的服务级契约：
 * 真实工作区 + startService/fetch，覆盖 r3 混合批次、多 create 局部引用与默认 order、
 * dry-run 不落盘、幂等、冲突分类、noop／importance／lastChanges 与 insert 相邻校验。
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { initWorkspace } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import type {
  AgentBatchCheckResponse,
  AgentChangeResponse,
  ReadViewResponse,
} from "../../src/shared/protocol.js";

const temporaryRoots: string[] = [];
const running: Array<{ stop(): Promise<void> }> = [];

const R = "n_" + "1".repeat(32);
const N = "n_" + "2".repeat(32);
const MAIN_B = "n_" + "3".repeat(32);
const BRANCH = "n_" + "4".repeat(32);
const TOPIC = "t_" + "5".repeat(32);
const DIR = "讨论";

const OTHER_TOPIC = "t_" + "6".repeat(32);
const OTHER_DIR = "旁支";
const OTHER_ROOT = "n_" + "7".repeat(32);

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next" | "branch";
  description?: string;
  side?: "left" | "right";
  order?: number;
  important?: boolean;
  body: string;
}): string {
  const lines = [
    "---",
    "nodeId: " + options.nodeId,
    "title: " + options.title,
    "state: proposed",
    "from: " + (options.from ?? "null"),
    "flow: " + options.flow,
  ];
  if (options.description !== undefined) lines.push("description: " + options.description);
  if (options.side !== undefined) lines.push("side: " + options.side);
  if (options.order !== undefined) lines.push("order: " + String(options.order));
  if (options.important === true) lines.push("important: true");
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function newWorkspace(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-batch-"));
  temporaryRoots.push(parent);
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "batch-test" });

  const mainDir = path.join(root, "topics", DIR);
  await fs.mkdir(mainDir, { recursive: true });
  await fs.writeFile(
    path.join(mainDir, "topic.md"),
    "---\ntopicId: " + TOPIC + "\ntitle: 维护记录\n---\n",
    "utf8",
  );
  const nodes: Array<[string, string, string | null, "root" | "next" | "branch", string, Record<string, unknown>?]> = [
    [R, "记录目的", null, "root", "先说明为什么要维护。", {}],
    [N, "维护方式", R, "next", "旧正文。", { description: "先目的后方式" }],
    [MAIN_B, "继续维护", N, "next", "主线第三张。", { description: "沿主线继续" }],
    [BRANCH, "起点侧枝", R, "branch", "侧枝正文。", { description: "从目的展开侧枝", side: "right", order: 10 }],
  ];
  for (const [id, title, from, flow, body, extra] of nodes) {
    await fs.writeFile(
      path.join(mainDir, id + ".md"),
      nodeFile({
        nodeId: id,
        title,
        from,
        flow,
        body,
        ...(extra ?? {}),
      } as Parameters<typeof nodeFile>[0]),
      "utf8",
    );
  }

  const otherDir = path.join(root, "topics", OTHER_DIR);
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(
    path.join(otherDir, "topic.md"),
    "---\ntopicId: " + OTHER_TOPIC + "\ntitle: 旁支主题\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(otherDir, OTHER_ROOT + ".md"),
    nodeFile({ nodeId: OTHER_ROOT, title: "旁支起点", from: null, flow: "root", body: "旁支正文。" }),
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

async function readRefs(url: string, nodeIds: readonly string[]): Promise<Record<string, string>> {
  const query = nodeIds.map((id) => "node=" + id).join("&");
  const response = await fetch(
    url + "/api/agent/read?view=content&topic=" + TOPIC + "&" + query + "&budget=100000",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as ReadViewResponse;
  const refs: Record<string, string> = {};
  for (const id of nodeIds) {
    const token = body.refs[id];
    expect(token, "缺少节点 " + id + " 的 ref").toBeTruthy();
    refs[id] = token as string;
  }
  return refs;
}

function agentHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-aichat-client": "cli" };
}

async function postAgent(
  url: string,
  workspaceId: string,
  requestId: string,
  action: unknown,
  dryRun?: boolean,
): Promise<Response> {
  return fetch(url + "/api/agent/changes", {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({
      workspaceId,
      requestId,
      ...(dryRun === true ? { dryRun: true } : {}),
      action,
    }),
  });
}

interface GraphBody {
  nodes: Array<{
    id: string;
    from: string | null;
    flow: string;
    order?: number;
    description?: string;
    important: boolean;
    title: string;
  }>;
  lastChanges?: Record<string, { at: string; nodeIds: string[] }>;
}

async function graph(url: string): Promise<GraphBody> {
  return (await (await fetch(url + "/api/graph")).json()) as GraphBody;
}

async function nodeFileText(root: string, dir: string, nodeId: string): Promise<string> {
  return fs.readFile(path.join(root, "topics", dir, nodeId + ".md"), "utf8");
}

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("batch：一次编译提交", () => {
  it("r3：旧节点追加 + 创建新后继一次 batch，正文与最近更新都落在最终内容", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, MAIN_B]);
    const requestId = randomUUID();

    const response = await postAgent(handle.url, handle.workspaceId, requestId, {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "edit", target: { ref: refs[R] as string }, patch: { append: "\n\n先读后写：所有修改都基于真实读取。" } },
        {
          op: "create",
          as: "issue",
          from: { ref: refs[MAIN_B] as string },
          flow: "next",
          title: "新问题",
          body: "新问题正文。",
          description: "在维护方式之后继续追问",
          important: true,
        },
      ],
    });
    expect(response.status, JSON.stringify(await response.clone().text())).toBe(200);
    const body = (await response.json()) as AgentChangeResponse;
    expect(body.ok).toBe(true);
    expect(body.state).toBe("committed");
    expect(body.action).toBe("batch");
    expect(body.workspaceId).toBe(handle.workspaceId);
    expect(body.topicId).toBe(TOPIC);
    expect(body.created.aliases["issue"]).toMatch(/^n_[0-9a-f]{32}$/);
    const createdId = body.created.aliases["issue"] as string;
    expect(body.created.nodeIds).toEqual([createdId]);
    expect(body.changedNodeIds.sort()).toEqual([R, createdId].sort());
    expect(Object.keys(body.refs).sort()).toEqual([R, createdId].sort());
    expect(body.refs[createdId]).toMatch(/^er_/);

    const rootText = await nodeFileText(root, DIR, R);
    expect(rootText).toContain("先读后写：所有修改都基于真实读取。");
    expect(rootText).not.toContain("\n\n\n先读后写");
    const createdText = await nodeFileText(root, DIR, createdId);
    expect(createdText).toContain("title: 新问题");
    expect(createdText).toContain("新问题正文。");
    expect(createdText).toContain("important: true");
    expect(createdText).toContain("from: " + MAIN_B);

    const after = await graph(handle.url);
    expect(after.lastChanges?.[TOPIC]?.nodeIds.sort()).toEqual([R, createdId].sort());
    const created = after.nodes.find((node) => node.id === createdId);
    expect(created).toMatchObject({ from: MAIN_B, flow: "next", description: "在维护方式之后继续追问", important: true });
  });

  it("多 create 局部前向引用：按依赖拓扑创建，aliases 稳定，branch order 按输入顺序分配", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, MAIN_B]);

    const response = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        // b/c 前向引用 a；a 在输入后面才声明。
        { op: "create", as: "b", from: { local: "a" }, flow: "branch", title: "B", body: "B 正文。", description: "从 A 分出 B" },
        { op: "create", as: "c", from: { local: "b" }, flow: "branch", title: "C", body: "C 正文。", description: "从 B 分出 C" },
        { op: "create", as: "a", from: { ref: refs[MAIN_B] as string }, flow: "next", title: "A", body: "A 正文。", description: "在继续维护之后插入 A" },
        // R 已有 order=10 的侧枝：默认 order 从 20 起按输入顺序递增。
        { op: "create", as: "d", from: { ref: refs[R] as string }, flow: "branch", title: "D", body: "D 正文。", description: "从目的展开 D" },
        { op: "create", as: "e", from: { ref: refs[R] as string }, flow: "branch", title: "E", body: "E 正文。", description: "从目的展开 E" },
      ],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentChangeResponse;
    expect(body.state).toBe("committed");
    const aliases = body.created.aliases;
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect(aliases[name]).toMatch(/^n_[0-9a-f]{32}$/);
    }
    expect(body.created.nodeIds.length).toBe(5);

    const after = await graph(handle.url);
    const byId = new Map(after.nodes.map((node) => [node.id, node] as const));
    expect(byId.get(aliases["a"] as string)).toMatchObject({ from: MAIN_B, flow: "next" });
    expect(byId.get(aliases["b"] as string)).toMatchObject({
      from: aliases["a"],
      flow: "branch",
      order: 10,
    });
    expect(byId.get(aliases["c"] as string)).toMatchObject({
      from: aliases["b"],
      flow: "branch",
      order: 10,
    });
    expect(byId.get(aliases["d"] as string)).toMatchObject({ from: R, flow: "branch", order: 20 });
    expect(byId.get(aliases["e"] as string)).toMatchObject({ from: R, flow: "branch", order: 30 });
    expect(after.lastChanges?.[TOPIC]?.nodeIds.length).toBe(5);
  });

  it("dry-run 只检查：不落盘、不写 agentLog、不更新 lastChanges；同 requestId 随后真跑仍执行", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R]);
    const requestId = randomUUID();
    const action = {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "edit", target: { ref: refs[R] as string }, patch: { append: "dry-run 不应落盘。" } }],
    };
    const before = await nodeFileText(root, DIR, R);
    const beforeGraph = await graph(handle.url);
    const beforeLast = JSON.stringify(beforeGraph.lastChanges ?? null);

    const dry = await postAgent(handle.url, handle.workspaceId, requestId, action, true);
    expect(dry.status).toBe(200);
    const dryBody = (await dry.json()) as AgentBatchCheckResponse;
    expect(dryBody).toMatchObject({
      ok: true,
      command: "batch",
      dryRun: true,
      state: "checked",
      requestId,
      workspaceId: handle.workspaceId,
      topicId: TOPIC,
    });
    expect(dryBody.files.length).toBe(1);
    expect(dryBody.files[0]?.path).toBe("topics/" + DIR + "/" + R + ".md");
    expect(dryBody.files[0]?.beforeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dryBody.files[0]?.nextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dryBody.files[0]?.deleted).toBe(false);
    expect(dryBody).not.toHaveProperty("created");
    expect(dryBody).not.toHaveProperty("refs");
    expect(await nodeFileText(root, DIR, R)).toBe(before);
    expect(JSON.stringify((await graph(handle.url)).lastChanges ?? null)).toBe(beforeLast);

    // dry-run 不进入幂等日志：同 requestId 的真实请求正常执行。
    const real = await postAgent(handle.url, handle.workspaceId, requestId, action);
    expect(real.status).toBe(200);
    const realBody = (await real.json()) as AgentChangeResponse;
    expect(realBody.state).toBe("committed");
    expect(await nodeFileText(root, DIR, R)).toContain("dry-run 不应落盘。");
    // 再重放同 requestId + 同 body：返回原响应，不再追加。
    const replay = await postAgent(handle.url, handle.workspaceId, requestId, action);
    expect(((await replay.json()) as AgentChangeResponse).replayed).toBe(true);
    expect((await nodeFileText(root, DIR, R)).match(/dry-run 不应落盘。/g)).toHaveLength(1);
  });

  it("错误码拆分：占位 409；跨主题／局部依赖环／最终重复 next／最终成环 422，且都不落盘", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, N, MAIN_B, BRANCH]);
    const before = new Map<string, string>();
    for (const id of [R, N, MAIN_B, BRANCH]) before.set(id, await nodeFileText(root, DIR, id));

    // 占位冲突（409）：R 的 next 仍是 N 且本批没有显式移走 N，新 create 不能挤掉。
    const duplicate = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "create", as: "dup", from: { ref: refs[R] as string }, flow: "next", title: "重复", body: "正文", description: "不应占用已有 next" }],
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = (await duplicate.json()) as { error: { code: string; details?: { category?: string; ops?: number[]; sourceId?: string; conflict?: string } } };
    expect(duplicateBody.error.code).toBe("OPERATION_CONFLICT");
    expect(duplicateBody.error.details?.category).toBe("structure");
    expect(duplicateBody.error.details?.conflict).toBe("next-occupied");
    expect(duplicateBody.error.details?.ops).toEqual([0]);

    // 占位冲突（409，connect 版本）：分支 B 想改接成 R 的 next，但原后继 N 未移走。
    const occupied = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "connect", target: { ref: refs[BRANCH] as string }, flow: "next", description: "不应挤掉原后继" }],
    });
    expect(occupied.status).toBe(409);
    expect(((await occupied.json()) as { error: { details?: { conflict?: string } } }).error.details?.conflict).toBe("next-occupied");

    // 最终重复 next（422）：MAIN_B 批前没有 next，两个 create 同时抢槽位属于最终图结构不合法。
    const multipleNext = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "create", as: "n1", from: { ref: refs[MAIN_B] as string }, flow: "next", title: "N1", body: "正文", description: "第一条" },
        { op: "create", as: "n2", from: { ref: refs[MAIN_B] as string }, flow: "next", title: "N2", body: "正文", description: "第二条" },
      ],
    });
    expect(multipleNext.status).toBe(422);
    const multipleNextBody = (await multipleNext.json()) as { error: { code: string; details?: { category?: string; conflict?: string } } };
    expect(multipleNextBody.error.code).toBe("VALIDATION_FAILED");
    expect(multipleNextBody.error.details?.category).toBe("structure");
    expect(multipleNextBody.error.details?.conflict).toBe("next-multiple");

    // 局部依赖成环（422）：两个 create 互相作为来源，无法确定创建顺序。
    const localCycle = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "create", as: "a", from: { local: "b" }, flow: "branch", title: "A", body: "正文", description: "依赖 B" },
        { op: "create", as: "b", from: { local: "a" }, flow: "branch", title: "B", body: "正文", description: "依赖 A" },
      ],
    });
    expect(localCycle.status).toBe(422);
    const localCycleBody = (await localCycle.json()) as { error: { code: string; details?: { category?: string; conflict?: string } } };
    expect(localCycleBody.error.code).toBe("VALIDATION_FAILED");
    expect(localCycleBody.error.details?.category).toBe("structure");
    expect(localCycleBody.error.details?.conflict).toBe("local-cycle");

    // 成环（422）：N 改接 next 到 B，而 B 仍是 N 的 next。
    const cycle = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "connect", target: { ref: refs[N] as string }, from: { ref: refs[MAIN_B] as string }, flow: "next", description: "不应形成环" }],
    });
    expect(cycle.status).toBe(422);
    const cycleBody = (await cycle.json()) as { error: { code: string; details?: { category?: string; conflict?: string } } };
    expect(cycleBody.error.code).toBe("VALIDATION_FAILED");
    expect(cycleBody.error.details?.category).toBe("structure");
    expect(cycleBody.error.details?.conflict).toBe("cycle");

    // 重复 local。
    const duplicateLocal = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "create", as: "x", from: { ref: refs[R] as string }, flow: "branch", title: "X", body: "正文", description: "第一处" },
        { op: "create", as: "x", from: { ref: refs[R] as string }, flow: "branch", title: "Y", body: "正文", description: "第二处" },
      ],
    });
    expect(duplicateLocal.status).toBe(422);

    // 同一节点重复同类操作。
    const duplicateKind = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "important", target: { ref: refs[R] as string }, important: true },
        { op: "important", target: { ref: refs[R] as string }, important: false },
      ],
    });
    expect(duplicateKind.status).toBe(422);

    // 跨主题。
    const otherTopicResponse = await fetch(
      handle.url + "/api/agent/read?view=content&node=" + OTHER_ROOT + "&budget=100000",
    );
    const otherRead = (await otherTopicResponse.json()) as ReadViewResponse;
    const cross = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "create", as: "cross", from: { ref: otherRead.refs[OTHER_ROOT] as string }, flow: "branch", title: "跨主题", body: "正文", description: "不应跨主题" }],
    });
    expect(cross.status).toBe(422);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");

    // 未知主题。
    const unknownTopic = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: "t_" + "9".repeat(32),
      ops: [{ op: "create", as: "u", from: { ref: refs[R] as string }, flow: "branch", title: "U", body: "正文", description: "主题不存在" }],
    });
    expect(unknownTopic.status).toBe(422);

    // 未声明的 local。
    const unknownLocal = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "create", as: "m", from: { local: "ghost" }, flow: "branch", title: "M", body: "正文", description: "引用不存在的局部名称" }],
    });
    expect(unknownLocal.status).toBe(422);

    for (const id of [R, N, MAIN_B, BRANCH]) {
      expect(await nodeFileText(root, DIR, id)).toBe(before.get(id));
    }
    const diskFiles = await fs.readdir(path.join(root, "topics", DIR));
    expect(diskFiles.filter((file) => file.endsWith(".md"))).toHaveLength(5);
  });

  it("过期 ref → 412；noop、仅 important、混合批次与 lastChanges 语义正确", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    // 先建立一次真实内容更新，作为 lastChanges 基线。
    const baseRefs = await readRefs(handle.url, [R]);
    const baseline = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "edit", target: { ref: baseRefs[R] as string }, patch: { append: "基线追加。" } }],
    });
    expect(baseline.status).toBe(200);
    const baselineLast = (await graph(handle.url)).lastChanges?.[TOPIC];
    expect(baselineLast?.nodeIds).toEqual([R]);

    // 仅 important：文件改写但不替换最近内容更新。
    const importantRefs = await readRefs(handle.url, [N]);
    const important = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "important", target: { ref: importantRefs[N] as string }, important: true }],
    });
    expect(important.status).toBe(200);
    const importantBody = (await important.json()) as AgentChangeResponse;
    expect(importantBody.state).toBe("committed");
    expect(importantBody.changedNodeIds).toEqual([N]);
    expect(importantBody.refs[N]).toMatch(/^er_/);
    expect((await graph(handle.url)).lastChanges?.[TOPIC]).toEqual(baselineLast);

    // noop：标题与重要标记都未变化。
    const noopRefs = await readRefs(handle.url, [N]);
    const noop = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "edit", target: { ref: noopRefs[N] as string }, patch: { title: "维护方式" } },
        { op: "important", target: { ref: noopRefs[N] as string }, important: true },
      ],
    });
    expect(noop.status).toBe(200);
    const noopBody = (await noop.json()) as AgentChangeResponse;
    expect(noopBody.state).toBe("noop");
    expect(noopBody.changedNodeIds).toEqual([]);
    expect(noopBody.refs).toEqual({});
    expect(noopBody.created.nodeIds).toEqual([]);
    expect((await graph(handle.url)).lastChanges?.[TOPIC]).toEqual(baselineLast);

    // 混合批次：正文改写 + 仅 important；lastChanges 只含最终真实改写内容的节点。
    const mixedRefs = await readRefs(handle.url, [N, MAIN_B]);
    const mixed = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "edit", target: { ref: mixedRefs[N] as string }, patch: { append: "混合批次正文追加。" } },
        { op: "important", target: { ref: mixedRefs[MAIN_B] as string }, important: true },
      ],
    });
    expect(mixed.status).toBe(200);
    const mixedBody = (await mixed.json()) as AgentChangeResponse;
    expect(mixedBody.changedNodeIds.sort()).toEqual([N, MAIN_B].sort());
    expect((await graph(handle.url)).lastChanges?.[TOPIC]?.nodeIds).toEqual([N]);
    expect((await nodeFileText(root, DIR, N))).toContain("混合批次正文追加。");

    // 过期 ref：读取后源文件被另一请求改写并发布 → 412，且不落盘。
    const staleRefs = await readRefs(handle.url, [R]);
    const beforeBytes = await nodeFileText(root, DIR, R);
    const otherWrite = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "patchNode",
      editRef: staleRefs[R] as string,
      append: "另一个请求先写入。",
    });
    expect(otherWrite.status).toBe(200);
    const stale = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "edit", target: { ref: staleRefs[R] as string }, patch: { append: "旧凭据不应写入。" } }],
    });
    expect(stale.status).toBe(412);
    expect(await nodeFileText(root, DIR, R)).not.toContain("旧凭据不应写入。");
    expect(await nodeFileText(root, DIR, R)).not.toBe(beforeBytes);
  });

  it("同 requestId 同请求体重放：返回原 aliases/refs，不重复创建", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [N]);
    const requestId = randomUUID();
    const action = {
      action: "batch",
      topicId: TOPIC,
      ops: [
        { op: "create", as: "one", from: { ref: refs[N] as string }, flow: "branch", title: "一", body: "正文一", description: "第一批" },
        { op: "create", as: "two", from: { local: "one" }, flow: "branch", title: "二", body: "正文二", description: "第二批" },
      ],
    };
    const first = await postAgent(handle.url, handle.workspaceId, requestId, action);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as AgentChangeResponse;
    const second = await postAgent(handle.url, handle.workspaceId, requestId, action);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as AgentChangeResponse;
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.created.nodeIds).toEqual(firstBody.created.nodeIds);
    expect(secondBody.created.aliases).toEqual(firstBody.created.aliases);
    expect(secondBody.refs).toEqual(firstBody.refs);
    const files = await fs.readdir(path.join(root, "topics", DIR));
    expect(files.filter((file) => file.endsWith(".md"))).toHaveLength(7);

    // 同 requestId 不同 body → 409，不执行。
    const conflict = await postAgent(handle.url, handle.workspaceId, requestId, {
      ...action,
      ops: [action.ops[0]],
    });
    expect(conflict.status).toBe(409);
  });

  it("create 抢占 next 槽位：原后继显式改为同源 branch 时整批成功落位", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, N]);

    const response = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [
        // 先把 R 的 next 槽位让给新节点；N 在本批改为 R 的 branch。
        {
          op: "create",
          as: "slot",
          from: { ref: refs[R] as string },
          flow: "next",
          title: "新主线",
          body: "新主线正文。",
          description: "改用新的主线",
        },
        {
          op: "connect",
          target: { ref: refs[N] as string },
          flow: "branch",
          description: "原主线改为侧枝保留",
        },
      ],
    });
    expect(response.status, JSON.stringify(await response.clone().text())).toBe(200);
    const body = (await response.json()) as AgentChangeResponse;
    expect(body.state).toBe("committed");
    const slotId = body.created.aliases["slot"] as string;
    const after = await graph(handle.url);
    const byId = new Map(after.nodes.map((node) => [node.id, node] as const));
    expect(byId.get(R)).toMatchObject({ flow: "root" });
    expect(byId.get(slotId)).toMatchObject({ from: R, flow: "next" });
    expect(byId.get(N)).toMatchObject({ from: R, flow: "branch", description: "原主线改为侧枝保留" });
    // 中间腾空只在内存：最终文件里 N 不是 next，也没有中间说明残留。
    const nText = await nodeFileText(root, DIR, N);
    expect(nText).toContain("flow: branch");
    expect(nText).not.toContain("flow: next");
    expect(nText).toContain("description: 原主线改为侧枝保留");
  });

  it("batch 的 edit.patch 不接受单卡 edit 的新字段（important／description／fromRef／flow）", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, N]);

    for (const patch of [
      { important: true },
      { description: "单卡 edit 的字段" },
      { fromRef: refs[R] as string, flow: "next", description: "单卡 edit 的字段" },
      { flow: "branch", description: "单卡 edit 的字段" },
    ]) {
      const response = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
        action: "batch",
        topicId: TOPIC,
        ops: [{ op: "edit", target: { ref: refs[N] as string }, patch }],
      });
      expect(response.status, JSON.stringify(patch)).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "BAD_REQUEST",
      );
    }

    // 普通 batch edit 仍按 AgentBatchEditPatch 工作。
    const ok = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "edit", target: { ref: refs[N] as string }, patch: { append: "batch 正常追加。" } }],
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as AgentChangeResponse).state).toBe("committed");
  });

  it("status 合并 agentLog：提交后可查回同一响应；dry-run 不产生记录", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [N, MAIN_B]);
    const requestId = randomUUID();
    const action = {
      action: "batch",
      topicId: TOPIC,
      ops: [{ op: "create", as: "s", from: { ref: refs[MAIN_B] as string }, flow: "branch", title: "状态卡", body: "正文", description: "记录状态" }],
    };
    const committed = await postAgent(handle.url, handle.workspaceId, requestId, action);
    expect(committed.status).toBe(200);
    const committedBody = (await committed.json()) as AgentChangeResponse;

    const status = await fetch(handle.url + "/api/changes/" + requestId);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as Record<string, unknown> & {
      source?: string;
      state?: string;
      created?: { aliases?: Record<string, string> };
    };
    expect(statusBody.source).toBe("session");
    expect(statusBody.state).toBe("committed");
    expect(statusBody.created?.aliases).toEqual(committedBody.created.aliases);

    // dry-run 不进 agentLog：查不到记录（不会伪造永久历史）。
    const dryId = randomUUID();
    const dry = await postAgent(
      handle.url,
      handle.workspaceId,
      dryId,
      { action: "batch", topicId: TOPIC, ops: [{ op: "edit", target: { ref: refs[N] as string }, patch: { append: "只检查。" } }] },
      true,
    );
    expect(dry.status).toBe(200);
    const dryStatus = await fetch(handle.url + "/api/changes/" + dryId);
    expect(dryStatus.status).toBe(404);
  });

  it("/api/workspace 保留既有字段并新增 program；dryRun 只用于 batch", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);

    const workspace = (await (await fetch(handle.url + "/api/workspace")).json()) as {
      workspaceId: string;
      rootPath: string;
      program?: { program: string; interfaceVersion: number; buildId: string; manifest?: string };
    };
    expect(workspace.workspaceId).toBe(handle.workspaceId);
    expect(workspace.rootPath.length).toBeGreaterThan(0);
    expect(workspace.program).toMatchObject({ program: "aichat-graph", interfaceVersion: 3 });
    expect(workspace.program?.buildId.length).toBeGreaterThan(0);

    const refs = await readRefs(handle.url, [N]);
    const invalid = await postAgent(
      handle.url,
      handle.workspaceId,
      randomUUID(),
      { action: "patchNode", editRef: refs[N] as string, append: "dryRun 不适用单动作。" },
      true,
    );
    expect(invalid.status).toBe(400);
  });
});

describe("insert：当前相邻 next 之间插入", () => {
  it("A→B→C 一次插入为 A→N→B→C，两条说明准确且无临时旁支落盘", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, N]);

    const response = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "insert",
      afterRef: refs[R] as string,
      beforeRef: refs[N] as string,
      title: "插入的问题",
      body: "插入的问题正文。",
      description: "先追问插入的问题",
      nextDescription: "原主线让给插入的问题之后",
      summary: "插入摘要",
    });
    expect(response.status, JSON.stringify(await response.clone().text())).toBe(200);
    const body = (await response.json()) as AgentChangeResponse;
    expect(body.action).toBe("insert");
    expect(body.state).toBe("committed");
    expect(body.topicId).toBe(TOPIC);
    expect(body.created.nodeIds).toHaveLength(1);
    expect(body.created.aliases).toEqual({});
    const insertedId = body.created.nodeIds[0] as string;
    expect(body.changedNodeIds.sort()).toEqual([insertedId, N].sort());
    expect(body.refs[insertedId]).toMatch(/^er_/);

    const after = await graph(handle.url);
    const byId = new Map(after.nodes.map((node) => [node.id, node] as const));
    expect(byId.get(insertedId)).toMatchObject({
      from: R,
      flow: "next",
      description: "先追问插入的问题",
    });
    expect(byId.get(N)).toMatchObject({
      from: insertedId,
      flow: "next",
      description: "原主线让给插入的问题之后",
    });
    expect(byId.get(R)?.title).toBe("记录目的");
    expect(after.nodes.map((node) => node.id).indexOf(insertedId)).toBeLessThan(
      after.nodes.map((node) => node.id).indexOf(N),
    );

    const insertedText = await nodeFileText(root, DIR, insertedId);
    expect(insertedText).toContain("title: 插入的问题");
    expect(insertedText).toContain("summary: 插入摘要");
    expect(insertedText).not.toContain("flow: branch");
    const beforeText = await nodeFileText(root, DIR, N);
    expect(beforeText).toContain("description: 原主线让给插入的问题之后");
    expect(after.lastChanges?.[TOPIC]?.nodeIds.sort()).toEqual([insertedId, N].sort());
  });

  it("after/before 不是当前真实相邻 next → 409，源文件字节不变", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const refs = await readRefs(handle.url, [R, N, MAIN_B]);
    const before = new Map([
      [R, await nodeFileText(root, DIR, R)],
      [N, await nodeFileText(root, DIR, N)],
      [MAIN_B, await nodeFileText(root, DIR, MAIN_B)],
    ]);

    // R 的真实 next 是 N，不是 MAIN_B。
    const response = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "insert",
      afterRef: refs[R] as string,
      beforeRef: refs[MAIN_B] as string,
      title: "不该插入",
      body: "正文",
      description: "不是相邻 next",
      nextDescription: "不应改写",
    });
    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as { error: { code: string; details?: { conflict?: string } } };
    expect(errorBody.error.code).toBe("OPERATION_CONFLICT");
    expect(errorBody.error.details?.conflict).toBe("insert-not-adjacent");
    for (const id of [R, N, MAIN_B]) {
      expect(await nodeFileText(root, DIR, id)).toBe(before.get(id));
    }
    expect((await fs.readdir(path.join(root, "topics", DIR))).filter((file) => file.endsWith(".md"))).toHaveLength(5);
  });

  it("跨主题 insert 是结构错误 422，不落盘", async () => {
    const root = await newWorkspace();
    const handle = await startService({ root, port: await freePort() });
    running.push(handle);
    const mainRefs = await readRefs(handle.url, [R]);
    const otherResponse = await fetch(
      handle.url + "/api/agent/read?view=content&node=" + OTHER_ROOT + "&budget=100000",
    );
    const otherRead = (await otherResponse.json()) as ReadViewResponse;
    const before = await nodeFileText(root, DIR, R);

    const response = await postAgent(handle.url, handle.workspaceId, randomUUID(), {
      action: "insert",
      afterRef: mainRefs[R] as string,
      beforeRef: otherRead.refs[OTHER_ROOT] as string,
      title: "跨主题插入",
      body: "正文",
      description: "不应跨主题",
      nextDescription: "不应改写",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; details?: { category?: string } } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.category).toBe("structure");
    expect(await nodeFileText(root, DIR, R)).toBe(before);
  });
});
