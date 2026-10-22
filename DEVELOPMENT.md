# 开发与运行版本管理

产品安装与使用见 [README](README.md)，数据和接口以 [ARCHITECTURE](ARCHITECTURE.md) 为准。本文件集中说明源码开发、验证及 Windows 运行版本管理，不保存个人工作区位置或开发进度副本。

## 分清程序与资料

| 用途 | 程序位置 | 资料与配置 | Windows 入口 |
| --- | --- | --- | --- |
| 源码开发 | 当前仓库的 `src/`、`dist/` 和开发依赖 | 默认 `.local/development-workspace`；配置 `launcher.development.local.json` | `start-dev.cmd`，默认 4318 |
| 固定运行版本 | `.local/daily`，包含独立运行依赖与同版本 Skill | 仓库外的自选资料库；配置 `launcher.local.json` | `start.cmd`，默认 4317 |

固定运行版本是启动器在本机准备的构建快照，不是另一个源码分支，也不是已发布的安装包。源码变化不会自动更新该快照。两套配置互不继承，开发入口拒绝使用与已绑定正式资料库相同或相互包含的目录。

`.local/`、`*.local.json`、依赖和构建产物均不上传 GitHub。个人路径与快捷方式仅保存在本机；公开文档使用通用路径示例。讨论资料不复制进程序快照。

## 开始开发

环境基线为 Node.js 24.17.0、npm 11.13.0。在仓库根目录执行：

```powershell
npm ci
./start-dev.cmd
```

开发入口按需构建当前源码，默认使用独立测试资料。仅启动服务不打开浏览器可加 `-NoBrowser`；具体选项用 `./start-dev.cmd -Help` 查看。

手动启动时自己明确测试工作区和端口，绕过启动器也就不再享有它的配置隔离检查：

```powershell
npm run build
node ./dist/cli/index.js init "../graph-test-workspace" --name "Graph test"
node ./dist/cli/index.js serve --workspace "../graph-test-workspace" --port 4318
```

已有工作区不要再次初始化。不要用真实讨论资料充当写入、迁移或故障验证样例。

## 准备和更新固定运行版本

首次准备前完成必要检查和构建，再选择仓库外的资料库：

```powershell
npm ci
npm run build
./update-daily.cmd
./start.cmd -Workspace "D:/my-graph-vault"
```

首次绑定后 `start.cmd` 沿用本机配置，不默默回退到其他目录。服务控制台保持打开，Ctrl+C 停止。需要快捷方式时指向 `start.cmd`；移动仓库后需自行更新入口。

后续更新顺序是：停止固定版本服务，验证改动，重新构建，执行 `update-daily.cmd`，再启动。更新命令不替代源码构建，不自动拉取 GitHub；它从现有构建准备独立生产依赖与 Skill，准备失败保留旧版本，运行中拒绝替换。更新不迁移或复制资料库。

Agent 使用对应运行版本的 CLI 和 Skill：固定版本分别位于 `.local/daily/dist/cli/index.js`、`.local/daily/skills/aichat-graph/SKILL.md`；开发版本使用仓库内入口。前端复制的续谈上下文会提供实际服务对应的位置。

## 验证与提交

按变更风险选择现有检查，不默认运行全部历史测试或增加测试平台。文档与 Skill 文字修改检查引用和格式；界面修改验证受影响操作；解析、迁移和写入恢复重点检查数据完整性。

```powershell
npm run typecheck
# 示例：主题隔离相关的针对性检查，其他改动选择对应文件
npx vitest run tests/core/format2.test.ts tests/service/agent.test.ts tests/web/reading.test.ts
npm run build
```

主题隔离已验证独立根与编号、跨主题连接拒绝、目录碰撞保护、主题内搜索和旧 shared 兼容；页面已验证主题切换、刷新后恢复折叠、主题级复制及导出面板共存。程序检查不代替使用者对版面和交互的认可。

离线阅读器内联公式字体，构建文件较大属当前实现边界，不为消除体积提示拆出必须联网的依赖。更详细的数据恢复和导出验收约束见工程契约。

提交前检查暂存区，排除私人路径、真实讨论、凭据、运行配置和成品。Git 提交、推送与发布遵循明确授权，不将一次推送视为长期自动发布许可。
