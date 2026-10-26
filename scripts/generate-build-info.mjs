#!/usr/bin/env node
/**
 * 生成 dist/build-info.json：程序版本、git 短 commit、dirty 标记、构建时间与 buildId。
 *
 * 由 package.json 的 prebuild:node 在 tsc 之前执行；运行时不读 git，也不新增依赖。
 * 没有 git（源码压缩包、受限环境）时 commit 为 null、buildId 以 +dev 结尾；
 * 工作树相对 HEAD 有改动时 buildId 追加 .dirty。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputPath = path.join(root, "dist", "build-info.json");
const outputName = path.relative(root, outputPath).split(path.sep).join("/");

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json 缺少 version，无法生成构建标识。");
}

const commitText = runGit(["rev-parse", "--short", "HEAD"]);
const commit = commitText !== null && commitText.length > 0 ? commitText : null;
const status = commit === null ? null : runGit(["status", "--porcelain"]);
const dirty = status !== null && status.length > 0;
const buildId = commit === null ? `${version}+dev` : `${version}+${commit}${dirty ? ".dirty" : ""}`;

const manifest = {
  schemaVersion: 1,
  program: "aichat-graph",
  version,
  commit,
  builtAt: new Date().toISOString(),
  buildId,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`已生成构建标识：${buildId}（${outputName}）`);
