/**
 * batch／insert 与统一写结果：
 * - batch 输入层的 bodyFile／appendFile／replaceFile 在 CLI 解析（相对输入文件目录或 stdin cwd），
 *   发往服务的是 body／append／replace，不是本机路径；
 * - dry-run 只返回文件清单；互斥、未知字段、target 用 local 等用法错误不联网；
 * - insert 固定参数构建共享 insert action；
 * - 所有写命令默认顶层精简结果（refs／aliases），--verbose 才输出文件与事务诊断；
 * - resolve 阶段接口缺失／不匹配报 INTERFACE_MISMATCH；whoami 与 read 例外。
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initWorkspace } from "../../src/storage/index.js";
import { main } from "../../src/cli/index.js";
import { INTERFACE_VERSION, loadProgramInfo } from "../../src/build-info.js";
import type { ProgramInfo, ReadViewResponse } from "../../src/shared/protocol.js";
import { changeResponse, workspaceResponse } from "./fixtures.js";

const TOPIC_ID = "t_" + "1".repeat(32);
const NODE_A = "n_" + "a".repeat(32);
const NODE_B = "n_" + "b".repeat(32);
const NEW_NODE = "n_" + "c".repeat(32);
const TOPIC_DIR = "测试主题";
const DESCRIPTOR_URL = "http://127.0.0.1:4400";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function nodeFile(options: {
  nodeId: string;
  title: string;
  from: string | null;
  flow: "root" | "next";
  body: string;
  description?: string;
}): string {
  const lines = [
    "---",
    "nodeId: " + options.nodeId,
    "title: " + options.title,
    "state: agreed",
    "from: " + (options.from ?? "null"),
    "flow: " + options.flow,
  ];
  if (options.description !== undefined) {
    lines.push("description: " + options.description);
  }
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function newWorkspace(): Promise<{ root: string; workspaceId: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-batch-"));
  temporaryRoots.push(parent);
  const created = await initWorkspace({ root: path.join(parent, "workspace"), name: "cli-batch" });
  // initWorkspace 返回规范化真实路径；Windows 8.3 短名会让 descriptor 比对失败。
  const root = created.root;
  const dir = path.join(root, "topics", TOPIC_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "topic.md"),
    "---\ntopicId: " + TOPIC_ID + "\ntitle: 测试主题\n---\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, NODE_A + ".md"),
    nodeFile({ nodeId: NODE_A, title: "甲", from: null, flow: "root", body: "甲正文。" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, NODE_B + ".md"),
    nodeFile({
      nodeId: NODE_B,
      title: "乙",
      from: NODE_A,
      flow: "next",
      body: "乙正文。",
      description: "承接甲的讨论",
    }),
    "utf8",
  );
  await writeDescriptor(root, created.workspaceId);
  return { root, workspaceId: created.workspaceId };
}

async function writeDescriptor(
  root: string,
  workspaceId: string,
  instanceId = "inst-1",
): Promise<void> {
  const file = path.join(root, ".aichat", "runtime", "service.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        url: DESCRIPTOR_URL,
        rootPath: root,
        workspaceId,
        instanceId,
        pid: process.pid,
      },
      null,
      2,
    ),
    "utf8",
  );
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

interface FakeOptions {
  readonly workspaceId: string;
  readonly rootPath: string;
  /** undefined：正常新服务；null 或对象：模拟旧服务／接口不匹配。 */
  readonly program?: Partial<ProgramInfo> | null;
  readonly instanceId?: string;
  readonly changesBody?: (request: Record<string, unknown>) => unknown;
  /** 模拟服务端错误：batch／insert 结构错误 422、占位冲突 409。 */
  readonly changesError?: { status: number; body: unknown };
  readonly readView?: unknown;
}

function dryRunResponse(request: Record<string, unknown>): unknown {
  const action = request["action"] as Record<string, unknown>;
  return {
    ok: true,
    command: "batch",
    dryRun: true,
    state: "checked",
    requestId: request["requestId"],
    workspaceId: request["workspaceId"],
    topicId: action["topicId"],
    summary: "将写入 1 个文件",
    diagnostics: [],
    files: [
      {
        path: "topics/" + TOPIC_DIR + "/" + NODE_A + ".md",
        beforeSha256: "a".repeat(64),
        nextSha256: "b".repeat(64),
        deleted: false,
      },
    ],
  };
}

function fakeService(options: FakeOptions): {
  fetchImpl: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === DESCRIPTOR_URL + "/api/workspace") {
      const workspaceOptions: {
        workspaceId: string;
        rootPath: string;
        instanceId?: string;
        program?: Partial<ProgramInfo> | null;
      } = {
        workspaceId: options.workspaceId,
        rootPath: options.rootPath,
        instanceId: options.instanceId ?? "inst-1",
      };
      if ("program" in options) workspaceOptions.program = options.program ?? null;
      return json(200, workspaceResponse(workspaceOptions));
    }
    if (url.startsWith(DESCRIPTOR_URL + "/api/agent/read")) {
      return json(200, options.readView);
    }
    if (url === DESCRIPTOR_URL + "/api/agent/changes") {
      const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (options.changesError !== undefined) {
        return json(options.changesError.status, options.changesError.body);
      }
      if (options.changesBody !== undefined) return json(200, options.changesBody(request));
      if (request["dryRun"] === true) return json(200, dryRunResponse(request));
      return json(
        200,
        changeResponse({
          workspaceId: options.workspaceId,
          topicId: TOPIC_ID,
          changedNodeIds: [NODE_A],
          refs: { [NODE_A]: "er_new" },
          summary: "1 个操作",
        }),
      );
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no route" } });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function parseBody(recorded: Recorded | undefined): Record<string, unknown> {
  expect(recorded?.body).toBeDefined();
  return JSON.parse(recorded?.body as string) as Record<string, unknown>;
}

function actionOf(recorded: Recorded | undefined): Record<string, unknown> {
  return parseBody(recorded)["action"] as Record<string, unknown>;
}

function postOf(requests: readonly Recorded[]): Recorded | undefined {
  return requests.find((request) => request.url.endsWith("/api/agent/changes"));
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function writeBatchFile(options: {
  ops: unknown[];
  topicId?: string;
}): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-batch-input-"));
  temporaryRoots.push(dir);
  const file = path.join(dir, "batch.json");
  await fs.writeFile(
    file,
    JSON.stringify({ topicId: options.topicId ?? TOPIC_ID, ops: options.ops }, null, 2),
    "utf8",
  );
  return { dir, file };
}

describe("batch 输入层", () => {
  it("--input 相对输入文件目录读取 bodyFile／appendFile／replaceFile，不把路径发给服务", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { dir, file } = await writeBatchFile({
      ops: [
        { op: "edit", target: { ref: "ref-a" }, patch: { bodyFile: "body.md" } },
        { op: "edit", target: { ref: "ref-b" }, patch: { appendFile: "append.md" } },
        { op: "edit", target: { ref: "ref-b" }, patch: { replaceFile: "replace.json" } },
        {
          op: "create",
          as: "新卡",
          from: { ref: "ref-a" },
          flow: "branch",
          title: "新卡",
          description: "旁支说明",
          bodyFile: "body.md",
          side: "left",
          order: 10,
        },
      ],
    });
    await fs.writeFile(path.join(dir, "body.md"), "整篇新正文。\r\n第二行。", "utf8");
    await fs.writeFile(path.join(dir, "append.md"), "追加片段。", "utf8");
    await fs.writeFile(
      path.join(dir, "replace.json"),
      JSON.stringify([{ old: "旧内容", new: "新内容" }]),
      "utf8",
    );
    const fake = fakeService({ workspaceId, rootPath: root });
    const result = await main(["batch", "--input", file, "--workspace", root], {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode, result.stderr).toBe(0);

    const post = postOf(fake.requests);
    const rawBody = post?.body as string;
    // 服务端不接收任何文件字段与路径。
    expect(rawBody).not.toContain("body.md");
    expect(rawBody).not.toContain("append.md");
    expect(rawBody).not.toContain("replace.json");
    expect(rawBody).not.toContain("bodyFile");
    expect(rawBody).not.toContain("appendFile");
    expect(rawBody).not.toContain("replaceFile");

    const action = actionOf(post);
    expect(action["action"]).toBe("batch");
    expect(action["topicId"]).toBe(TOPIC_ID);
    const ops = action["ops"] as Array<Record<string, unknown>>;
    expect(ops).toHaveLength(4);
    // CRLF 统一成 LF；整篇/追加/替换分别落到共享字段。
    expect((ops[0]?.["patch"] as Record<string, unknown>)["body"]).toBe(
      "整篇新正文。\n第二行。",
    );
    expect((ops[1]?.["patch"] as Record<string, unknown>)["append"]).toBe("追加片段。");
    expect((ops[2]?.["patch"] as Record<string, unknown>)["replace"]).toEqual([
      { old: "旧内容", new: "新内容" },
    ]);
    expect(ops[3]?.["body"]).toBe("整篇新正文。\n第二行。");
    expect(ops[3]?.["as"]).toBe("新卡");
    expect(ops[3]?.["from"]).toEqual({ ref: "ref-a" });

    const output = jsonOf(result.stdout);
    expect(output["ok"]).toBe(true);
    expect(output["command"]).toBe("batch");
    expect(output["refs"]).toEqual({ [NODE_A]: "er_new" });
    expect(output["result"]).toBeUndefined();
  });

  it("--input-stdin 的相对路径以调用 cwd 为基准，且与 --input 互斥", async () => {
    const { root, workspaceId } = await newWorkspace();
    const inputDir = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-batch-stdin-"));
    temporaryRoots.push(inputDir);
    await fs.writeFile(path.join(inputDir, "stdin-body.md"), "stdin 基准正文。", "utf8");
    const batchJson = JSON.stringify({
      topicId: TOPIC_ID,
      ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { bodyFile: "stdin-body.md" } }],
    });
    const fake = fakeService({ workspaceId, rootPath: root });
    const result = await main(["batch", "--input-stdin", "--workspace", root], {
      cwd: inputDir,
      stdin: async () => batchJson,
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const ops = actionOf(postOf(fake.requests))["ops"] as Array<Record<string, unknown>>;
    expect((ops[0]?.["patch"] as Record<string, unknown>)["body"]).toBe("stdin 基准正文。");

    const both = await main(
      ["batch", "--input", path.join(inputDir, "batch.json"), "--input-stdin", "--workspace", root],
      { cwd: inputDir, stdin: async () => batchJson, fetchImpl: fake.fetchImpl },
    );
    expect(both.exitCode).toBe(2);
    expect(JSON.parse(both.stderr).error.message).toContain("互斥");

    const neither = await main(["batch", "--workspace", root], { cwd: inputDir });
    expect(neither.exitCode).toBe(2);
    expect(JSON.parse(neither.stderr).error.message).toContain("--input");
  });

  it("正文来源互斥、target 不允许 local、create 缺正文等输入错误整体拒绝且不联网", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({ workspaceId, rootPath: root });
    const cases: Array<{ label: string; ops: unknown[]; message: string }> = [
      {
        label: "body 与 bodyFile 同时给出",
        ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { body: "x", bodyFile: "b.md" } }],
        message: "互斥",
      },
      {
        label: "edit target 用 local",
        ops: [{ op: "edit", target: { local: "新卡" }, patch: { body: "x" } }],
        message: "target",
      },
      {
        label: "create 同时给 body 与 bodyFile",
        ops: [
          {
            op: "create",
            as: "新卡",
            from: { ref: "ref-a" },
            flow: "branch",
            title: "新卡",
            description: "说明",
            body: "x",
            bodyFile: "b.md",
          },
        ],
        message: "互斥",
      },
      {
        label: "create 缺正文",
        ops: [
          {
            op: "create",
            as: "新卡",
            from: { ref: "ref-a" },
            flow: "branch",
            title: "新卡",
            description: "说明",
          },
        ],
        message: "body",
      },
      {
        label: "未知 op",
        ops: [{ op: "remove", target: { ref: "ref-a" } }],
        message: "op",
      },
      {
        label: "edit.patch 未知字段",
        ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { unknownField: 1 } }],
        message: "未知字段",
      },
    ];
    for (const entry of cases) {
      const { file } = await writeBatchFile({ ops: entry.ops });
      const result = await main(["batch", "--input", file, "--workspace", root], {
        fetchImpl: fake.fetchImpl,
      });
      expect(result.exitCode, entry.label).toBe(2);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr) as { error: { code: string; message: string } };
      expect(error.error.code, entry.label).toBe("INVALID_BATCH_INPUT");
      expect(error.error.message, entry.label).toContain(entry.message);
    }
    expect(postOf(fake.requests)).toBeUndefined();
  });

  it("已知字段误放给 field／hint／help，不静默改写也不联网", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({ workspaceId, rootPath: root });
    const cases: Array<{
      label: string;
      ops: unknown[];
      field: string;
      hintIncludes: string;
    }> = [
      {
        label: "edit.patch 放 important",
        ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { important: true } }],
        field: "ops[0].patch.important",
        hintIncludes: "op=important",
      },
      {
        label: "edit.patch 放 description",
        ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { description: "说明" } }],
        field: "ops[0].patch.description",
        hintIncludes: "op=connect",
      },
      {
        label: "edit.patch 放 fromRef",
        ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { fromRef: "ref-b" } }],
        field: "ops[0].patch.fromRef",
        hintIncludes: "op=connect",
      },
      {
        label: "edit.patch 放 flow",
        ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { flow: "branch" } }],
        field: "ops[0].patch.flow",
        hintIncludes: "op=connect",
      },
      {
        label: "edit op 顶层放入边字段",
        ops: [
          {
            op: "edit",
            target: { ref: "ref-a" },
            patch: { title: "新标题" },
            description: "说明",
          },
        ],
        field: "ops[0].description",
        hintIncludes: "op=connect",
      },
      {
        label: "connect 放 patch",
        ops: [
          {
            op: "connect",
            target: { ref: "ref-a" },
            description: "说明",
            patch: { title: "x" },
          },
        ],
        field: "ops[0].patch",
        hintIncludes: "op=edit",
      },
    ];
    for (const entry of cases) {
      const { file } = await writeBatchFile({ ops: entry.ops });
      const result = await main(["batch", "--input", file, "--workspace", root], {
        fetchImpl: fake.fetchImpl,
      });
      expect(result.exitCode, entry.label).toBe(2);
      expect(result.stdout, entry.label).toBe("");
      const payload = JSON.parse(result.stderr) as {
        error: { code: string; message: string; details: Record<string, unknown> };
      };
      expect(payload.error.code, entry.label).toBe("INVALID_BATCH_INPUT");
      expect(payload.error.message, entry.label).toContain(entry.field);
      expect(payload.error.details["field"], entry.label).toBe(entry.field);
      expect(String(payload.error.details["hint"]), entry.label).toContain(entry.hintIncludes);
      expect(payload.error.details["help"], entry.label).toBe(
        "aichat help batch --op edit --json",
      );
    }
    expect(postOf(fake.requests)).toBeUndefined();
  });

  it("--dry-run 发送 dryRun=true，输出只含检查结果（无 created／refs）", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { file } = await writeBatchFile({
      ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { body: "新的正文。" } }],
    });
    const fake = fakeService({ workspaceId, rootPath: root });
    const result = await main(
      ["batch", "--input", file, "--dry-run", "--workspace", root],
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const sent = parseBody(postOf(fake.requests));
    expect(sent["dryRun"]).toBe(true);
    expect(sent["workspaceId"]).toBe(workspaceId);
    expect(sent["requestId"]).toMatch(/^[0-9a-f-]{36}$/);

    const output = jsonOf(result.stdout);
    expect(output).toMatchObject({
      ok: true,
      command: "batch",
      dryRun: true,
      state: "checked",
    });
    expect(output["created"]).toBeUndefined();
    expect(output["refs"]).toBeUndefined();
    expect(output["files"]).toEqual([
      {
        path: "topics/" + TOPIC_DIR + "/" + NODE_A + ".md",
        beforeSha256: "a".repeat(64),
        nextSha256: "b".repeat(64),
        deleted: false,
      },
    ]);
    expect(typeof output["requestId"]).toBe("string");
    expect(output["topicId"]).toBe(TOPIC_ID);
    expect(output["summary"]).toContain("写入");
  });

  it("服务端 409／422 按统一分类映射：占位冲突退出码 5，结构错误退出码 6", async () => {
    const { root, workspaceId } = await newWorkspace();
    const { file } = await writeBatchFile({
      ops: [{ op: "edit", target: { ref: "ref-a" }, patch: { body: "新的正文。" } }],
    });

    const conflict = fakeService({
      workspaceId,
      rootPath: root,
      changesError: {
        status: 409,
        body: { error: { code: "OPERATION_CONFLICT", message: "next 槽位仍被原后继占用" } },
      },
    });
    const conflictResult = await main(["batch", "--input", file, "--workspace", root], {
      fetchImpl: conflict.fetchImpl,
    });
    expect(conflictResult.exitCode).toBe(5);
    expect((JSON.parse(conflictResult.stderr) as { error: { code: string } }).error.code).toBe(
      "OPERATION_CONFLICT",
    );

    const invalid = fakeService({
      workspaceId,
      rootPath: root,
      changesError: {
        status: 422,
        body: { error: { code: "VALIDATION_FAILED", message: "最终重复 next" } },
      },
    });
    const invalidResult = await main(["batch", "--input", file, "--workspace", root], {
      fetchImpl: invalid.fetchImpl,
    });
    expect(invalidResult.exitCode).toBe(6);
    expect((JSON.parse(invalidResult.stderr) as { error: { code: string } }).error.code).toBe(
      "VALIDATION_FAILED",
    );
  });
});

describe("统一写结果与 insert", () => {
  it("默认只给顶层精简结果；--verbose 才输出 touchedFiles／paths／事务与服务", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({
      workspaceId,
      rootPath: root,
      changesBody: () =>
        changeResponse({
          workspaceId,
          topicId: TOPIC_ID,
          changedNodeIds: [NODE_A, NODE_B],
          created: {
            nodeIds: [NEW_NODE],
            aliases: { 新卡: NEW_NODE },
            paths: ["topics/" + TOPIC_DIR + "/" + NEW_NODE + ".md"],
            topicPath: "topics/" + TOPIC_DIR + "/topic.md",
          },
          refs: { [NODE_A]: "er_a", [NEW_NODE]: "er_new" },
          touchedFiles: [
            {
              path: "topics/" + TOPIC_DIR + "/" + NEW_NODE + ".md",
              beforeSha256: null,
              afterSha256: "c".repeat(64),
              byteLength: 100,
            },
          ],
          summary: "2 个操作（edit／create）",
        }),
    });
    const { file } = await writeBatchFile({
      ops: [{ op: "important", target: { ref: "ref-a" }, important: true }],
    });

    const compact = await main(["batch", "--input", file, "--workspace", root], {
      fetchImpl: fake.fetchImpl,
    });
    expect(compact.exitCode, compact.stderr).toBe(0);
    const body = jsonOf(compact.stdout);
    expect(body["ok"]).toBe(true);
    expect(body["workspaceId"]).toBe(workspaceId);
    expect(body["topicId"]).toBe(TOPIC_ID);
    expect(body["state"]).toBe("committed");
    expect(body["changedNodeIds"]).toEqual([NODE_A, NODE_B]);
    expect(body["created"]).toEqual({
      topicId: null,
      nodeIds: [NEW_NODE],
      aliases: { 新卡: NEW_NODE },
    });
    expect(body["refs"]).toEqual({ [NODE_A]: "er_a", [NEW_NODE]: "er_new" });
    expect(body["result"]).toBeUndefined();
    expect(body["touchedFiles"]).toBeUndefined();
    expect(body["service"]).toBeUndefined();
    expect(body["httpStatus"]).toBeUndefined();
    expect(body["transactionId"]).toBeUndefined();

    const verbose = await main(
      ["batch", "--input", file, "--workspace", root, "--verbose"],
      { fetchImpl: fake.fetchImpl },
    );
    expect(verbose.exitCode, verbose.stderr).toBe(0);
    const detail = jsonOf(verbose.stdout);
    expect(detail["httpStatus"]).toBe(200);
    expect(detail["service"]).toMatchObject({ url: DESCRIPTOR_URL + "/" });
    expect(detail["transactionId"]).toBe("tx-1");
    expect(detail["journalCleaned"]).toBe(true);
    expect(detail["touchedFiles"]).toHaveLength(1);
    expect((detail["created"] as Record<string, unknown>)["paths"]).toEqual([
      "topics/" + TOPIC_DIR + "/" + NEW_NODE + ".md",
    ]);
    expect((detail["created"] as Record<string, unknown>)["topicPath"]).toBe(
      "topics/" + TOPIC_DIR + "/topic.md",
    );
  });

  it("insert 固定参数构建共享 insert action；缺参数或正文不联网", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({
      workspaceId,
      rootPath: root,
      changesBody: () =>
        changeResponse({
          workspaceId,
          topicId: TOPIC_ID,
          action: "insert",
          changedNodeIds: [NEW_NODE, NODE_B],
          created: { nodeIds: [NEW_NODE], aliases: {} },
          refs: { [NEW_NODE]: "er_new", [NODE_B]: "er_b" },
        }),
    });
    const bodyFile = path.join(root, "insert-body.md");
    await fs.writeFile(bodyFile, "插入卡正文。", "utf8");
    const result = await main(
      [
        "insert",
        "--after-ref",
        "ref-a",
        "--before-ref",
        "ref-b",
        "--title",
        "补一问",
        "--description",
        "先追问这一点",
        "--next-description",
        "再回到原问题",
        "--body-file",
        bodyFile,
        "--state",
        "proposed",
        "--summary",
        "补一问摘要",
        "--workspace",
        root,
      ],
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const action = actionOf(postOf(fake.requests));
    expect(action).toEqual({
      action: "insert",
      afterRef: "ref-a",
      beforeRef: "ref-b",
      title: "补一问",
      body: "插入卡正文。",
      description: "先追问这一点",
      nextDescription: "再回到原问题",
      state: "proposed",
      summary: "补一问摘要",
    });
    const output = jsonOf(result.stdout);
    expect(output["command"]).toBe("insert");
    expect(output["refs"]).toEqual({ [NEW_NODE]: "er_new", [NODE_B]: "er_b" });

    const requestsBefore = fake.requests.length;
    const missingBefore = await main(
      [
        "insert",
        "--after-ref",
        "ref-a",
        "--title",
        "缺 before",
        "--description",
        "d",
        "--next-description",
        "n",
        "--body",
        "正文",
        "--workspace",
        root,
      ],
      { fetchImpl: fake.fetchImpl },
    );
    expect(missingBefore.exitCode).toBe(2);
    expect(JSON.parse(missingBefore.stderr).error.message).toContain("--before-ref");

    const missingBody = await main(
      [
        "insert",
        "--after-ref",
        "ref-a",
        "--before-ref",
        "ref-b",
        "--title",
        "缺正文",
        "--description",
        "d",
        "--next-description",
        "n",
        "--workspace",
        root,
      ],
      { fetchImpl: fake.fetchImpl },
    );
    expect(missingBody.exitCode).toBe(2);
    expect(JSON.parse(missingBody.stderr).error.message).toContain("正文");
    expect(fake.requests.length).toBe(requestsBefore);
  });

  it("创建入口的 --summary 落到 create action", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({ workspaceId, rootPath: root });
    const branch = await main(
      [
        "branch",
        "--from-ref",
        "ref-a",
        "--title",
        "旁支",
        "--description",
        "说明",
        "--summary",
        "旁支摘要",
        "--body",
        "旁支正文",
        "--workspace",
        root,
      ],
      { fetchImpl: fake.fetchImpl },
    );
    expect(branch.exitCode, branch.stderr).toBe(0);
    expect(actionOf(postOf(fake.requests))["summary"]).toBe("旁支摘要");

    const createRoot = await main(
      [
        "create-root",
        "--topic-title",
        "测试主题",
        "--title",
        "新起点",
        "--summary",
        "起点摘要",
        "--body",
        "起点正文",
        "--workspace",
        root,
      ],
      { fetchImpl: fake.fetchImpl },
    );
    expect(createRoot.exitCode, createRoot.stderr).toBe(0);
    const rootActions = fake.requests.filter((request) =>
      request.url.endsWith("/api/agent/changes"),
    );
    expect(actionOf(rootActions[rootActions.length - 1])["summary"]).toBe("起点摘要");
  });
});

describe("接口版本与 whoami", () => {
  it("写命令在 resolve 阶段对旧服务／接口不匹配报 INTERFACE_MISMATCH 且不提交", async () => {
    const { root, workspaceId } = await newWorkspace();
    for (const [label, program] of [
      ["缺失", null],
      ["不匹配", { interfaceVersion: 1 }],
    ] as const) {
      const fake = fakeService({ workspaceId, rootPath: root, program });
      const result = await main(
        ["edit", "--ref", "ref-a", "--title", "新标题", "--workspace", root],
        { fetchImpl: fake.fetchImpl },
      );
      expect(result.exitCode, label).toBe(7);
      const error = JSON.parse(result.stderr) as {
        error: { code: string; details: Record<string, unknown> };
      };
      expect(error.error.code, label).toBe("INTERFACE_MISMATCH");
      expect(error.error.details["expectedInterfaceVersion"]).toBe(INTERFACE_VERSION);
      expect(error.error.details["reason"]).toBe(program === null ? "missing" : "mismatch");
      expect(postOf(fake.requests), label).toBeUndefined();
    }
  });

  it("read 遇接口不匹配可回退磁盘并在 online.reason 说明原因", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({ workspaceId, rootPath: root, program: null });
    const result = await main(["read", "--node", NODE_A, "--workspace", root], {
      fetchImpl: fake.fetchImpl,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const body = jsonOf(result.stdout);
    expect(body["source"]).toBe("disk");
    expect(body["online"]).toEqual({
      available: false,
      code: "INTERFACE_MISMATCH",
      reason: expect.stringContaining("接口"),
    });
    expect(body["refs"]).toEqual({});
  });

  it("whoami 在接口缺失／不匹配时仍完成诊断并保留旧字段", async () => {
    const { root, workspaceId } = await newWorkspace();
    const oldService = fakeService({ workspaceId, rootPath: root, program: null });
    const oldResult = await main(["whoami", "--workspace", root], {
      fetchImpl: oldService.fetchImpl,
    });
    expect(oldResult.exitCode, oldResult.stderr).toBe(0);
    const oldBody = jsonOf(oldResult.stdout);
    expect(oldBody["ok"]).toBe(true);
    expect(oldBody["command"]).toBe("whoami");
    // 既有脚本读取的旧字段保持不变。
    expect(oldBody["url"]).toBe(DESCRIPTOR_URL + "/");
    expect((oldBody["identity"] as Record<string, unknown>)["workspaceId"]).toBe(workspaceId);
    expect((oldBody["identity"] as Record<string, unknown>)["instanceId"]).toBe("inst-1");
    expect(oldBody["diskWorkspaceId"]).toBe(workspaceId);
    expect(oldBody["service"]).toBeNull();
    expect(oldBody["interface"]).toEqual({
      expected: INTERFACE_VERSION,
      actual: null,
      compatible: false,
    });
    expect(oldBody["build"]).toEqual({ same: false, cli: loadProgramInfo().buildId, service: null });
    expect((oldBody["cli"] as Record<string, unknown>)["program"]).toBe("aichat-graph");

    const mismatched = fakeService({
      workspaceId,
      rootPath: root,
      program: { interfaceVersion: 1 },
    });
    const mismatchedResult = await main(["whoami", "--workspace", root], {
      fetchImpl: mismatched.fetchImpl,
    });
    expect(mismatchedResult.exitCode).toBe(0);
    expect(jsonOf(mismatchedResult.stdout)["interface"]).toEqual({
      expected: INTERFACE_VERSION,
      actual: 1,
      compatible: false,
    });

    // 同构建时 build.same=true。
    const matching = fakeService({
      workspaceId,
      rootPath: root,
      program: { buildId: loadProgramInfo().buildId },
    });
    const matchingResult = await main(["whoami", "--workspace", root], {
      fetchImpl: matching.fetchImpl,
    });
    expect(matchingResult.exitCode).toBe(0);
    const matchingBody = jsonOf(matchingResult.stdout);
    expect((matchingBody["interface"] as Record<string, unknown>)["compatible"]).toBe(true);
    expect((matchingBody["build"] as Record<string, unknown>)["same"]).toBe(true);
  });
});

function readViewFixture(workspaceId: string, rootPath: string): ReadViewResponse {
  const item = {
    node: {
      id: NODE_A,
      topicId: TOPIC_ID,
      title: "甲",
      summary: "甲",
      number: "01",
      from: null,
      flow: "root" as const,
      state: "agreed" as const,
      important: false,
      sourcePath: "topics/" + TOPIC_DIR + "/" + NODE_A + ".md",
    },
    body: "甲正文。",
    range: { start: 0, end: 4, total: 4, unit: "utf16" as const },
    truncated: false,
    path: "topics/" + TOPIC_DIR + "/" + NODE_A + ".md",
    fileHash: "d".repeat(64),
  };
  return {
    ok: true,
    command: "read",
    source: "online",
    root: rootPath,
    online: { available: true, instanceId: "inst-1", revision: 1, workspaceId },
    workspaceId,
    view: "content",
    topicId: TOPIC_ID,
    topicTitle: "测试主题",
    scope: { kind: "nodes", nodeCount: 1 },
    items: [item],
    refs: { [NODE_A]: "er_read" },
    page: { hasMore: false },
    budget: { unit: "utf16", limit: 12000, used: 0, mode: "explicit" },
    fingerprint: "fixture-fingerprint",
  };
}

describe("read 参数映射", () => {
  it("--from-heading／--occurrence 映射为服务 section／section-index", async () => {
    const { root, workspaceId } = await newWorkspace();
    const fake = fakeService({
      workspaceId,
      rootPath: root,
      readView: readViewFixture(workspaceId, root),
    });
    const result = await main(
      [
        "read",
        "--node",
        NODE_A,
        "--from-heading",
        "第二节",
        "--occurrence",
        "1",
        "--length",
        "20",
        "--workspace",
        root,
      ],
      { fetchImpl: fake.fetchImpl },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const readCall = fake.requests.find((request) => request.url.includes("/api/agent/read"));
    expect(readCall).toBeDefined();
    const url = new URL(readCall?.url as string);
    expect(url.searchParams.get("section")).toBe("第二节");
    expect(url.searchParams.get("section-index")).toBe("1");
    expect(url.searchParams.get("length")).toBe("20");
    const output = jsonOf(result.stdout);
    // JSON 读取仍是紧凑 ReadViewResponse，顶层 refs。
    expect(output["refs"]).toEqual({ [NODE_A]: "er_read" });
    expect((output["items"] as Array<Record<string, unknown>>)[0]?.["editRef"]).toBeUndefined();
  });
});
