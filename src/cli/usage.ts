/**
 * 帮助文本渲染：全部来自 command-specs 的单一命令表，不手写第二份命令清单。
 *
 * - rootHelp：能力分组、常用命令、版本／接口行与自查提示；
 * - commandHelpText：只输出当前命令（参数、示例、约束、结果字段）；
 * - briefUsage：错误输出与缺参提示用的短用法。
 */
import { loadProgramInfo } from "../build-info.js";
import {
  COMMAND_GROUPS,
  commandNames,
  getCommandSpec,
  type CommandSpec,
  type CommandParameter,
} from "./command-specs.js";

/** 一行程序／接口／构建身份。 */
export function versionLine(): string {
  const info = loadProgramInfo();
  return (
    info.program +
    " " +
    info.version +
    " interface " +
    String(info.interfaceVersion) +
    " build " +
    info.buildId
  );
}

function firstClause(text: string): string {
  const index = text.search(/[；。]/);
  return index === -1 ? text : text.slice(0, index);
}

function commandParameterLine(parameter: CommandParameter): string {
  const head = "--" + parameter.name + (parameter.valueName ? " " + parameter.valueName : "");
  const notes: string[] = [];
  if (parameter.required === true) notes.push("必填");
  if (parameter.repeatable === true) notes.push("可重复");
  if (parameter.defaultValue !== undefined) notes.push("默认 " + String(parameter.defaultValue));
  if (parameter.type === "enum" && parameter.values !== undefined) {
    notes.push("取值 " + parameter.values.join("|"));
  }
  if (parameter.requires !== undefined && parameter.requires.length > 0) {
    notes.push("需与 " + parameter.requires.map((name) => "--" + name).join("／") + " 同用");
  }
  if (parameter.conflicts !== undefined && parameter.conflicts.length > 0) {
    notes.push("不能与 " + parameter.conflicts.map((name) => "--" + name).join("／") + " 同用");
  }
  return (
    "  " +
    head.padEnd(30) +
    (notes.length > 0 ? "[" + notes.join("；") + "] " : "") +
    parameter.description
  );
}

function positionalLine(name: string, required: boolean, description: string): string {
  return (
    "  " +
    name.padEnd(30) +
    (required ? "[必填] " : "[可选] ") +
    description +
    "（位置参数）"
  );
}

/** 分组根帮助：能力分组、常用命令、版本行与自查方式。 */
export function rootHelp(): string {
  const lines: string[] = [
    "aichat — AIchat-graph 工作区 CLI",
    versionLine(),
    "",
    "Usage: aichat <command> [options]",
    "       aichat <command> --help          只查看该命令",
    "       aichat help <command> --json     机器可读的单命令说明",
    "       aichat help --json               机器可读的命令目录",
    "",
  ];
  for (const group of COMMAND_GROUPS) {
    lines.push(group.title + " — " + group.description + ":");
    for (const name of commandNames()) {
      const spec = getCommandSpec(name);
      if (spec === undefined || spec.group !== group.id) continue;
      lines.push("  " + name.padEnd(14) + firstClause(spec.summary));
    }
    lines.push("");
  }
  lines.push(
    "Global options:",
    "  --workspace <path>   工作区目录；省略时使用当前目录（serve 必须显式给出）",
    "  --json               机器可读 JSON（默认输出）",
    "  --text               简短人类摘要",
    "  --verbose            写命令输出 touchedFiles／paths／hashes／事务与 HTTP 诊断",
    "  -h, --help           显示帮助",
    "  --version, -V        显示程序／接口／构建身份",
    "",
    "提示：read 在线时顶层 refs 是写入凭据；离线 refs 为空且不可写。",
    "      batch 的 bodyFile／appendFile／replaceFile 由 CLI 读取，服务端不读路径。",
  );
  return lines.join("\n");
}

/** 单命令帮助：只包含该命令，不附整份命令大全。 */
export function commandHelpText(name: string): string {
  const spec = getCommandSpec(name);
  if (spec === undefined) return rootHelp();
  const lines: string[] = [
    "aichat " + spec.name + " — " + spec.summary,
    versionLine(),
    "",
    "Usage:",
  ];
  for (const usage of spec.usage) lines.push("  " + usage);
  lines.push("", "Parameters:");
  for (const positional of spec.positionals ?? []) {
    lines.push(positionalLine(positional.name, positional.required === true, positional.description));
  }
  for (const parameter of spec.parameters) lines.push(commandParameterLine(parameter));
  for (const group of spec.requiredOneOf ?? []) {
    lines.push(
      "  Required (at least one): " + group.map((name) => "--" + name).join(" | "),
    );
  }
  if (spec.input !== undefined) {
    lines.push("", "Input (" + spec.input.description + "):");
    lines.push("  JSON Schema 与语义说明：aichat help " + spec.name + " --json");
    for (const note of spec.input.semanticNotes) lines.push("  - " + note);
  }
  lines.push("", "Constraints:");
  for (const constraint of spec.constraints) lines.push("  - " + constraint);
  lines.push("", "Examples:");
  for (const example of spec.examples) lines.push("  " + example);
  lines.push("", "Result:");
  lines.push("  fields: " + spec.result.fields.join(", "));
  if (spec.result.states !== undefined) {
    lines.push("  states: " + spec.result.states.join(" | "));
  }
  if (spec.result.next !== undefined) {
    for (const next of spec.result.next) lines.push("  next: " + next);
  }
  return lines.join("\n");
}

/** 错误输出用的简短用法：只给当前命令，未知命令给命令索引。 */
export function briefUsage(command: string | undefined): string {
  const spec = command === undefined ? undefined : getCommandSpec(command);
  if (spec !== undefined) return "Usage: " + spec.usage[0];
  return (
    "Usage: aichat <command> [options]\n" +
    "Commands: " +
    commandNames().join(" ") +
    "\n单命令帮助：aichat <command> --help；机器说明：aichat help <command> --json"
  );
}
