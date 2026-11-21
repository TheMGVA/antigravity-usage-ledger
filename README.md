# 多来源用量监控 (usage-ledger)

适用于 **Google Antigravity** 的跨平台多来源账单伴侣插件（完整兼容 **macOS / Windows / Linux**）。

> [!IMPORTANT]
> **前置必读：本插件建立在 [Usage & Speed Monitor (`usage-monitor`)](https://github.com/yuhuan-dev/antigravity-usage-monitor) 插件的基础之上。**
> 请务必**第 1 步先安装并启用 [antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)**，**第 2 步再安装本插件**。本插件只读读取 `usage-monitor` 生成的本机轨迹缓存与实时接口（不会改动原插件任何文件），内置前置环境自动检测与实时总账一致性校验。

---

## 核心特性

1. **全自动来源识别 + 规格自定义 + 拖拽排序**
   - 安装即用，自动识别本机所有历史与当前登录邮箱及 `Vertex API` 通道，生成独立账单卡片；当前登录账号卡片与胶囊自动微光高亮。
   - 每张卡片支持点击 **「规格」** 自定义显示名称、套餐档位徽章（如 `Ultra 20x` / `Ultra 5x` / `Pro` / `Free`）与主题色，并支持按住卡片头部 **`⠿`** 拖拽自由排序。
2. **自由勾选部分来源 + 分钟级自定义日期时段**
   - 每张来源卡片左上角配有勾选框 **`✓`**，支持自由组合任意部分来源计算总金额。
   - 除内置的 `全部 / 当前周期 / 今日 / 24 小时 / 近 7·14·30 天 / 自然周` 外，支持 **📅 自定义日期时段（精确到分钟）**。
3. **Gemini / Claude 分开显示 + 自定义倍率 + Vertex 原价计费**
   - 支持分列展示 **Gemini 系列** 与 **Claude 系列** 费用及占比，并可分别调整倍率（默认 `Gemini 1x`、`Claude 3x`，也支持自由输入任意倍率），总金额按 `Gemini 折算 + Claude 折算` 实时汇总。
   - 默认开启 **`Vertex API（如GCP赠金）按原价计费`**，一键切换标准原价与促销折算口径。
4. **与 `Usage & Speed Monitor` 实时总账核对 + 前置插件检测**
   - 内置前置插件状态检测（未安装或未生成缓存时自动提示引导）。
   - 实时连接本机 `usage-monitor` 接口交叉比对各时间窗口的 `1x` 基准金额与调用次数，顶部直观显示 **`✓ 与 Usage 插件实时一致`**。
5. **按项目分账双视图 + 多维会话排序 + 归档/已删除标记**
   - 自动实时同步最新项目名称与会话重命名，支持一键切换 **「💬 按会话」** 与 **「📁 按项目」**（查看各项目总消耗、Gemini/Claude 拆分及项目内的分来源构成）。
   - 自动标记 **`📦 已归档`**、**`🗑️ 已删除`** 与 **`📁 项目名`** 胶囊；支持按 `最新时间 / 创建时间 / 总金额 / Gemini 金额 / Claude 金额 / 累计 Token / 调用次数` 升降序排列，并支持一键导出 Markdown 对账单。
6. **可选同一账号按时段拆分**
   - 如同一邮箱经历过「免费试用期」与「正式订阅期」，可在右上角 **「时段拆分」** 中新建自定义分组并添加或编辑起止时间切分规则。

---

## 安装步骤（跨平台安装即用）

### 第 1 步：先安装前置插件 `Usage & Speed Monitor`
前往前置插件官方仓库安装并启用 **[yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)**（Antigravity 自带 Node.js 运行时，无需额外安装任何依赖）。

### 第 2 步：安装本插件 `usage-ledger`

#### 方式 A：命令行一键克隆安装（推荐，后续可直接 `git pull` 更新）

**macOS / Linux**：
```bash
git clone https://github.com/TheMGVA/antigravity-usage-ledger.git ~/.gemini/config/plugins/usage-ledger
```

**Windows (PowerShell)**：
```powershell
git clone https://github.com/TheMGVA/antigravity-usage-ledger.git "$env:USERPROFILE\.gemini\config\plugins\usage-ledger"
```

#### 方式 B：下载 ZIP 解压安装

前往 [Releases](https://github.com/TheMGVA/antigravity-usage-ledger/releases/latest) 下载 `usage-ledger.zip` 并解压为 `usage-ledger` 文件夹（确保 `plugin.json` 直接位于 `usage-ledger/` 根目录下），放入对应系统的插件目录即可自动加载：
- **macOS / Linux**：`~/.gemini/config/plugins/usage-ledger`
- **Windows**：`%USERPROFILE%\.gemini\config\plugins\usage-ledger`

安装后在 Antigravity 右侧边栏顶部点击 **`+`**，选择 **「多来源用量监控」** 即可打开实时面板。

---

## 数据与隐私说明

- **100% 本地只读运行**：所有统计计算均在本机离线完成，不修改 `usage-monitor` 任何文件，也不向任何外部服务器上传数据。
- **零个人配置打包**：插件仓库内不包含任何个人账号或规则配置；每位用户自定义的规格标签、倍率偏好与时段规则均独立保存在各自设备本地的 `sidecar_data/usage-ledger/` 目录中。

---

## 开源协议与致谢

基于 [GNU General Public License v3.0 (GPL-3.0)](LICENSE) 开源。前置数据源、基础图标元素与默认回退价格目录衍生自 [yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)。
