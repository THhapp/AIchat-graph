# 新工作区指南

## 初始化

选仓库之外的目录；不存在或空目录可直接初始化：

    aichat init D:/my-discussions --name "我的讨论库"
    aichat config --workspace D:/my-discussions
    aichat serve --workspace D:/my-discussions

浏览器打开 http://127.0.0.1:4317。停止服务后数据仍在 graph.sqlite；不需要维护 workspace.json、topics/ 或节点 Markdown。

## 目录

    graph.sqlite                     唯一主存储（WAL）
    resources/                       正文引用的本地图片
    .aichat/runtime/service.json     当前服务描述（实例身份/URL/进程）
    .aichat/local/exports.json       本机 HTML 目标（不进入内容真源）

.aichat/runtime/service.json 由程序维护；不要手工编辑。删除它只影响服务发现，不删数据。

## 旧资料

旧版 Markdown 工作区在需要时一次性导入：

    aichat import --workspace D:/old-workspace --name "导入后的讨论库"

原 workspace.json、topics/ 和资源不动；导入后新程序只读 graph.sqlite。确认新库可正常打开和 HTML 更新前，不要删除旧目录。导入拒绝覆盖已有 graph.sqlite。

## 给 Agent

把程序路径和工作区路径交给 Agent；Agent 先 topics 和 read/resume，再用稳定 ID/revision 写入。需要项目协作方法时再加载 Skill。不要让 Agent 直接改 graph.sqlite 或旧 Markdown。

## 迁移与切换

1. 构建新版本并核对 version/whoami 为接口 4。
2. 停止旧日用服务，运行 update-daily；先不要删除旧资料。
3. 对正式库执行一次 import；启动新日用服务并验证主题、图、详情、important、HTML 自动更新。
4. 两个宿主重新安装 Skill，使其命令参考指向新入口。
5. 确认一段时间后再自行处理旧目录；程序不会自动删除。
