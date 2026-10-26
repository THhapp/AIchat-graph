/**
 * 程序身份：程序名、接口版本与构建清单。
 *
 * 构建时由 scripts/generate-build-info.mjs 写出 dist/build-info.json，运行时从
 * 本模块同目录读取。源码直接运行（测试、构建前脚本）没有清单，回退 package.json
 * 版本并把 manifest 标成 dev；清单无法读取或字段不完整时标成 invalid，不抛异常，
 * 让 version/whoami 仍能报告双方身份并完成诊断。
 *
 * 只由 Node 端（CLI/service）导入；web 构建不包含本模块。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgramInfo } from "./shared/protocol.js";

/** 与 CLI／service 对外的接口版本；缺失或不匹配时普通读写报 INTERFACE_MISMATCH。 */
export const INTERFACE_VERSION = 2;

/** 对外程序名，也写入 ProgramInfo.program。 */
export const PROGRAM_NAME = "aichat-graph";

const BUILD_INFO_FILE = "build-info.json";
const BUILD_INFO_SCHEMA_VERSION = 1;
const FALLBACK_VERSION = "0.0.0";

interface BuildManifest {
  readonly schemaVersion: number;
  readonly program: string;
  readonly version: string;
  readonly commit: string | null;
  readonly builtAt: string | null;
  readonly buildId: string;
}

type ManifestRead =
  | { readonly kind: "found"; readonly manifest: BuildManifest }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** 程序自身 package.json 的版本；读不到时返回 null，由调用方用固定回退值。 */
function readPackageVersion(): string | null {
  try {
    const text = readFileSync(path.join(moduleDirectory(), "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function isBuildManifest(value: unknown): value is BuildManifest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === BUILD_INFO_SCHEMA_VERSION
    && record.program === PROGRAM_NAME
    && typeof record.version === "string"
    && record.version.length > 0
    && typeof record.buildId === "string"
    && record.buildId.length > 0
    && (record.commit === null || typeof record.commit === "string")
    && (record.builtAt === null || typeof record.builtAt === "string");
}

/** 读取本模块同目录的构建清单；缺失与损坏分开，损坏不抛异常。 */
function readManifest(): ManifestRead {
  let text: string;
  try {
    text = readFileSync(path.join(moduleDirectory(), BUILD_INFO_FILE), "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isBuildManifest(parsed) ? { kind: "found", manifest: parsed } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * 当前运行的构建身份。每次调用读取一次清单，长驻进程不会汇报过期的缓存。
 * 不猜其他路径：只认本模块同目录的清单与上级 package.json。
 */
export function loadProgramInfo(): ProgramInfo {
  const version = readPackageVersion() ?? FALLBACK_VERSION;
  const result = readManifest();
  if (result.kind === "found") {
    return {
      program: PROGRAM_NAME,
      version: result.manifest.version,
      interfaceVersion: INTERFACE_VERSION,
      buildId: result.manifest.buildId,
      commit: result.manifest.commit,
      builtAt: result.manifest.builtAt,
      manifest: "dist",
    };
  }
  if (result.kind === "missing") {
    return {
      program: PROGRAM_NAME,
      version,
      interfaceVersion: INTERFACE_VERSION,
      buildId: "dev",
      commit: null,
      builtAt: null,
      manifest: "dev",
    };
  }
  return {
    program: PROGRAM_NAME,
    version,
    interfaceVersion: INTERFACE_VERSION,
    buildId: "invalid",
    commit: null,
    builtAt: null,
    manifest: "invalid",
  };
}
