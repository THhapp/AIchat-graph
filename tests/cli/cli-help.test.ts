/**
 * help／version／whoami 的本地自查闭环：
 * - 根帮助分组、单命令帮助只含该命令、help --json 与命令表同源；
 * - 未知命令明确失败；不需要工作区与服务；
 * - version/--version/-V 给出版本、接口与构建身份。
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { main } from "../../src/cli/index.js";
import { COMMAND_SPECS, parseCommandArgs } from "../../src/cli/command-specs.js";
import { INTERFACE_VERSION, loadProgramInfo } from "../../src/build-info.js";

/** 不存在的 cwd：help／version 不应读取工作区，更不应因此失败。 */
const NO_WORKSPACE_CWD = path.join(os.tmpdir(), "aichat-cli-help-missing-dir");

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("帮助（不访问工作区与服务）", () => {
  it("aichat --help 给能力分组、常用命令、版本行与自查方式", async () => {
    const result = await main(["--help"], { cwd: NO_WORKSPACE_CWD });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("aichat — AIchat-graph 工作区 CLI");
    for (const group of ["Read", "Write", "Workspace & service", "Help & version"]) {
      expect(result.stdout).toContain(group);
    }
    for (const command of ["topics", "read", "batch", "insert", "version", "help"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("interface " + String(INTERFACE_VERSION));
    expect(result.stdout).toContain("aichat <command> --help");
    expect(result.stdout).toContain("aichat help <command> --json");

    // 推荐路径：按任务给一套入口，不在根帮助里罗列等价写法。
    expect(result.stdout).toContain("Recommended paths");
    const lines = result.stdout.split("\n");
    const recommended: Array<[string, string]> = [
      ["完善一张卡片", "edit"],
      ["新增纵向后继", "next"],
      ["新增独立方向", "branch"],
      ["链中插入", "insert"],
      ["仅标记重要", "important"],
      ["仅整理关系", "rearrange"],
      ["多卡混合修改", "batch"],
      ["新建主题", "create-topic"],
    ];
    for (const [task, command] of recommended) {
      expect(
        lines.some((line) => line.includes(task) && line.includes(command)),
        task,
      ).toBe(true);
    }
    expect(result.stdout).toContain("aichat help batch --op edit --json");
  });

  it("aichat <command> --help 只输出该命令，不附整份命令大全", async () => {
    const result = await main(["read", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aichat read — ");
    // 新参数名在帮助里，旧名不出现（不保留别名）。
    expect(result.stdout).toContain("--from-heading");
    expect(result.stdout).toContain("--occurrence");
    expect(result.stdout).toContain("refs");
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toContain("Result:");
    expect(result.stdout).toContain("next:");
    // 只输出当前命令：不出现其他命令的用法行。
    for (const other of ["aichat batch (", "aichat insert ", "aichat help <command>"]) {
      expect(result.stdout).not.toContain(other);
    }

    const batchHelp = await main(["batch", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(batchHelp.exitCode).toBe(0);
    expect(batchHelp.stdout).toContain("aichat batch — ");
    expect(batchHelp.stdout).toContain("--dry-run");
    expect(batchHelp.stdout).toContain("bodyFile");
    expect(batchHelp.stdout).not.toContain("aichat read <topicId");
  });

  it("aichat help <command> --json 给出可机器消费的完整说明", async () => {
    const result = await main(["help", "read", "--json"], { cwd: NO_WORKSPACE_CWD });
    expect(result.exitCode).toBe(0);
    const body = jsonOf(result.stdout);
    expect(body["ok"]).toBe(true);
    expect(body["command"]).toBe("read");
    expect(body["group"]).toBe("read");
    expect(body["interfaceVersion"]).toBe(INTERFACE_VERSION);
    expect(typeof body["programVersion"]).toBe("string");
    expect(Array.isArray(body["usage"])).toBe(true);
    const parameters = body["parameters"] as Array<Record<string, unknown>>;
    expect(Array.isArray(parameters)).toBe(true);
    const heading = parameters.find((item) => item["name"] === "--from-heading");
    expect(heading).toMatchObject({ type: "string", required: false, repeatable: false });
    const occurrence = parameters.find((item) => item["name"] === "--occurrence");
    expect(occurrence).toMatchObject({ type: "integer", requires: ["--from-heading"] });
    const workspace = parameters.find((item) => item["name"] === "--workspace");
    expect(workspace).toMatchObject({ type: "path" });
    const resultSpec = body["result"] as Record<string, unknown>;
    expect(resultSpec["fields"]).toContain("refs");
    // 单命令说明不附带整份目录。
    expect(body["commands"]).toBeUndefined();
  });

  it("help batch --json 暴露 batch 输入 schema 与语义说明", async () => {
    const result = await main(["help", "batch", "--json"], { cwd: NO_WORKSPACE_CWD });
    expect(result.exitCode).toBe(0);
    const body = jsonOf(result.stdout);
    expect(body["command"]).toBe("batch");
    const names = (body["parameters"] as Array<Record<string, unknown>>).map(
      (item) => item["name"],
    );
    for (const name of ["--input", "--input-stdin", "--dry-run", "--verbose", "--workspace"]) {
      expect(names).toContain(name);
    }
    const input = body["input"] as Record<string, unknown>;
    expect(input["kind"]).toBe("json");
    const schema = input["schema"] as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(Array.isArray(schema["required"])).toBe(true);
    const notes = input["semanticNotes"] as string[];
    expect(notes.join("\n")).toContain("bodyFile");
    expect(notes.join("\n")).toContain("一批");
    const constraints = body["constraints"] as string[];
    expect(constraints.join("\n")).toContain("一次");
    expect(Array.isArray(body["examples"])).toBe(true);
  });

  it("help --json 给命令目录；未知命令明确失败", async () => {
    const catalog = await main(["help", "--json"], { cwd: NO_WORKSPACE_CWD });
    expect(catalog.exitCode).toBe(0);
    const body = jsonOf(catalog.stdout);
    expect(body["ok"]).toBe(true);
    const commands = (body["commands"] as Array<Record<string, unknown>>).map(
      (item) => item["name"],
    );
    for (const name of Object.keys(COMMAND_SPECS)) expect(commands).toContain(name);
    const groups = body["groups"] as Array<Record<string, unknown>>;
    expect(groups.map((item) => item["id"])).toEqual([
      "read",
      "write",
      "workspace",
      "meta",
    ]);

    const unknown = await main(["help", "nope", "--json"], { cwd: NO_WORKSPACE_CWD });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toBe("");
    const error = JSON.parse(unknown.stderr) as { error: { code: string } };
    expect(error.error.code).toBe("USAGE");

    const unknownHelp = await main(["nope", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(unknownHelp.exitCode).toBe(2);
  });

  it("帮助的参数表与真实解析同源：文档给出的选项可解析，旧名被拒绝", () => {
    const spec = COMMAND_SPECS["read"];
    expect(spec).toBeDefined();
    // 表里列出的每个值选项在解析器里都存在（不要求给全必填值）。
    for (const name of ["from-heading", "occurrence", "node", "cursor"]) {
      expect(spec?.parameters.some((item) => item.name === name)).toBe(true);
    }
    expect(() =>
      parseCommandArgs("read", ["--node", "n_x", "--from-heading", "标题", "--occurrence", "0"]),
    ).not.toThrow();
    expect(() => parseCommandArgs("read", ["--section", "旧名"])).toThrow(/未知选项/);
    expect(() => parseCommandArgs("read", ["--section-index", "0"])).toThrow(/未知选项/);
  });

  it("connect 的 usage 与参数 enum 自洽：只允许 --flow next|branch", async () => {
    const human = await main(["connect", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("[--flow next|branch]");
    expect(human.stdout).not.toContain("root|next|branch");

    const machine = await main(["help", "connect", "--json"], { cwd: NO_WORKSPACE_CWD });
    expect(machine.exitCode).toBe(0);
    const body = jsonOf(machine.stdout);
    const usage = body["usage"] as string[];
    expect(usage.join("\n")).toContain("[--flow next|branch]");
    const flow = (body["parameters"] as Array<Record<string, unknown>>).find(
      (item) => item["name"] === "--flow",
    );
    expect(flow).toMatchObject({ type: "enum", values: ["next", "branch"] });
    const constraints = body["constraints"] as string[];
    expect(constraints.join("\n")).toContain("root");
  });

  it("正文来源必填在 help 中可机器读取：requiredOneOf 与 batch create schema", async () => {
    // insert／branch／next／create-*：正文三选一必填，用 requiredOneOf 表达"至少一个"。
    for (const command of ["insert", "branch", "next", "create-topic", "create-root"]) {
      const result = await main(["help", command, "--json"], { cwd: NO_WORKSPACE_CWD });
      expect(result.exitCode, command).toBe(0);
      const body = jsonOf(result.stdout);
      expect(body["requiredOneOf"], command).toEqual([
        ["--body", "--body-file", "--body-stdin"],
      ]);
      const human = await main([command, "--help"], { cwd: NO_WORKSPACE_CWD });
      expect(human.stdout, command).toContain("Required (at least one):");
      const constraints = body["constraints"] as string[];
      expect(constraints.join("\n"), command).toContain("正文必须给出");
    }

    // batch create 的 body 与 bodyFile 恰好一个：schema oneOf + semanticNotes。
    const batch = jsonOf(
      (await main(["help", "batch", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const input = batch["input"] as Record<string, unknown>;
    const schemaText = JSON.stringify(input["schema"]);
    expect(schemaText).toContain('"oneOf"');
    expect(schemaText).toContain('"bodyFile"');
    expect(schemaText).toContain('"body"');
    const notes = (input["semanticNotes"] as string[]).join("\n");
    expect(notes).toContain("create 的 body 与 bodyFile 恰好给一个");
  });

  it("edit 帮助暴露新参数、单动作原子性与字段级提示入口", async () => {
    const human = await main(["edit", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(human.exitCode).toBe(0);
    for (const fragment of [
      "--clear-summary",
      "--important true|false",
      "--description",
      "--from-ref",
      "--flow next|branch",
      "Required (at least one):",
    ]) {
      expect(human.stdout, fragment).toContain(fragment);
    }
    expect(human.stdout).toContain("同一个 patchNode 动作、同一次事务提交");

    const machine = jsonOf(
      (await main(["help", "edit", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const parameters = machine["parameters"] as Array<Record<string, unknown>>;
    const important = parameters.find((item) => item["name"] === "--important");
    expect(important).toMatchObject({ type: "enum", values: ["true", "false"] });
    const clearSummary = parameters.find((item) => item["name"] === "--clear-summary");
    expect(clearSummary?.conflicts).toContain("--summary");
    const fromRef = parameters.find((item) => item["name"] === "--from-ref");
    expect(fromRef?.requires).toEqual(["--flow", "--description"]);
    const flow = parameters.find((item) => item["name"] === "--flow");
    expect(flow).toMatchObject({ values: ["next", "branch"], requires: ["--description"] });
    const constraints = (machine["constraints"] as string[]).join("\n");
    expect(constraints).toContain("同一个 patchNode 动作");
    expect(constraints).toContain("不隐式读取 stdin");

    // batch 完整帮助指明操作级帮助入口，且不混淆为 --op 属于 batch 参数。
    const batch = jsonOf(
      (await main(["help", "batch", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    expect((batch["constraints"] as string[]).join("\n")).toContain(
      "aichat help batch --op edit|create|connect|important --json",
    );
  });

  it("read usage 把 --from-heading／--occurrence 与 --meta 拆成独立行", async () => {
    const machine = await main(["help", "read", "--json"], { cwd: NO_WORKSPACE_CWD });
    expect(machine.exitCode).toBe(0);
    const usage = jsonOf(machine.stdout)["usage"] as string[];
    for (const line of usage) {
      // --meta 不能与正文参数同用，不能出现在同一 usage 行造成可搭配的错觉。
      expect(line.includes("--from-heading") && line.includes("--meta")).toBe(false);
    }
    expect(usage.some((line) => line.includes("--from-heading") && !line.includes("--meta"))).toBe(
      true,
    );
    expect(usage.some((line) => line.includes("--meta") && !line.includes("--from-heading"))).toBe(
      true,
    );
    expect(usage.join("\n")).toContain("--meta 不能与");

    const human = await main(["read", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(human.exitCode).toBe(0);
    // 只看 Usage 段：Parameters 段里 --meta 的 conflicts 会合法地列出 --from-heading。
    const usageSection = human.stdout.split("Parameters:")[0] ?? "";
    const humanLines = usageSection.split("\n");
    for (const line of humanLines) {
      expect(line.includes("--from-heading") && line.includes("--meta")).toBe(false);
    }
    expect(humanLines.some((line) => line.includes("--from-heading"))).toBe(true);
    expect(humanLines.some((line) => line.includes("--meta "))).toBe(true);
  });

  it("edit --summary 描述保持现状，create 系列才说派生", async () => {
    const edit = jsonOf((await main(["help", "edit", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout);
    const editSummary = (edit["parameters"] as Array<Record<string, unknown>>).find(
      (item) => item["name"] === "--summary",
    );
    expect(String(editSummary?.["description"])).toContain("保持现有显式概述");
    expect(String(editSummary?.["description"])).not.toContain("派生");

    const createRoot = jsonOf(
      (await main(["help", "create-root", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const createSummary = (createRoot["parameters"] as Array<Record<string, unknown>>).find(
      (item) => item["name"] === "--summary",
    );
    expect(String(createSummary?.["description"])).toContain("派生");
  });

  it("409／422 分类与 create-root 语义在 help 中准确", async () => {
    const batch = jsonOf((await main(["help", "batch", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout);
    const batchConstraints = (batch["constraints"] as string[]).join("\n");
    expect(batchConstraints).toContain("结构错误");
    expect(batchConstraints).toContain("422");
    expect(batchConstraints).toContain("占位");
    expect(batchConstraints).toContain("409");
    const batchNotes = ((batch["input"] as Record<string, unknown>)["semanticNotes"] as string[]).join(
      "\n",
    );
    expect(batchNotes).toContain("结构错误");
    expect(batchNotes).toContain("422");
    expect(batchNotes).toContain("占位／语义冲突");
    expect(batchNotes).toContain("409");
    expect(batchNotes).not.toContain("结构冲突（唯一 next、成环、占位、跨主题）整体 409");

    const rearrange = jsonOf(
      (await main(["help", "rearrange", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const rearrangeConstraints = (rearrange["constraints"] as string[]).join("\n");
    expect(rearrangeConstraints).toContain("结构错误 422");
    expect(rearrangeConstraints).toContain("占位／语义冲突 409");
    const rearrangeNotes = (
      (rearrange["input"] as Record<string, unknown>)["semanticNotes"] as string[]
    ).join("\n");
    expect(rearrangeNotes).toContain("过期 ref 412");
    expect(rearrangeNotes).toContain("结构错误 422");
    expect(rearrangeNotes).toContain("占位／语义冲突 409");

    // 所有写命令共用的约束：结构 422、占位／语义 409。
    const edit = jsonOf((await main(["help", "edit", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout);
    const editConstraints = (edit["constraints"] as string[]).join("\n");
    expect(editConstraints).toContain("结构错误");
    expect(editConstraints).toContain("422");
    expect(editConstraints).toContain("占位／语义冲突");
    expect(editConstraints).toContain("409");
    expect(editConstraints).not.toContain("（唯一 next、成环、占位）返回 409");

    // insert 的非相邻判断仍是 409（冻结稿），不被结构 422 覆盖。
    const insert = jsonOf(
      (await main(["help", "insert", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const insertConstraints = (insert["constraints"] as string[]).join("\n");
    expect(insertConstraints).toContain("非相邻整体 409");
    expect(insertConstraints).toContain("操作冲突");
    expect(insertConstraints).not.toContain("非相邻整体 422");

    // create-root：只用于空工作区，已有根不能再建；不再是"给已有主题加独立根"。
    const createRoot = jsonOf(
      (await main(["help", "create-root", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    expect(String(createRoot["summary"])).toContain("空工作区");
    const createRootConstraints = (createRoot["constraints"] as string[]).join("\n");
    expect(createRootConstraints).toContain("只用于空工作区");
    expect(createRootConstraints).toContain("不会给已有主题加第二根");
    expect(createRootConstraints).toContain("409");
    expect(createRootConstraints).not.toContain("只给已有主题增加一条独立根");
    const topicTitle = (createRoot["parameters"] as Array<Record<string, unknown>>).find(
      (item) => item["name"] === "--topic-title",
    );
    expect(String(topicTitle?.["description"])).toContain("工作区必须尚无任何节点");

    const human = await main(["create-root", "--help"], { cwd: NO_WORKSPACE_CWD });
    expect(human.stdout).toContain("空工作区");
    expect(human.stdout).toContain("第二根");
    expect(human.stdout).not.toContain("目标主题必须已存在");
  });


  it("help batch --op <op> 给局部说明，不输出完整 batch schema", async () => {
    for (const op of ["edit", "create", "connect", "important"]) {
      const human = await main(["help", "batch", "--op", op], { cwd: NO_WORKSPACE_CWD });
      expect(human.exitCode, op).toBe(0);
      expect(human.stdout, op).toContain("aichat batch --op " + op);
      expect(human.stdout, op).toContain("Fields:");
      expect(human.stdout, op).toContain("Example:");
      expect(human.stdout, op).not.toContain("topicId");

      const machine = jsonOf(
        (await main(["help", "batch", "--op", op, "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
      );
      expect(machine["ok"], op).toBe(true);
      expect(machine["command"], op).toBe("batch");
      expect(machine["op"], op).toBe(op);
      expect(machine["group"], op).toBe("write");
      expect(machine["interfaceVersion"], op).toBe(INTERFACE_VERSION);
      expect(typeof machine["programVersion"], op).toBe("string");
      expect(typeof machine["summary"], op).toBe("string");
      expect(Array.isArray(machine["fields"]), op).toBe(true);
      expect(Array.isArray(machine["constraints"]), op).toBe(true);
      expect(Array.isArray(machine["next"]), op).toBe(true);
      // 操作级帮助不含完整 batch schema。
      expect(machine["input"], op).toBeUndefined();
      expect(machine["schema"], op).toBeUndefined();
      const wire = JSON.stringify(machine);
      expect(wire, op).not.toContain('"topicId"');
      expect(wire, op).not.toContain('"ops"');
      expect((machine["example"] as Record<string, unknown>)["op"], op).toBe(op);
    }

    const edit = jsonOf(
      (await main(["help", "batch", "--op", "edit", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const editFields = edit["fields"] as Array<Record<string, unknown>>;
    expect(editFields.find((field) => field["path"] === "target")).toMatchObject({
      type: "ref",
      required: true,
    });
    expect(editFields.find((field) => field["path"] === "patch.bodyFile")).toMatchObject({
      type: "string",
      required: false,
    });

    const create = jsonOf(
      (await main(["help", "batch", "--op", "create", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const createFields = create["fields"] as Array<Record<string, unknown>>;
    const bodyField = createFields.find((field) => field["path"] === "body");
    expect(bodyField?.["exactlyOneWith"]).toEqual(["bodyFile"]);
  });

  it("--op 只与 batch 同用；未知 op 明确失败并列出可用 op", async () => {
    const wrongCommand = await main(["help", "read", "--op", "edit", "--json"], {
      cwd: NO_WORKSPACE_CWD,
    });
    expect(wrongCommand.exitCode).toBe(2);
    expect(wrongCommand.stdout).toBe("");
    const wrong = JSON.parse(wrongCommand.stderr) as { error: { message: string } };
    expect(wrong.error.message).toContain("--op 只能与 batch 同用");
    expect(wrong.error.message).toContain("edit／create／connect／important");
    expect(wrong.error.message).toContain("aichat help batch --json");

    const unknown = await main(["help", "batch", "--op", "remove", "--json"], {
      cwd: NO_WORKSPACE_CWD,
    });
    expect(unknown.exitCode).toBe(2);
    const unknownError = JSON.parse(unknown.stderr) as { error: { message: string } };
    expect(unknownError.error.message).toContain("未知 batch 操作");
    expect(unknownError.error.message).toContain("edit／create／connect／important");
    expect(unknownError.error.message).toContain("aichat help batch --op edit --json");
  });

  it("操作级帮助字段与 batch schema 同源（路径集合一致）", async () => {
    const full = jsonOf(
      (await main(["help", "batch", "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
    );
    const schema = (full["input"] as Record<string, unknown>)["schema"] as Record<string, unknown>;
    const schemaProperties = schema["properties"] as Record<string, Record<string, unknown>>;
    const opsSchema = schemaProperties["ops"] as Record<string, unknown>;
    const items = opsSchema["items"] as Record<string, unknown>;
    const opSchemas = items["oneOf"] as Array<Record<string, unknown>>;
    expect(opSchemas).toHaveLength(4);

    const flatten = (node: Record<string, unknown>, prefix: string): string[] => {
      const result: string[] = [];
      const properties = node["properties"] as Record<string, Record<string, unknown>> | undefined;
      if (properties === undefined) return result;
      for (const [key, value] of Object.entries(properties)) {
        const path = prefix === "" ? key : prefix + "." + key;
        result.push(path);
        // target／from 是 {ref}／{ref,local} 选择对象；帮助把它们当作单字段。
        if (value["type"] === "object" && key !== "target" && key !== "from") {
          result.push(...flatten(value, path));
        }
      }
      return result;
    };

    for (const [index, op] of ["edit", "create", "connect", "important"].entries()) {
      const machine = jsonOf(
        (await main(["help", "batch", "--op", op, "--json"], { cwd: NO_WORKSPACE_CWD })).stdout,
      );
      const helpPaths = (machine["fields"] as Array<Record<string, unknown>>)
        .map((field) => field["path"])
        .sort();
      const schemaPaths = flatten(opSchemas[index] as Record<string, unknown>, "").sort();
      expect(helpPaths, op).toEqual(schemaPaths);
    }
  });
});

describe("version", () => {
  it("version 默认 JSON：program／runtime 与构建身份", async () => {
    const result = await main(["version"], { cwd: NO_WORKSPACE_CWD });
    expect(result.exitCode).toBe(0);
    const body = jsonOf(result.stdout);
    expect(body["ok"]).toBe(true);
    expect(body["command"]).toBe("version");
    const program = body["program"] as Record<string, unknown>;
    expect(program["name"]).toBe("aichat-graph");
    expect(typeof program["version"]).toBe("string");
    expect(program["interfaceVersion"]).toBe(INTERFACE_VERSION);
    expect(typeof program["buildId"]).toBe("string");
    expect(program).toHaveProperty("commit");
    expect(program).toHaveProperty("builtAt");
    expect(["dist", "dev", "invalid"]).toContain(program["manifest"]);
    const runtime = body["runtime"] as Record<string, unknown>;
    expect(runtime["node"]).toBe(process.version);
    expect(runtime["executable"]).toBe(process.execPath);
  });

  it("version --text 给出人类可读摘要；--json 与 --text 互斥", async () => {
    const text = await main(["version", "--text"], { cwd: NO_WORKSPACE_CWD });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("aichat-graph");
    expect(text.stdout).toContain("interface " + String(INTERFACE_VERSION));
    expect(text.stdout).toContain("node " + process.version);

    const both = await main(["version", "--json", "--text"], { cwd: NO_WORKSPACE_CWD });
    expect(both.exitCode).toBe(2);
  });

  it("aichat --version／-V 打印一行程序／接口／构建身份", async () => {
    const info = loadProgramInfo();
    for (const flag of ["--version", "-V"]) {
      const result = await main([flag], { cwd: NO_WORKSPACE_CWD });
      expect(result.exitCode, flag).toBe(0);
      const lines = result.stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("aichat-graph");
      expect(lines[0]).toContain("interface " + String(INTERFACE_VERSION));
      expect(lines[0]).toContain("build " + info.buildId);
    }
  });
});
