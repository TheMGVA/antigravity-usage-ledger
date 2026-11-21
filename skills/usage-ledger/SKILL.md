---
name: usage-ledger
description: 查询并导出按账号、免费试用期、正式订阅及 Vertex API 拆分的实时 API 等效消耗金额、项目分账与会话分段对账单，并与 Usage Monitor 插件总账自动核对。当用户询问多来源用量监控、分账号费用、项目消耗或要求导出对账单时使用。
---

# 多来源用量监控 (usage-ledger)

本技能配合 `usage-ledger`（多来源用量监控）插件使用，在不修改原有 `usage-monitor` 插件任何文件的前提下，自动只读读取本机轨迹缓存、登录态、归档标注与工作区目录，输出与 `usage-monitor` 总账零误差对齐的分来源与分项目费用统计。

## 1. 打开侧边栏实时面板

当用户希望在右侧面板实时查看多来源用量监控（且 `usage-ledger` Sidecar 已启用运行）时，可输出侧边栏快捷胶囊：

```markdown
[多来源用量监控](sidecar://usage-ledger/panel/)
```

## 2. 命令行快速拉取实时对账数据

跨平台兼容 macOS / Linux / Windows：

**macOS / Linux**：
```bash
node "$HOME/.gemini/config/plugins/usage-ledger/sidecars/panel/cli-report.mjs" --range=all --markdown
```

**Windows (PowerShell)**：
```powershell
node "$env:USERPROFILE\.gemini\config\plugins\usage-ledger\sidecars\panel\cli-report.mjs" --range=all --markdown
```

常用参数：
- `--range=all|cycle|today|24h|7d|14d|30d|nat_week`：指定时间窗口（默认 `all`）。
- `--markdown`：直接输出格式化 Markdown 对账单表格（省略则输出完整 JSON 快照）。
