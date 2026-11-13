# Antigravity 对话上下文查看器 & Token 用量看板 (Antigravity Context & Token Viewer)

<p align="center">
  <img src="https://img.shields.io/badge/Version-3.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Antigravity-2.31.2%2B-8B5CF6" alt="Antigravity 2.31.2+">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18.x-brightgreen?logo=node.js" alt="Node Version">
  <img src="https://img.shields.io/badge/Dependencies-Zero-success" alt="Zero Dependencies">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform Support">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

<p align="center">
  <b>简体中文</b> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.es.md">Español</a>
</p>

专为 **Google Antigravity 桌面客户端 (2.x / v2.31.2+)** 打造的原生级 **「单次会话上下文与主从会话树 API 等值监控 + 账号全局按模型归因 Token 5 视图热力图 + 模型实时输出速度监控」** 全功能可视化套件。采用 **ASAR 持久化注入 + CDP 免重启热挂载** 架构，**零第三方 npm 依赖**，既支持双击脚本一键安装，也支持直接交给任何 AI 智能体（Antigravity / Codex / Claude Code / Cursor）一句话自动部署。

---

## 🔥 v3.0.0 核心升级亮点 (What's New in v3.0.0)

1. **Antigravity `v2.31.2` 全量新模型目录与归档自愈（Hydrogen & Orchestrator）**：
   - 新增 `Gemini 4 Hydrogen`（`Low / Medium / High / XHigh`，`MODEL_PLACEHOLDER_M525..528`）与 `Orchestrator (Carbon / Argon)`（`MODEL_PLACEHOLDER_M667 / M681`）精确模型映射与官方 `$ USD` 费率；
   - 适配 `v2.31.2` `chatModel.responseModel` 与双键配额配置表（`modelId` + `placeholder`），自动升级模型归因缓存至 `schemaVersion: 3`，并无损清除旧版归档中残留的 `unattributed` 桶缩放偏差。
2. **`/swarm` 蜂群 · 子代理 · `/btw` 支线会话整树费用归并 & 主会话排行**：
   - 自动串联 `.system_generated/swarm/members.json`、`.system_generated/subagents/*.json` 与宿主 `GetAllCascadeTrajectories` 元数据，将子代理、`/swarm` Worker 与 `/btw` 支线问答的 Token 及 `$` 成本完整归并至所属主会话（全局热力图日度总量严格零重复累加）；
   - 当前会话面板实时展示主从整树合计费用与子代理明细，Token 面板新增可折叠 **「高消耗主会话排行（Top Sessions）」** 列表。
3. **`/compact` 检查点压缩感知与服务端活动上下文构成实测**：
   - 直接读取宿主 `chatStartMetadata.contextWindowMetadata.tokenBreakdown` 服务端实测构成（系统指令 / 工具定义 / 对话消息），并在 `/compact`（`CHECKPOINT`）压缩后仅统计仍在活动窗口内的步骤，同步展示压缩次数与最近一次释放的 Token 数；
   - 按每轮对话真实发生日期（`dateKey`）匹配限时优惠或标准零售费率，消除跨日长会话的计价偏差。
4. **Onyx 原生双主题桥接、无框精简热力图与 `BaseWindow` 生命周期自愈**：
   - 建立语义化 Onyx 明暗主题变量桥接，移除冗余内嵌卡片边框，重构顶栏无框数值指示器与 `Quiet-by-Default` 状态呈现；
   - 主进程新增 `BaseWindow`（`base-window-created`）与 `curtainView`（`data:` 遮罩层）精准过滤及 `hubWcv` 延迟挂载自愈，窗口控制按钮避让占位支持顶栏下移后自动清理，并在 `restore` / `install` 中支持 SHA-256 校验通过的补丁归档哈希漂移自愈。

---

## 📌 v2.9.0 既有核心特性回顾

1. **真实多模型 API 等值估算引擎（Multi-Model API Valuation）**：
   - 告别单一混合均价估算，直接对接宿主 `GetCascadeTrajectoryGeneratorMetadata` 与 `GetUserStatus` 模型目录，将每日及每轮 Token 精确归因至具体模型家族（`Gemini 4 Argon`、`Gemini 4 Carbon`、`Gemini 3.1 Pro`、`Gemini 3.8 Flash`、`Claude Opus 5.5 / 4.6`、`Claude Sonnet 5.5 / 4.6`、`GPT-OSS 120B` 等），并自动处理 `>200K` 长上下文阶梯单价；
   - 支持 **「优惠期实价（含 Google 2026.11–12 限时特惠）」⇄「标准零售价」** 一键切换对比。
2. **全局 Token 面板四维 `$` 徽标与无框「API 价值构成」微条 (`#h-cost-breakdown`)**：
   - 顶部 **全量累计 / 今日使用 / 本月使用 / 年度使用** 四大卡片同步展示各自周期的 `$ USD` API 等值；
   - 区间汇总栏下方新增去边框极简 **API 价值构成条**：包含 `4px` 按模型费用占比堆叠进度条、主力模型金额与占比图例、输入/输出/缓存三项成本拆分，以及醒目的 **Prompt Cache 缓存节省金额（`缓存省 $xxx`）**。
3. **当前会话实时 API 等值 (`#session-cost-summary`) 与热力图悬浮模型归因**：
   - 会话上下文面板新增无框「本会话 API 等值」模块，实时统计 **会话累计费用、最近一轮费用、本会话缓存已省金额** 与轮次模型占比，零额外网络轮询开销；
   - 5 视图热力图（每天 / 每周 / 每月 / 今年 / 累计总量）悬浮与点击气泡同步展示当期主力模型费用占比及缓存节省金额。
4. **增量归档性能与跨版本平滑保活加固**：
   - 新增 `token_usage_archive_v3.json` 原子写盘（Write-Rename）与 `model_attribution_cache_v1.json` 会话增量归因缓存，热读取耗时低至 `~35ms`；
   - 修复历史同步重入竞态（`pendingHistoryForce`）、窗口标题栏主题同步去重（`lastSyncedOverlayKey`）以及免重启升级场景下的跨进程模型归因保留。

---

## 📌 v2.8.0 既有核心特性回顾

1. **Antigravity 原生克制 + Claude 暖调高雅视觉（Direction B）**：
   - 采用 `1px` 细腻半透明描边、毛玻璃顶栏胶囊与 **安静默认（Quiet-by-Default）** 交互准则——日常健康状态下自动收敛冗余提示，仅在上下文占用 `>= 80%` 或超限时展示醒目预警；
   - 新增 **暖陶土（Terracotta）** 与 **极简冷灰（Mono）** 色阶预设（共 7 套预设）。
2. **顶栏圆环胶囊常驻上下文用量显示**：
   - 无需鼠标悬停，扫一眼顶栏即可直接看到实时上下文用量与占比（宽屏展示 `195.5K (76%)`，中屏紧凑展示 `76%`，窄屏平滑折叠为纯圆环）。
3. **上下文构成微缩拆解条（Context Breakdown Micro-bar）与缓存命中率**：
   - 核心用量卡片内置多段微缩比例条（工具调用 / 系统提示 / 用户消息 / 模型回复 / 思考内容 / 附件）与实时 **缓存命中率** 指标。
4. **5 视图全周期 Token 热力图 + 区间汇总底栏（`#h-summary-bar`）**：
   - 热力图由 3 视图升级为 **5 视图**：`每天（7×52 日历网格）`、`每周`、`每月（4×3 日历网格）`、`今年（12 个月定宽气泡图）`、`累计总量`；
   - 新增底部区间汇总统计栏（区间合计、净消耗/缓存比、活跃日均、按 Gemini 混合基准折算的 API 等值参考 `≈ $X.XX`）。
5. **Antigravity `v2.30.0+` 新架构完整适配与防遮挡自愈**：
   - 完整适配 `v2.30.0` 新增的 `35px` 顶部菜单栏 + `40px` 会话标题栏双层结构，以及 `electron.BaseWindow` + `WebContentsView` (`hubWcv`) 宿主架构；
   - 兼容单行回退态下 `@property --right-cluster-width`（`inherits: false`）的窗口控制区（`— □ ×`）防遮挡自愈；
   - 原生 `Overview` 浮层与插件面板互斥联动、动态抬升层级，彻底杜绝右上角浮层重叠遮挡；
   - 细粒度错误分类（`classifyRequestError`）：严格区分真实上下文超限（`context_overflow`）与配额耗尽、速率限制、网络超时等非容量错误，避免误清有效上下文数据。

---

## 🎬 界面与交互演示动画 (Video & Animation Previews)

本次 v2.7.2 版本提供 4 组涵盖全部交互层面的演示动画与高清录像：

### 1. 当前会话上下文监控与底层技术参数附件审计
> 演示文件：`01-当前会话上下文监控与底层技术参数附件审计.mp4`

点击顶栏环形胶囊呼出「当前会话上下文」面板，查看核心用量速览、最新生成速度耗时，展开并滚览底层技术参数、真实服务端口径校准、图片像素尺寸格式化（如 `561×179 像素`）与全格式附件审计明细：

<p align="center">
  <a href="assets/demo-01-context-audit.mp4">
    <img src="assets/demo-01-context-audit.gif" alt="当前会话上下文监控与底层技术参数附件审计" width="760">
  </a>
  <br>
  <sub>🎬 演示动画：会话上下文面板、速度监控与底层审计明细 (<a href="assets/demo-01-context-audit.mp4">高清视频：01-当前会话上下文监控与底层技术参数附件审计.mp4</a>)</sub>
</p>

---

### 2. Token 历史用量统计与 52 周活跃热力图交互
> 演示文件：`02-Token历史用量统计与52周活跃热力图交互.mp4`

点击顶栏 Token 累计胶囊弹出「Token 用量一览」面板，展示全量累计/今日/本月/年度 4 大维度用量卡片、52 周日历热力图，并在热力图方格之间移动悬停，即时呈现包含 Prompt/Output/Cache 或未来日期状态的原生 Tooltip 气泡：

<p align="center">
  <a href="assets/demo-02-token-heatmap.mp4">
    <img src="assets/demo-02-token-heatmap.gif" alt="Token 历史用量统计与 52 周活跃热力图交互" width="760">
  </a>
  <br>
  <sub>🎬 演示动画：Token 四维指标卡片与 52 周热力图悬浮气泡交互 (<a href="assets/demo-02-token-heatmap.mp4">高清视频：02-Token历史用量统计与52周活跃热力图交互.mp4</a>)</sub>
</p>

---

### 3. 独立双面板平滑切换与侧边栏防遮挡自适应
> 演示文件：`03-独立双面板平滑切换与侧边栏防遮挡自适应.mp4`

在开启右侧辅助栏（审查/文件/终端）的复杂布局下，面板智能计算右侧边界并贴边自适应停靠，杜绝内容裁切；通过点击顶栏不同胶囊即可在「Token 用量一览」与「当前会话上下文」之间顺滑切换：

<p align="center">
  <a href="assets/demo-03-panel-switching.mp4">
    <img src="assets/demo-03-panel-switching.gif" alt="独立双面板平滑切换与侧边栏防遮挡自适应" width="760">
  </a>
  <br>
  <sub>🎬 演示动画：侧边栏防裁切停靠与独立双面板无缝平滑互切 (<a href="assets/demo-03-panel-switching.mp4">高清视频：03-独立双面板平滑切换与侧边栏防遮挡自适应.mp4</a>)</sub>
</p>

---

### 4. 顶栏胶囊多级响应式折叠与窄屏自适应
> 演示文件：`04-顶栏胶囊多级响应式折叠与窄屏自适应.mp4`

当同时开启左侧项目侧边栏与右侧辅助栏导致主工作区宽度极窄时，顶栏右上角胶囊群触发 4 级阶梯平滑响应式折叠（从完整文本 -> 纯数字 -> 紧凑环形图标与更多菜单），始终不溢出、不破坏顶栏原生布局，且折叠状态下点击环形仍可完美唤起面板：

<p align="center">
  <a href="assets/demo-04-responsive-collapse.mp4">
    <img src="assets/demo-04-responsive-collapse.gif" alt="顶栏胶囊多级响应式折叠与窄屏自适应" width="760">
  </a>
  <br>
  <sub>🎬 演示动画：顶栏胶囊 4 级响应式阶梯折叠与紧凑态呼出 (<a href="assets/demo-04-responsive-collapse.mp4">高清视频：04-顶栏胶囊多级响应式折叠与窄屏自适应.mp4</a>)</sub>
</p>

---

## 📸 面板实拍与功能细节 (Screenshots & UI Details)

| 01. 会话上下文与生成监控主视图 | 02. 会话上下文全展开：外观调色与底层审计 |
| :---: | :---: |
| <img src="assets/panel-context-main.png" alt="会话上下文与生成监控主视图" width="460"> | <img src="assets/panel-context-audit-expanded.png" alt="会话上下文全展开面板" width="460"> |
| 置顶 **「⭐ 核心用量速览」**（当前已用、预算上限、剩余可用）与 **「⚡ 最新生成速度与耗时速览」**（输出速度 87.6 tok/s、生成耗时 10.12s、首字延迟 8.72s、本次输出 886 tok）；下方提供收起的调色抽屉与参数审计入口。 | 展开 **「🎨 指标与背景颜色自定义」**（支持面板统一 0 级背景跟随与指标色自定义）及 **「📋 底层技术参数与附件审计」**（服务端真实返回、本地全会话字符估算、图片像素尺寸与 token 审计、重新扫描入口）。 |

| 03. 顶栏环形胶囊、实时速度与原生气泡提示 | 04. Token 用量总览与 5 档热力图逐格独立自定义 |
| :---: | :---: |
| <img src="assets/capsule-speed-and-tooltip.png" alt="顶栏环形胶囊与气泡提示" width="460"> | <img src="assets/panel-token-heatmap-customizer.png" alt="Token 用量总览与热力图调色" width="460"> |
| 顶栏常驻圆环用量进度胶囊与 ⚡ 速度胶囊（如 `87.6 tok/s`）；鼠标悬浮弹出原生层级三层气泡 Tooltip，直观展示已用百分比、剩余百分比与精确 token 数量。 | 顶部四栏指标卡片展示 **全量累计 (Total)、今日使用 (Today)、本月使用 (Month)、年度使用 (Year)**；52 周热力图网格支持 **每天 / 每周 / 累计总量** 三视图；下方展开 **5 套色阶预设**、**5 档逐格独立调色** 与 **两端插值生成器**。 |

---

## ✨ 核心功能全景 (Comprehensive Features)

### 1. 顶栏环形进度指示器、常驻上下文用量与极速模型性能监控
- **原生暗色/浅色融合胶囊**：常驻顶栏右上角，采用 `1px` 细腻描边与毛玻璃质感；
- **圆环 + 常驻上下文用量指示器 (`#badge-context`)**：圆环旁直接常驻展示已用上下文与百分比（如 `195.5K (76%)`），无需悬停即可一眼读取；鼠标悬浮时弹出原生 3 层气泡 Tooltip；
- **实时输出速度胶囊 (`#badge-speed`)**：精确捕获模型最新生成的首字延迟 (TTFT)、纯流式解码速度 (tok/s)、总生成耗时与输出规模；
- **4 级阶梯响应式折叠**：当侧边栏挤压主窗口或分辨率受限时，自动平滑阶梯折叠（完整文本 → 百分比 → 纯圆环与更多菜单），绝不覆盖顶栏原有功能。

### 2. 解耦独立双面板、Overview 互斥联动与防遮挡自适应停靠
- **彻底解耦的双面板架构**：会话上下文面板与 Token 统计面板相互独立，通过点击顶栏胶囊直接呼出对应面板，并可在两面板间无缝切换；
- **原生 Overview 浮层互斥与层级提升**：打开插件面板时自动关闭原生 `Overview` 浮层并提升顶栏容器层级（`z-index: 2500`），反之点击原生 `Overview` 时自动收起插件面板，彻底杜绝重叠遮挡；
- **侧边栏防裁切自适应定位**：动态读取主视口与右侧辅助面板边界，在开启辅助栏时自动左移停靠，确保弹窗内容完整可见。

### 3. 会话上下文监控面板 (Panel A)
- **上下文容量与构成微缩拆解条 (`#ctx-breakdown`)**：首屏直接呈现**当前已用 / 预算上限 / 剩余可用**核心数值，内置 6 段构成微条（工具 / 系统 / 用户 / 助手 / 思考 / 附件）与实时**缓存命中率**；
- **Quiet-by-Default 安静默认准则**：日常健康状态下隐藏冗余横幅，仅在上下文高占用（`>= 80%`）或超限时显示醒目提示；
- **生成速度与延迟速览**：4 栏网格展示输出速度、生成耗时、首字响应延迟 (TTFT) 与本次产出 Token；
- **外观与配色自定义抽屉**：
  - 支持面板统一背景色（跟随主题或自定义 0 级深色）；
  - 支持圆环进度、文字、速度、累计 Token 等多槽位指标独立调色与一键恢复默认；
- **底层技术参数与全格式附件审计**：
  - **真实服务端校准与细粒度错误分类**：严格区分真实上下文超限（`context_overflow`）与配额耗尽、速率限制、网络超时等错误，非容量错误保留有效上下文数据；
  - **全会话本地估算拆解 & 附件逐项审计**：准确识别图片像素尺寸与 Office / PDF / 代码附件 Token 消耗，支持随时一键重新扫描。

### 4. 账号全局 Token 计数与 5 视图活跃热力图 (Panel B)
- **四大维度用量卡片**：全量累计 (Total)、今日使用 (Today)、本月使用 (Month)、年度使用 (Year)，支持净消耗与缓存占比展示；
- **五视图无缝切换**：支持 **「每天（7×52 日历网格）」、「每周（周度趋势）」、「每月（4×3 日历网格）」、「今年（12 个月定宽气泡图）」与「累计总量（增长面积图）」**；
- **区间汇总统计底栏 (`#h-summary-bar`)**：实时汇总当前视图区间的总 Token、净消耗/缓存比、活跃日均（或周均/月均）以及按 Gemini 混合基准折算的 API 等值参考（`≈ $X.XX`）；
- **🎨 7 套色阶预设 + 5 档逐格独立自定义 + 两端插值**：
  - **7 套整套预设**：暖陶土（Terracotta，默认）、极简冷灰（Mono）、紫色系、黄色系、绿色系、蓝色系、红色系一键应用；
  - **5 档逐格独立自定义**：右下角「少 ▢▢▢▢▢ 多」图例的 5 个格子均可直接点击弹出调色盘；同时在抽屉内提供 1 档~5 档独立色块微调与单档重置；
  - **两端线性插值**：支持仅设置「少端色」与「多端色」，自动平滑插值生成中间梯度（单格独立自定义 > 两端插值 > 整套预设）。

---

## 🌐 界面语种与多语言翻译说明 (UI Localization & Multi-Language)

本项目默认界面文案为 **简体中文**。如果你需要插件界面（顶栏胶囊文案、详情面板与热力图提示）显示为你自己的母语（例如 **English / 日本語 / 한국어 / Español** 或任意其他语言）：

> [!TIP]
> **无需安装额外多语言包，也无需手动修改配置文件！**  
> 只需要把本仓库交给你的 AI 智能体（Antigravity / Claude Code / Codex / Cursor）安装时，对它说一句：  
> **“读取 AGENTS.md 帮我安装，并把界面文案翻译成 [你的目标语言，如 English / 日本語 / 한국어 / Español]”**  
> 
> AI 就会自动解析 `meter-renderer.js` 中的 UI 文本，将其无损替换为对应语言并执行安装热注入，免重启即刻呈现本地化界面。

---

## 🤖 给 AI 智能体的一键安装指令 (For AI Agents)

如果你将本仓库交给 AI 助手安装，只需对 AI 说：**“读取仓库里的 `AGENTS.md` 或 `README.md`，帮我安装这个上下文查看器与 Token 看板”**。

AI 智能体只需在仓库根目录执行以下单条命令即可完成**持久化安装 + 当前运行窗口免重启热生效**：

```bash
# 1. 一键持久化安装并热注入当前运行中的 Antigravity 窗口（无需强杀进程、无需 npm install）
node cli.js install

# 2. 验证安装与运行状态
node cli.js status
```

> [!IMPORTANT] **AI 智能体执行规范（见 [`AGENTS.md`](AGENTS.md)）**：
> - **零外部依赖**：内置原生 Node.js ASAR 解包/封包引擎（[`asar-engine.js`](asar-engine.js)），无需执行 `npm install`。
> - **与汉化补丁 100% 兼容**：基于当前 `app.asar` 原位无损注入，完整保留已安装的 `antigravity-chinese` 汉化词库与补丁。
> - **严禁强杀宿主进程**：在 Antigravity 会话内执行时，切勿关闭或杀死 `Antigravity.exe`；`node cli.js install` 会自动通过 `DevToolsActivePort` 将最新 UI 热挂载到当前窗口，1 秒内即时生效。

---

## 🚀 快速开始 (Quick Start)

### 方式一：一键脚本（适合日常手动安装）

- **Windows**：
  - 安装 / 更新：双击运行 [`install.bat`](install.bat)
  - 卸载 / 还原：双击运行 [`uninstall.bat`](uninstall.bat)
- **macOS / Linux**：
  - 安装 / 更新：`./install.sh`
  - 卸载 / 还原：`./uninstall.sh`

### 方式二：CLI 命令行管理器

```bash
# 1. 环境健康预检（自动探测 Node、Antigravity 安装路径、CDP 端口与 Python）
node cli.js check

# 2. 一键安装（ASAR 持久化注入 + 当前运行窗口 CDP 即时热生效）
node cli.js install

# 3. 仅对当前运行窗口进行 CDP 免改盘热挂载
node cli.js live

# 4. 查看当前安装状态与实时会话上下文用量
node cli.js status

# 5. 一键无损还原安装前的原始 app.asar
node cli.js restore

# 6. 指定自定义客户端路径安装
node cli.js install --path "D:\YourPath\Antigravity\resources\app.asar"
```

---

## 🧪 自动化测试 (Testing)

```bash
npm test
# 或直接运行：
node --test meter-core.test.js meter-renderer.test.js
```

包含 44 项针对多模型 API 等值计价（优惠期实价 vs 标准零售价、`>200K` 分档、Prompt Cache 节省额与多轮会话成本）、Token 缓存去重、服务端超限与细粒度错误分类、异步会话切换防串染、5 视图热力图与区间汇总底栏、7 套色阶预设与 5 档独立自定义、原生 Overview 浮层互斥、双层/单行顶栏自适应及双面板定位的完整回归测试。

---

## 📁 仓库结构 (Repository Structure)

```text
antigravity-context-viewer/
├── assets/                                 # 演示动图、高清录屏与实拍截图
│   ├── demo-01-context-audit.gif / .mp4    # 演示 1：会话上下文监控与底层技术参数附件审计
│   ├── demo-02-token-heatmap.gif / .mp4    # 演示 2：Token 历史用量统计与 52 周活跃热力图交互
│   ├── demo-03-panel-switching.gif / .mp4  # 演示 3：独立双面板平滑切换与侧边栏防遮挡自适应
│   ├── demo-04-responsive-collapse.gif/.mp4# 演示 4：顶栏胶囊多级响应式折叠与窄屏自适应
│   ├── panel-context-main.png              # 实拍 1：会话上下文与生成监控主视图
│   ├── panel-context-audit-expanded.png    # 实拍 2：会话上下文全展开：外观调色与底层审计
│   ├── capsule-speed-and-tooltip.png       # 实拍 3：顶栏环形胶囊、实时速度与原生气泡提示
│   └── panel-token-heatmap-customizer.png  # 实拍 4：Token 用量总览与 5 档热力图逐格独立自定义
├── asar-engine.js                          # 零外部依赖的纯原生 Node.js ASAR 打包/解包引擎
├── cli.js                                  # 统一命令行接口 (install / live / status / check / restore)
├── install.js                              # ASAR 注入与运行时热挂载调度器
├── restore.js                              # 原始备份校验与无损还原调度器
├── meter-main.js                           # Electron 主进程窗口钩子与只读 IPC 通道
├── meter-core.js                           # 上下文估算、Token 统计与分词引擎
├── meter-renderer.js                       # 顶栏环形双胶囊、解耦双面板、5档热力图自定义渲染器
├── meter-collector.js                      # 本地会话归档读取与附件提取收集器
├── attachment_scan.py                      # 全格式附件只读分析核心脚本 (Office / PDF / Code)
├── AGENTS.md                               # AI 智能体专用一键安装与校验指南
├── install.bat / install.sh                # 一键安装入口脚本
└── uninstall.bat / .sh                     # 一键卸载与还原入口脚本
```

---

## 🤝 社区与支持 (Community & Acknowledgements)

- **[LINUX DO](https://linux.do/)**：本项目支持并认可 LINUX DO 社区，欢迎各位社区佬友交流探讨。
