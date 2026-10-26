/**
 * help 命令：分组帮助、单命令帮助与机器可读说明。
 *
 * 不解析 --workspace、不连接服务、不要求有效工作区；所有内容来自
 * command-specs 的同一张命令表。默认输出人类文本，--json 输出机器说明。
 */
import { loadProgramInfo } from "../build-info.js";
import {
  COMMAND_GROUPS,
  commandNames,
  getCommandSpec,
  parseCommandArgs,
  type CommandSpec,
} from "./command-specs.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES, UsageError } from "./errors.js";
import { emitJson, emitText } from "./output.js";
import { commandHelpText, rootHelp } from "./usage.js";

export interface HelpParameterJson {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly default?: string | number;
  readonly values?: readonly string[];
  readonly description: string;
  readonly conflicts?: readonly string[];
  readonly requires?: readonly string[];
}

function parametersJson(spec: CommandSpec): HelpParameterJson[] {
  const parameters: HelpParameterJson[] = [];
  for (const positional of spec.positionals ?? []) {
    parameters.push({
      name: positional.name,
      type: "string",
      required: positional.required === true,
      repeatable: false,
      description: positional.description,
    });
  }
  for (const parameter of spec.parameters) {
    parameters.push({
      name: "--" + parameter.name,
      type: parameter.type,
      required: parameter.required === true,
      repeatable: parameter.repeatable === true,
      ...(parameter.defaultValue !== undefined ? { default: parameter.defaultValue } : {}),
      ...(parameter.values !== undefined ? { values: parameter.values } : {}),
      description: parameter.description,
      // 约束里也用参数全名（含 --），机器侧可直接与 name 对应。
      ...(parameter.conflicts !== undefined
        ? { conflicts: parameter.conflicts.map((name) => "--" + name) }
        : {}),
      ...(parameter.requires !== undefined
        ? { requires: parameter.requires.map((name) => "--" + name) }
        : {}),
    });
  }
  return parameters;
}

/** 单命令机器说明（help --json 的字段集合由冻结稿约定）。 */
export function commandHelpJson(spec: CommandSpec): Record<string, unknown> {
  const info = loadProgramInfo();
  return {
    ok: true,
    command: spec.name,
    group: spec.group,
    interfaceVersion: info.interfaceVersion,
    programVersion: info.version,
    summary: spec.summary,
    usage: [...spec.usage],
    parameters: parametersJson(spec),
    // "至少一个"的互斥必填组；parameters[].required 只能表达"每个都要给"。
    ...(spec.requiredOneOf !== undefined
      ? { requiredOneOf: spec.requiredOneOf.map((group) => group.map((name) => "--" + name)) }
      : {}),
    ...(spec.input !== undefined
      ? {
          input: {
            kind: spec.input.kind,
            description: spec.input.description,
            schema: spec.input.schema,
            semanticNotes: [...spec.input.semanticNotes],
          },
        }
      : {}),
    constraints: [...spec.constraints],
    examples: [...spec.examples],
    result: {
      fields: [...spec.result.fields],
      ...(spec.result.states !== undefined ? { states: [...spec.result.states] } : {}),
      ...(spec.result.next !== undefined ? { next: [...spec.result.next] } : {}),
    },
  };
}

/** 总目录机器说明：命令名、分组与摘要；不展开每个命令的完整参数。 */
export function catalogHelpJson(): Record<string, unknown> {
  const info = loadProgramInfo();
  return {
    ok: true,
    command: "help",
    group: "meta",
    interfaceVersion: info.interfaceVersion,
    programVersion: info.version,
    summary: "命令目录；单命令完整机器说明用 aichat help <command> --json。",
    usage: ["aichat help <command> --json", "aichat help --json", "aichat --help"],
    parameters: [],
    constraints: [
      "帮助是纯本地信息：不解析 --workspace、不连接服务、不需要有效工作区。",
      "单命令说明只包含该命令。",
    ],
    examples: ["aichat help batch --json", "aichat --help"],
    commands: commandNames().map((name) => {
      const spec = getCommandSpec(name) as CommandSpec;
      return { name: spec.name, group: spec.group, summary: spec.summary };
    }),
    groups: COMMAND_GROUPS.map((group) => ({ ...group })),
    result: {
      fields: ["ok", "command", "group", "interfaceVersion", "programVersion", "commands", "groups"],
    },
  };
}

export async function runHelp(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommandArgs("help", args);
  if (parsed.values.has("json") && parsed.values.has("text")) {
    throw new UsageError("--json 与 --text 不能同时使用");
  }
  const json = parsed.values.has("json");
  const target = parsed.positional[0];
  if (target === undefined) {
    if (json) emitJson(ctx, catalogHelpJson());
    else emitText(ctx, [rootHelp()]);
    return EXIT_CODES.ok;
  }
  const spec = getCommandSpec(target);
  if (spec === undefined) {
    throw new UsageError(
      "未知命令 " + target + "；运行 aichat --help 查看命令目录，或 aichat help <command> --json",
    );
  }
  if (json) emitJson(ctx, commandHelpJson(spec));
  else emitText(ctx, [commandHelpText(target)]);
  return EXIT_CODES.ok;
}
