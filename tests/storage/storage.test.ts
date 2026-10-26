import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitFiles,
  completeTransaction,
  initWorkspace,
  normalizeRelativePath,
  getTransaction,
  listTransactions,
  readWorkspaceFiles,
  recoverTransactions,
  sha256Bytes,
  StorageError,
  TRANSACTIONS_DIR,
  type AtomicWriter,
} from "../../src/storage/index.js";

const temporaryRoots: string[] = [];

async function newParent(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-storage-"));
  temporaryRoots.push(parent);
  return parent;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function newWorkspace(): Promise<string> {
  const parent = await newParent();
  const root = path.join(parent, "workspace");
  await initWorkspace({ root, name: "storage-test" });
  return root;
}

async function readText(root: string, relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, ...relativePath.split("/")), "utf8");
}

function sha(text: string): string {
  return sha256Bytes(text);
}

/** 提交后模拟 service 完成快照刷新，清理 committed 日志。 */
async function finalizeCommitted(root: string): Promise<void> {
  const recovered = await recoverTransactions({ root });
  for (const transactionId of recovered.committedPendingRefresh) {
    await completeTransaction(root, transactionId);
  }
}

async function commitAndFinalize(
  root: string,
  files: Parameters<typeof commitFiles>[0]["files"],
): Promise<void> {
  await commitFiles({ root, files });
  await finalizeCommitted(root);
}

async function writePreparedJournal(
  root: string,
  transactionId: string,
  options: {
    target: string;
    before: string | null;
    after: string;
    diskContent: string;
  },
): Promise<string> {
  const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
  await fs.mkdir(path.join(transactionDir, "before"), { recursive: true });
  await fs.mkdir(path.join(transactionDir, "after"), { recursive: true });
  const beforePath = path.join(transactionDir, "before", ...options.target.split("/"));
  const afterPath = path.join(transactionDir, "after", ...options.target.split("/"));
  await fs.mkdir(path.dirname(beforePath), { recursive: true });
  await fs.mkdir(path.dirname(afterPath), { recursive: true });
  if (options.before !== null) {
    await fs.writeFile(beforePath, options.before, "utf8");
  }
  await fs.writeFile(afterPath, options.after, "utf8");
  await fs.writeFile(
    path.join(transactionDir, "journal.json"),
    JSON.stringify({
      schemaVersion: 1,
      transactionId,
      state: "prepared",
      createdAt: new Date().toISOString(),
      files: [
        {
          path: options.target,
          existedBefore: options.before !== null,
          beforeSha256: options.before === null ? null : sha(options.before),
          beforeBytes: options.before === null ? 0 : Buffer.byteLength(options.before),
          afterSha256: sha(options.after),
          afterBytes: Buffer.byteLength(options.after),
        },
      ],
    }),
    "utf8",
  );
  const targetPath = path.join(root, ...options.target.split("/"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, options.diskContent, "utf8");
  return transactionDir;
}

describe("路径约束", () => {
  it("拒绝越界与不安全路径", () => {
    expect(() => normalizeRelativePath("../outside.md")).toThrow(StorageError);
    expect(() => normalizeRelativePath("topics/../../outside.md")).toThrow(StorageError);
    expect(() => normalizeRelativePath("C:/temp/x.md")).toThrow(StorageError);
    expect(() => normalizeRelativePath("/abs.md")).toThrow(StorageError);
    expect(() => normalizeRelativePath("topics//x.md")).toThrow(StorageError);
    expect(() => normalizeRelativePath("topics/主题/CON.md")).toThrow(StorageError);
    expect(normalizeRelativePath("topics/子目录/记录.md")).toBe("topics/子目录/记录.md");
  });

  it("拒绝写入 .aichat 与 topics 之外的路径", async () => {
    const root = await newWorkspace();
    await expect(
      commitFiles({
        root,
        files: [{ path: ".aichat/runtime/x.md", content: "x", expectedSha256: null }],
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    await expect(
      commitFiles({
        root,
        files: [{ path: "AGENTS.md", content: "x", expectedSha256: null }],
      }),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("拒绝 topics 中的符号链接目录", async () => {
    const root = await newWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-outside-"));
    temporaryRoots.push(outside);
    await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    try {
      await fs.symlink(outside, path.join(root, "topics", "link"), "junction");
    } catch {
      return; // 无符号链接权限的环境跳过
    }
    const snapshot = await readWorkspaceFiles(root);
    expect(snapshot.topics).toHaveLength(0);
    expect(snapshot.diagnostics.some((item) => item.code === "PATH_SYMLINK_SKIPPED")).toBe(true);
    await expect(
      commitFiles({
        root,
        files: [{ path: "topics/link/new.md", content: "x", expectedSha256: null }],
      }),
    ).rejects.toBeTruthy();
  });
});

describe("初始化与读取", () => {
  it("生成完整骨架并拒绝重复初始化", async () => {
    const root = await newWorkspace();
    const entries = (await fs.readdir(root)).sort();
    expect(entries).toEqual([".aichat", ".gitignore", "AGENTS.md", "topics", "workspace.json"]);
    const agents = await readText(root, "AGENTS.md");
    // 指南只保留工作区接入边界，指向当前高层命令，不复制 Skill 或完整 schema。
    expect(agents).toContain("aichat batch");
    expect(agents).toContain("一个节点一份 Markdown");
    expect(agents).toContain("description");
    expect(agents).toContain("refs[nodeId]");
    expect(agents).not.toContain("<!-- node:");
    expect(agents).toContain(".aichat/");
    // 检查必要小节与真实命令，不绑定整体行数。
    expect(agents).toContain("## 主题绑定");
    expect(agents).toContain("## 维护方式");
    expect(agents).toContain("## 命令");
    expect(agents).toContain("aichat create-topic");
    const snapshot = await readWorkspaceFiles(root);
    expect(snapshot.topics).toHaveLength(0);
    expect(snapshot.workspace.activeNode).toBeNull();
    expect(snapshot.workspaceFile.sha256).toBe(sha(snapshot.workspaceFile.text));
    await expect(initWorkspace({ root })).rejects.toMatchObject({ code: "WORKSPACE_EXISTS" });
    expect(await fs.readdir(root)).not.toContain(".git");
  });

  it("读取主题文件原文、原始字节哈希与 CRLF 信息", async () => {
    const root = await newWorkspace();
    const content = "---\r\nnodeId: n_00000000000000000000000000000001\r\ntitle: 标题\r\nstate: proposed\r\nfrom: null\r\nflow: root\r\n---\r\n\r\n正文\r\n";
    await commitAndFinalize(root, [{ path: "topics/主题/crlf.md", content, expectedSha256: null }]);
    const snapshot = await readWorkspaceFiles(root);
    const file = snapshot.topics[0];
    expect(file?.text).toBe(content);
    expect(file?.sha256).toBe(sha(content));
    expect(file?.lineEnding).toBe("\r\n");
    expect(file?.sha256).not.toBe(sha(content.replace(/\r\n/g, "\n")));
  });
});

describe("提交与冲突", () => {
  it("过期 hash 拒绝写入，新文件冲突拒绝覆盖", async () => {
    const root = await newWorkspace();
    const topicPath = "topics/主题/topic.md";
    const content = "---\nnodeId: n_00000000000000000000000000000001\ntitle: T\nstate: proposed\nfrom: null\nflow: root\n---\n\nB\n";
    await commitAndFinalize(root, [{ path: topicPath, content, expectedSha256: null }]);

    await expect(
      commitFiles({
        root,
        files: [{ path: topicPath, content: content + "x", expectedSha256: sha("stale") }],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readText(root, topicPath)).toBe(content);

    await expect(
      commitFiles({
        root,
        files: [{ path: topicPath, content: "overwrite", expectedSha256: null }],
      }),
    ).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(await readText(root, topicPath)).toBe(content);
  });

  it("replace 提交不残留临时文件且内容完整", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/atomic.md";
    await commitAndFinalize(root, [{ path: target, content: "第一版\n", expectedSha256: null }]);
    const result = await commitFiles({
      root,
      files: [{ path: target, content: "第二版\n", expectedSha256: sha("第一版\n") }],
    });
    await completeTransaction(root, result.transactionId);
    expect(await readText(root, target)).toBe("第二版\n");
    const entries = await fs.readdir(path.join(root, "topics"));
    expect(entries.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
    expect(entries).toEqual(["主题"]);
  });

  it("跨文件中途失败时回滚已写文件并清理日志", async () => {
    const root = await newWorkspace();
    const first = "topics/主题/a.md";
    const second = "topics/主题/b.md";
    const firstBefore = "a\n";
    const secondBefore = "b\n";
    await commitAndFinalize(root, [{ path: first, content: firstBefore, expectedSha256: null }]);
    await commitAndFinalize(root, [{ path: second, content: secondBefore, expectedSha256: null }]);

    let writes = 0;
    const failingWriter: AtomicWriter = async (absolutePath, data, mode) => {
      writes += 1;
      if (writes === 2) throw new Error("simulated disk failure");
      const { defaultAtomicWriter } = await import("../../src/storage/atomic.js");
      await defaultAtomicWriter(absolutePath, data, mode);
    };

    await expect(
      commitFiles({
        root,
        writer: failingWriter,
        files: [
          { path: first, content: "a2\n", expectedSha256: sha(firstBefore) },
          { path: second, content: "b2\n", expectedSha256: sha(secondBefore) },
        ],
      }),
    ).rejects.toThrow();

    expect(await readText(root, first)).toBe(firstBefore);
    expect(await readText(root, second)).toBe(secondBefore);
    expect(await fs.readdir(path.join(root, ...TRANSACTIONS_DIR.split("/")))).toHaveLength(0);
  });

  it("提交成功后保留 committed 日志，刷新后才清理", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/committed.md";
    const result = await commitFiles({
      root,
      files: [{ path: target, content: "committed\n", expectedSha256: null }],
    });
    expect(result.committed).toBe(true);
    expect(result.journalCleaned).toBe(false);

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(true);
    expect(recovered.committedPendingRefresh).toContain(result.transactionId);
    expect(recovered.reports[0]?.action).toBe("kept-committed");
    expect(await readText(root, target)).toBe("committed\n");

    await completeTransaction(root, result.transactionId);
    expect((await recoverTransactions({ root })).reports).toHaveLength(0);
    expect(await readText(root, target)).toBe("committed\n");
  });
});

describe("事务恢复", () => {
  it("无关外部字节阻止恢复，保留日志且不覆盖", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/conflict.md";
    const transactionDir = await writePreparedJournal(root, "20260101T000000Z-conflict", {
      target,
      before: "original\n",
      after: "after\n",
      diskContent: "external\n",
    });

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("conflict");
    expect(await readText(root, target)).toBe("external\n");
    expect(await fs.stat(transactionDir)).toBeTruthy();
    await expect(
      commitFiles({
        root,
        files: [{ path: target, content: "new\n", expectedSha256: sha("external\n") }],
      }),
    ).rejects.toMatchObject({ code: "PENDING_TRANSACTION" });
  });

  it("prepared 事务在 after 状态按 before 回滚", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/rollback.md";
    await commitAndFinalize(root, [
      { path: target, content: "original\n", expectedSha256: null },
    ]);
    await writePreparedJournal(root, "20260101T000001Z-rollback", {
      target,
      before: "original\n",
      after: "after\n",
      diskContent: "after\n",
    });

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(true);
    expect(recovered.reports[0]?.action).toBe("rolled-back");
    expect(await readText(root, target)).toBe("original\n");
  });

  it("recovered prepared 事务中新建文件被外部创建时保留日志", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/newfile.md";
    await writePreparedJournal(root, "20260101T000002Z-newfile", {
      target,
      before: null,
      after: "ours\n",
      diskContent: "someone-else\n",
    });
    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(await readText(root, target)).toBe("someone-else\n");
  });

  it("显式删除空主题文件：写入前核 hash、写后核不存在、恢复需 before 回滚", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/empty.md";
    await commitAndFinalize(root, [{ path: target, content: "内容\n", expectedSha256: null }]);
    const currentHash = sha("内容\n");

    await expect(
      commitFiles({
        root,
        files: [{ path: target, content: null, expectedSha256: sha("过期\n") }],
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(await readText(root, target)).toBe("内容\n");

    const result = await commitFiles({
      root,
      files: [{ path: target, content: null, expectedSha256: currentHash }],
    });
    expect(result.touchedFiles[0]?.afterSha256).toBeNull();
    expect(await fs.stat(path.join(root, ...target.split("/"))).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(root, "topics"))).toBeTruthy();

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(true);
    expect(recovered.reports[0]?.action).toBe("kept-committed");
    await completeTransaction(root, result.transactionId);
  });

  it("删除时要求前置 hash，且拒绝删除不存在文件", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/never.md";
    await expect(
      commitFiles({ root, files: [{ path: target, content: null, expectedSha256: null }] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      commitFiles({ root, files: [{ path: target, content: null, expectedSha256: sha("x") }] }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("prepared 删除完成后按 before 恢复内容", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/deleted.md";
    await commitAndFinalize(root, [{ path: target, content: "before\n", expectedSha256: null }]);
    const transactionId = "20260101T000004Z-delete";
    const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
    const beforeFile = path.join(transactionDir, "before", ...target.split("/"));
    await fs.mkdir(path.dirname(beforeFile), { recursive: true });
    await fs.writeFile(beforeFile, "before\n", "utf8");
    await fs.writeFile(
      path.join(transactionDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "prepared",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: target,
            existedBefore: true,
            beforeSha256: sha("before\n"),
            beforeBytes: 7,
            afterSha256: null,
            afterBytes: 0,
          },
        ],
      }),
      "utf8",
    );
    await fs.rm(path.join(root, ...target.split("/")));

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(true);
    expect(recovered.reports[0]?.action).toBe("rolled-back");
    expect(await readText(root, target)).toBe("before\n");
  });

  it("已提交新建文件被外部删除时保留日志并报告冲突", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/vanish.md";
    const result = await commitFiles({
      root,
      files: [{ path: target, content: "kept\n", expectedSha256: null }],
    });
    await fs.rm(path.join(root, ...target.split("/")));
    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("conflict");
    expect(await fs.stat(path.join(root, ...TRANSACTIONS_DIR.split("/"), result.transactionId))).toBeTruthy();
  });

  it("已提交删除后外部又新建同路径文件时不清理日志", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/racy.md";
    await commitAndFinalize(root, [{ path: target, content: "gone\n", expectedSha256: null }]);
    const result = await commitFiles({
      root,
      files: [{ path: target, content: null, expectedSha256: sha("gone\n") }],
    });
    await fs.writeFile(path.join(root, ...target.split("/")), "external\n", "utf8");
    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(await readText(root, target)).toBe("external\n");
    expect(await fs.stat(path.join(root, ...TRANSACTIONS_DIR.split("/"), result.transactionId))).toBeTruthy();
  });

  it("workspace.json 未知字段与不支持的版本被拒绝，只接受 2", async () => {
    const root = await newWorkspace();
    const workspacePath = path.join(root, "workspace.json");
    const original = JSON.parse(await fs.readFile(workspacePath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      workspacePath,
      JSON.stringify({ ...original, unexpected: true }),
      "utf8",
    );
    await expect(readWorkspaceFiles(root)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });

    // 当前只支持格式 2；旧版与更高版本都必须在扫描阶段明确拒绝，不能猜一个格式。
    await fs.writeFile(workspacePath, JSON.stringify({ ...original, schemaVersion: 2 }), "utf8");
    await expect(readWorkspaceFiles(root)).resolves.toMatchObject({
      workspace: { schemaVersion: 2, topicMode: "isolated" },
    });
    await fs.writeFile(workspacePath, JSON.stringify({ ...original, schemaVersion: 1 }), "utf8");
    await expect(readWorkspaceFiles(root)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
    await fs.writeFile(workspacePath, JSON.stringify({ ...original, schemaVersion: 3 }), "utf8");
    await expect(readWorkspaceFiles(root)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
  });

  it("拒绝无效 UTF-8 而不产生替换字符", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/bad.md";
    await fs.mkdir(path.dirname(path.join(root, ...target.split("/"))), { recursive: true });
    await fs.writeFile(path.join(root, ...target.split("/")), Buffer.from([0xff, 0xfe, 0x00]), "binary" as never);
    await expect(readWorkspaceFiles(root)).rejects.toMatchObject({ code: "WORKSPACE_INVALID" });
  });

  it("prepared 缺少 before 数据时停止恢复且不改文件", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/nobefore.md";
    await commitAndFinalize(root, [{ path: target, content: "keep\n", expectedSha256: null }]);
    const transactionId = "20260101T000005Z-nobefore";
    const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
    await fs.mkdir(path.join(transactionDir, "after"), { recursive: true });
    await fs.writeFile(
      path.join(transactionDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "prepared",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: target,
            existedBefore: true,
            beforeSha256: sha("keep\n"),
            beforeBytes: 5,
            afterSha256: sha("changed\n"),
            afterBytes: 8,
          },
        ],
      }),
      "utf8",
    );
    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("invalid");
    expect(await readText(root, target)).toBe("keep\n");
    expect(await fs.stat(transactionDir)).toBeTruthy();
  });

  it("staged 日志但源文件已出现 after 字节时保留停写，不按 after 回滚", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/staged-race.md";
    await commitAndFinalize(root, [{ path: target, content: "before\n", expectedSha256: null }]);
    const transactionId = "20260101T000006Z-staged-race";
    const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
    await fs.mkdir(path.join(transactionDir, "before", "topics"), { recursive: true });
    await fs.writeFile(
      path.join(transactionDir, "before", "topics", "staged-race.md"),
      "before\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(transactionDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "staged",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: target,
            existedBefore: true,
            beforeSha256: sha("before\n"),
            beforeBytes: 7,
            afterSha256: sha("after\n"),
            afterBytes: 6,
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(root, ...target.split("/")), "after\n", "utf8");

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("conflict");
    expect(await readText(root, target)).toBe("after\n");
    expect(await fs.stat(transactionDir)).toBeTruthy();
  });

  it("缺 journal 的事务目录保留并停写", async () => {
    const root = await newWorkspace();
    const transactionId = "20260101T000007Z-nojournal";
    const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
    await fs.mkdir(transactionDir, { recursive: true });
    await fs.writeFile(path.join(transactionDir, "before.txt"), "evidence", "utf8");

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("invalid");
    expect(await fs.stat(transactionDir)).toBeTruthy();
    expect(await readText(root, path.relative(root, path.join(transactionDir, "before.txt")))).toBe("evidence");
  });

  it(".aichat 为 junction 时 recover/complete 均拒绝且外部目录不变", async () => {
    const root = await newWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-outside-runtime-"));
    temporaryRoots.push(outside);
    const outsideTransactions = path.join(outside, "transactions", "20260101T000008Z-outside");
    await fs.mkdir(outsideTransactions, { recursive: true });
    await fs.writeFile(
      path.join(outsideTransactions, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId: "20260101T000008Z-outside",
        state: "committed",
        createdAt: new Date().toISOString(),
        files: [],
      }),
      "utf8",
    );
    const sentinel = path.join(outsideTransactions, "sentinel.txt");
    await fs.writeFile(sentinel, "keep", "utf8");

    await fs.rm(path.join(root, ".aichat"), { recursive: true, force: true });
    try {
      await fs.symlink(outside, path.join(root, ".aichat"), "junction");
    } catch {
      return; // 无符号链接权限的环境跳过
    }

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("invalid");

    await expect(
      completeTransaction(root, "20260101T000008Z-outside"),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await expect(listTransactions(root)).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await expect(
      getTransaction(root, "20260101T000008Z-outside"),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });

    expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(outsideTransactions, "journal.json"), "utf8")).toContain(
      "20260101T000008Z-outside",
    );
  });

  it("事务目录被换为指向外部的 junction：recover 停写、commit 拒写、证据不变", async () => {
    const root = await newWorkspace();
    const target = "topics/主题/junction.md";
    await commitAndFinalize(root, [{ path: target, content: "B\n", expectedSha256: null }]);

    const transactionId = "20260101T000009Z-junction";
    const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
    const beforePath = path.join(transactionDir, "before", ...target.split("/"));
    const afterPath = path.join(transactionDir, "after", ...target.split("/"));
    await fs.mkdir(path.dirname(beforePath), { recursive: true });
    await fs.mkdir(path.dirname(afterPath), { recursive: true });
    await fs.writeFile(beforePath, "A\n", "utf8");
    await fs.writeFile(afterPath, "B\n", "utf8");
    await fs.writeFile(
      path.join(transactionDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "prepared",
        createdAt: new Date().toISOString(),
        files: [
          {
            path: target,
            existedBefore: true,
            beforeSha256: sha("A\n"),
            beforeBytes: 2,
            afterSha256: sha("B\n"),
            afterBytes: 2,
          },
        ],
      }),
      "utf8",
    );

    // 把事务目录挪到外部，再在原位置放一个指向它的 junction。
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aichat-junction-tx-"));
    temporaryRoots.push(outside);
    const outsideTransaction = path.join(outside, transactionId);
    await fs.rename(transactionDir, outsideTransaction);
    try {
      await fs.symlink(outsideTransaction, transactionDir, "junction");
    } catch {
      return; // 无符号链接权限的环境跳过
    }
    const sentinel = path.join(outsideTransaction, "sentinel.txt");
    await fs.writeFile(sentinel, "keep", "utf8");
    const outsideJournal = await fs.readFile(
      path.join(outsideTransaction, "journal.json"),
      "utf8",
    );

    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(false);
    expect(recovered.reports[0]?.action).toBe("invalid");
    expect(recovered.reports[0]?.transactionId).toBe(transactionId);

    await expect(
      commitFiles({
        root,
        files: [{ path: target, content: "C\n", expectedSha256: sha("B\n") }],
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });

    expect(await readText(root, target)).toBe("B\n");
    expect(await fs.readFile(sentinel, "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(outsideTransaction, "journal.json"), "utf8")).toBe(
      outsideJournal,
    );
    // junction 本身保留，未被删除或跟随。
    expect((await fs.lstat(transactionDir)).isSymbolicLink()).toBe(true);
  });

  it("staged 日志未修改源文件时直接清理", async () => {
    const root = await newWorkspace();
    const transactionId = "20260101T000003Z-staged";
    const transactionDir = path.join(root, ...TRANSACTIONS_DIR.split("/"), transactionId);
    await fs.mkdir(transactionDir, { recursive: true });
    await fs.writeFile(
      path.join(transactionDir, "journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        transactionId,
        state: "staged",
        createdAt: new Date().toISOString(),
        files: [],
      }),
      "utf8",
    );
    const recovered = await recoverTransactions({ root });
    expect(recovered.writable).toBe(true);
    expect(recovered.reports[0]?.action).toBe("discarded-staged");
    expect(await fs.stat(transactionDir).catch(() => null)).toBeNull();
  });
});