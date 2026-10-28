---
name: aichat-graph
description: >-
  在用户指定的 AIchat-graph 工作区中，伴随论文阅读、实验学习、方案讨论和想法梳理，
  持续维护可视化思考图；也用于已有主题续谈、补充节点和整理分支。
  用户启用图记录后无需每轮再次要求更新。
  仅讨论工具设计或尚未启用记录时，不自行创建或修改工作区。
---

# AIchat-graph 协作思考

让讨论留下可理解、可继续的思考图。程序独立提供 CLI、SQLite 存储、布局和 HTML 导出；本 Skill 负责讨论与记录方法，随附完整命令参考。

## 按需查阅

- 首次接入、选主题或核对宿主入口：[接入与主题绑定](references/workspace.md)。
- 首次撰写或整理节点：[节点内容与维护分寸](references/maintenance.md)。
- 查询参数、NodePatch、batch、分页或错误恢复：[命令参考](references/commands.md)。

已读且仍在上下文中的规则直接沿用；信息缺失时只补读相关部分，不每轮完整重读。

## 接入与目标

从用户给定位置或已配置入口确定实际 CLI 与工作区，显式传 --workspace 或 --workspace-id。
首次核对 topics，绑定工作区和稳定 topicId；唯一匹配后持续沿用，真实歧义才询问。
前端选择、activeNode、当前 shell 目录和其他对话不替代本对话的目标。
跨主题比较可按需读取，写入仍按用户指定范围；连接不能跨主题。
启用记录后持续按需维护，暂停时停止；初始化、服务管理和安装沿用具体授权。

工作区是 graph.sqlite + resources/；不存在节点 Markdown 或文件哈希。读取和写入都只使用稳定 nodeId 与持久 revision。

## 讨论与记录

聊天充分回答当前问题，节点保存能独立理解和继续的认识。
保留成立条件、理由和必要证据；按需使用例子，不以记录完成代替解释。
节点体量与可选栏目按内容参考执行，这些约束不限制聊天所需的解释长度。
agreed 只对应明确认可的范围；新提议用 proposed，资料与一般解释用 reference。
认可、已执行、实测结果和掌握程度分别表述；important 是独立的回看标记。

## 每轮维护

1. 对照本轮新增、修正、确认及推进的问题，定位已有记录；修改前理解相关正文与邻接关系。
   首次进入用 read --view overview；续谈用 resume <topicId> --node <anchorId>，一次得到 anchor 正文、来路和附近分支；
   需要展开时再 content --node；不必先理解数据库协议。只改元数据或取版本可用 --meta。
2. 判断落点：补充或修正原问题就原位完善；基于已有认识进入下一步问题用 next，
   可独立返回的方向用 branch。同一主题不等于同一张卡，不按聊天轮次机械建卡。
   同一张卡要同时改正文、状态、摘要、入边说明或重要性时，用一次 edit 完整提交；
   不要拆成 edit + connect + important 多次调用。
3. 原位更新将补充融入对应位置，清除失效或重复叙述；新的思考步骤由新节点承载。
   提交前确认本轮值得保留的问题已有落点，标题、概述、正文、状态和连接说明一致。
   多张卡混合修改用 batch（同一事务）；补旧卡同时加新卡、链中插入、纯重连和叶卡删除分别用 batch/insert/rearrange/delete。
4. 完成必要提交，检查 state、revision、nodeRevisions、changedNodeIds 和 diagnostics；同一节点继续修改时直接用 nodeRevisions[nodeId]，不再插入一次 read。
   无实质变化可不写；成功后自然继续讨论，不固定重读全图、验证或汇报维护过程。

## 操作边界

- 语义和内容由 Agent 判断；stable ID、display number、SQLite 事务、revision 和最近更新由程序管理。HTML 是自动生成的只读成品，不是第二真源。
- 使用与服务对应的 CLI；读取直接来自 SQLite。page.next 原样传回，不自行拼 cursor。
- 所有写入使用读取所得节点 revision；冲突返回 412 时重读相关节点并重新判断，不静默取最新版本覆盖。不要手工改 graph.sqlite。
- 单卡完整修改用 edit；新增 next/branch；多卡混合 batch；链中插入 insert；纯重连 rearrange；仅 important 用 important 或 edit。
- 长文本用 stdin 或文件传入；参数与互斥关系查命令参考；只查 batch 某操作字段用 help batch --op edit --json。
- 结果未知先用原 requestId 查询 status；离线读取不带 revision 时不要提交。托管提交已做结构与版本检查；外部直接改库、具体诊断或疑似损坏时再扩大核对。
- 不另建逐轮副本、维护日志或知识库双写；提炼、附件处理按用户实际需要进行。旧 V2 Markdown 只在用户明确授权时一次性 import，不继续写回。

Skill 是行为指引，不是自动注入每轮回复的后台钩子。
