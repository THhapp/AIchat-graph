/** version 命令：程序、接口与构建身份；不访问工作区与服务。 */
import { loadProgramInfo } from "../build-info.js";
import { parseCommandArgs } from "./command-specs.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES } from "./errors.js";
import { emit, parseOutputMode } from "./output.js";
import { versionLine } from "./usage.js";

export async function runVersion(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("version", args);
  const mode = parseOutputMode(parsed);
  const info = loadProgramInfo();
  const payload = {
    ok: true,
    command: "version",
    program: {
      name: info.program,
      version: info.version,
      interfaceVersion: info.interfaceVersion,
      buildId: info.buildId,
      commit: info.commit,
      builtAt: info.builtAt,
      ...(info.manifest !== undefined ? { manifest: info.manifest } : {}),
    },
    runtime: {
      node: process.version,
      executable: process.execPath,
    },
  };
  const lines = [
    versionLine(),
    "manifest " +
      (info.manifest ?? "unknown") +
      "  commit " +
      (info.commit ?? "-") +
      "  builtAt " +
      (info.builtAt ?? "-"),
    "node " + process.version,
    "executable " + process.execPath,
  ];
  emit(ctx, mode, payload, lines);
  return EXIT_CODES.ok;
}
