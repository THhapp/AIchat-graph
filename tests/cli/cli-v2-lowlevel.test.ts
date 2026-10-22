import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Bytes } from "../../src/storage/index.js";
import { startService } from "../../src/service/index.js";
import { main } from "../../src/cli/index.js";
import type { ServiceHandle } from "../../src/service/index.js";

/**
 * 真实服务上的低层 V2 check → apply。
 *
 * 这一条覆盖此前的断点：低层 check／apply 曾用 V1-only schema，V2 的 patchNode／
 * updateConnection 会在进入候选计算前 400。这里用真进程内服务 + 真磁盘文件验证：
 * check 不写盘、apply 落盘且哈希一致、过期的旧哈希返回 412 且不覆盖。
 */

const TOPIC_ID = "t_64e917c597fb4da4abd5467512fab596";
const ROOT_NODE = "n_ac6022c7b25c40c7bd5f849bf6cd36ef";
const CHILD_NODE = "n_0d2f6687895d435f8bd389558b0820f3";
const TOPIC_DIR = "topics/条目整理";
const CHILD_PATH = `${TOPIC_DIR}/${CHILD_NODE}.md`;
const ROOT_PATH = `${TOPIC_DIR}/${ROOT_NODE}.md`;
const TOPIC_META_PATH = `${TOPIC_DIR}/topic.md`;

const CHILD_BODY = "记录既包括讨论过什么，也包括想法怎样走到这里。";

function nodeFile(options: {
  nodeId: string;
  title: string;
  state: string;
  from: string | null;
  flow: string;
  body: string;
  description?: string;
}): string {
  const lines = [
    "---",
    `nodeId: ${options.nodeId}`,
    `title: ${options.title}`,
    `state: ${options.state}`,
    `from: ${options.from ?? "null"}`,
    `flow: ${options.flow}`,
  ];
  if (options.description !== undefined) lines.push(`description: ${options.description}`);
  lines.push("---", "", options.body, "");
  return lines.join("\n");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

let root: string;
let parent: string;
let handle: ServiceHandle;
let workspaceId: string;
let childHash: string;

beforeAll(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-cli-v2-live-"));
  root = path.join(parent, "workspace");
  await fs.mkdir(root);
  workspaceId = "w_v2_low_level";
  const files: Record<string, string> = {
    "workspace.json":
      JSON.stringify(
        { schemaVersion: 2, workspaceId, name: "v2 low level", activeNode: null },
        null,
        2,
      ) + "\n",
    [TOPIC_META_PATH]: ["---", `topicId: ${TOPIC_ID}`, "title: 条目整理", "---", ""].join("\n"),
    [ROOT_PATH]: nodeFile({
      nodeId: ROOT_NODE,
      title: "条目整理",
      state: "agreed",
      from: null,
      flow: "root",
      body: "保留有用的思路来路与关键转折。",
    }),
    [CHILD_PATH]: nodeFile({
      nodeId: CHILD_NODE,
      title: "可以回查的现场",
      state: "proposed",
      from: ROOT_NODE,
      flow: "next",
      body: CHILD_BODY,
      description: "承接记录分寸的讨论",
    }),
  };
  for (const [relativePath, text] of Object.entries(files)) {
    const absolute = path.join(root, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text, "utf8");
  }
  childHash = sha256Bytes(files[CHILD_PATH] as string);
  handle = await startService({ root, port: await freePort() });
});

afterAll(async () => {
  await handle?.stop();
  await fs.rm(parent, { recursive: true, force: true });
});

async function writeRequest(name: string, body: unknown): Promise<string> {
  const file = path.join(parent, name);
  await fs.writeFile(file, JSON.stringify(body, null, 2), "utf8");
  return file;
}

async function diskHash(relativePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(path.join(root, ...relativePath.split("/"))));
}

describe("低层 check／apply 在格式 2 工作区", () => {
  it("V2 patchNode：check 不写盘，apply 落盘，旧哈希再提交返回 412", async () => {
    const appendText = "真实验收补充的一段。";
    const requestId = "11111111-2222-4333-8444-555555555555";
    const request = {
      workspaceId,
      requestId,
      expectedFiles: { [CHILD_PATH]: childHash },
      operations: [{ op: "patchNode", nodeId: CHILD_NODE, append: "\n\n" + appendText }],
    };
    const input = await writeRequest("v2-patch.json", request);

    const check = await main(["check", "--input", input, "--workspace", root]);
    expect(check.exitCode).toBe(0);
    const checkBody = JSON.parse(check.stdout) as Record<string, unknown>;
    expect((checkBody["result"] as Record<string, unknown>)["dryRun"]).toBe(true);
    // check 不改磁盘。
    expect(await diskHash(CHILD_PATH)).toBe(childHash);

    const revisionBefore = (JSON.parse(check.stdout)["result"] as Record<string, unknown>)[
      "revision"
    ];

    const apply = await main(["apply", "--input", input, "--workspace", root]);
    expect(apply.exitCode).toBe(0);
    const applyResult = (JSON.parse(apply.stdout) as Record<string, unknown>)[
      "result"
    ] as Record<string, unknown>;
    expect(applyResult["state"]).toBe("committed");

    const text = await fs.readFile(path.join(root, ...CHILD_PATH.split("/")), "utf8");
    expect(text).toContain(appendText);
    // 追加不是整篇重写：原有正文仍在。
    expect(text).toContain(CHILD_BODY);

    const afterHash = await diskHash(CHILD_PATH);
    expect(afterHash).not.toBe(childHash);
    const touched = (applyResult["touchedFiles"] as Array<Record<string, unknown>>)[0];
    expect(touched?.["path"]).toBe(CHILD_PATH);
    expect(touched?.["beforeSha256"]).toBe(childHash);
    expect(touched?.["afterSha256"]).toBe(afterHash);
    expect(applyResult["revision"]).toBe(
      typeof revisionBefore === "number" ? revisionBefore + 1 : applyResult["revision"],
    );

    // 同一 requestId 重放：不重复写。
    const replay = await main(["apply", "--input", input, "--workspace", root]);
    expect(replay.exitCode).toBe(0);
    expect((JSON.parse(replay.stdout)["result"] as Record<string, unknown>)["replayed"]).toBe(true);
    expect(await diskHash(CHILD_PATH)).toBe(afterHash);

    // 新 requestId + 旧哈希：明确 412，不覆盖。
    const stale = {
      ...request,
      requestId: "99999999-8888-4777-8666-555555555555",
    };
    const staleInput = await writeRequest("v2-stale.json", stale);
    const conflict = await main(["apply", "--input", staleInput, "--workspace", root]);
    expect(conflict.exitCode).toBe(4);
    const error = JSON.parse(conflict.stderr) as Record<string, unknown>;
    expect((error["error"] as Record<string, unknown>)["code"]).toBe("VERSION_CONFLICT");
    expect(error["httpStatus"]).toBe(412);
    expect(await diskHash(CHILD_PATH)).toBe(afterHash);
  });

  it("V2 updateConnection 带 description 时不再被低层 schema 400", async () => {
    const currentHash = await diskHash(CHILD_PATH);
    const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const request = {
      workspaceId,
      requestId,
      expectedFiles: { [CHILD_PATH]: currentHash },
      operations: [
        {
          op: "updateConnection",
          nodeId: CHILD_NODE,
          description: "改写成更准确的来源说明",
        },
      ],
    };
    const input = await writeRequest("v2-conn.json", request);
    const check = await main(["check", "--input", input, "--workspace", root]);
    expect(check.exitCode).toBe(0);

    const apply = await main(["apply", "--input", input, "--workspace", root]);
    expect(apply.exitCode).toBe(0);
    const text = await fs.readFile(path.join(root, ...CHILD_PATH.split("/")), "utf8");
    expect(text).toContain("description: 改写成更准确的来源说明");
    expect(await diskHash(CHILD_PATH)).toBe(
      (JSON.parse(apply.stdout)["result"] as Record<string, unknown> & {
        touchedFiles: Array<Record<string, unknown>>;
      }).touchedFiles[0]?.["afterSha256"],
    );
  });

  it("格式不符或未知操作仍被拒绝（400），不静默放行", async () => {
    const input = await writeRequest("bad-op.json", {
      workspaceId,
      requestId: "cccccccc-dddd-4eee-8fff-000000000000",
      expectedFiles: { [CHILD_PATH]: await diskHash(CHILD_PATH) },
      operations: [{ op: "notARealOperation" }],
    });
    const result = await main(["apply", "--input", input, "--workspace", root]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("INVALID_CHANGE_REQUEST");
  });
});
