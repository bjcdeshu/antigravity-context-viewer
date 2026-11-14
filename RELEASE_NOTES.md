# Release Notes — v3.0.1

## Antigravity Context & Token Viewer v3.0.1

### Highlights
1. **Antigravity `v2.32.1` Remote-SSH 与多层 `WebContentsView`（`catcherView` / `MCP Apps`）完整适配**
   - 适配 `v2.32.1` 全新内置的 Remote-SSH（`--agy-backend=ssh`、`dist/remote/windowBackends.js` 独立 `partition` 与 `ssh-prompt` 弹窗）：在 `preload.js`、`meter-main.js`、`local-api.js`、`install.js` 与 `cli.js` 全链路隔离远端 SSH 隧道窗口与本机窗口，避免向 SSH 远端窗口误注入本机账本或因远端 SOCKS 端口不可直连导致 CDP 热挂载报错。
   - 适配 `v2.32.1` 重构的三层视图栈（`clipView` + `hubWcv` + `catcherView` `data:text/html;charset=utf-8,...`）以及 `plugin://` MCP Apps 微应用视图过滤。

2. **`v2.32.1` 顶栏新增 `[data-testid="titlebar-more-actions"]` 按钮与菜单互斥适配**
   - 适配 `v2.32.1` 会话顶栏右侧工具簇新增的 `More actions`（含 Open on Phone 等入口）按钮宽度与间距计算，保证窄屏四级渐进折叠阈值精准无遮挡。
   - 展开上下文或 Token 面板时自动收起处于展开态的 `titlebar-more-actions` 下拉菜单，消除右上角浮层叠压。

---

# Release Notes — v3.0.0

## Antigravity Context & Token Viewer v3.0.0

### Highlights
1. **Antigravity `v2.31.2` 全量新模型目录与归档自愈（Gemini 4 Hydrogen & Orchestrator）**
   - 新增 `Gemini 4 Hydrogen`（`MODEL_PLACEHOLDER_M525..528`，`$1.50 / $0.075 / $7.50` 每百万 Token）与 `Orchestrator (Carbon / Argon)`（`MODEL_PLACEHOLDER_M667 / M681`）映射及官方 `$ USD` 计价目录。
   - 适配 `v2.31.2` `chatModel.responseModel` 与 `GetUserStatus` 双键配额匹配（`modelId` + `placeholder`），升级模型归因缓存至 `schemaVersion: 3`，自动清理历史归档中残留的 `unattributed` 桶缩放失真。

2. **`/swarm` 蜂群 · 子代理 · `/btw` 整树费用归并与 Top 主会话排行**
   - 串联本地 `.system_generated/swarm/members.json`、`.system_generated/subagents/*.json` 与宿主 `GetAllCascadeTrajectories`，建立多级子会话到根会话的传递闭包映射（`childToRoot`），保证全局日度 `dailyMap` 零重复计入。
   - 会话上下文面板新增子代理整树费用归并提示（无子代理时完全静默），Token 面板新增可展开的 **高消耗主会话排行（`topSessions`）**。

3. **`/compact` 检查点压缩感知与服务端实测上下文构成**
   - 优先解析 `chatStartMetadata.contextWindowMetadata.tokenBreakdown` 服务端实测分组（系统指令 / 工具定义 / 对话），并在发生 `/compact`（`CHECKPOINT`）压缩后准确切换至压缩点之后的活动窗口构成，同步呈现压缩次数与最近一次释放的 Token 量。
   - 按每轮对话真实发生日期（`dateKey`）对齐优惠期实价或标准零售价。

4. **Onyx 明暗双主题原生界面精简与宿主生命周期自愈**
   - 引入语义化 Onyx 明暗主题令牌桥接、无框顶栏指示器、高密度去框热力图与 `Quiet-by-Default` 状态收敛。
   - 主进程支持 `BaseWindow`（`base-window-created`）及 `data:` `curtainView` 遮罩过滤与 `hubWcv` 延迟挂载自愈；修复顶栏下移后的 WCO 占位残留；`restore.js` / `install.js` 支持 SHA-256 备份校验通过时的补丁归档哈希漂移恢复。

---

# Release Notes — v2.9.0

## Antigravity Context & Token Viewer v2.9.0

### Highlights
1. **真实多模型 API 等值估算引擎（Multi-Model API Equivalent Valuation）**
   - 对接本地会话 `GetCascadeTrajectoryGeneratorMetadata` 与 `GetUserStatus` 模型配置表，自动解析 `v2.31.0+` 内部模型占位符（`MODEL_PLACEHOLDER_M427/M437/M438` → `Gemini 4 Carbon`、`M417..M419` → `Gemini 4 Argon`、`M322` → `Gemini 3.1 Pro`、`M318..M320` → `Gemini 3.8 Flash`、`M400..M405` → `Claude Opus / Sonnet 5.5` 等），并与 `transcript.jsonl` 步级时间戳做一对一元组对齐。
   - 内置官方多模型单价表（输入 / 缓存读取 / 输出）及 `>200K` 长上下文阶梯计价，默认采用 **发生日官方优惠实价（`actual`，含 Google 2026.11–12 限时特惠）**，支持一键切换 **标准零售原价（`standard`）** 对比。

2. **全局 Token 面板四维 `$` 徽标与去边框「API 价值构成」微条 (`#h-cost-breakdown`)**
   - 顶部 **全量累计 / 今日使用 / 本月使用 / 年度使用** 4 张核心卡片右上角直接展示对应周期的 `$ USD` API 等值估算。
   - 区间汇总栏下方新增克制无框的 **API 价值构成条**：提供 `4px` 模型费用占比堆叠微条、主力模型金额与百分比图例、输入/输出/缓存成本拆分，以及 **Prompt Cache 缓存节省金额（`缓存省 $xxx`）** 高亮。

3. **当前会话实时 API 等值 (`#session-cost-summary`) 与 5 视图热力图气泡模型归因**
   - 会话上下文面板新增无框「本会话 API 等值」区块，基于已有请求轮询数据零额外开销计算 **会话累计等值、最近一轮费用、本会话缓存已省金额** 与轮次模型构成。
   - 5 视图热力图（每天 / 每周 / 每月 / 今年 / 累计总量）悬浮气泡新增当期主力模型费用占比与缓存节省额明细。

4. **归档持久化与跨版本热挂载稳定性加固**
   - 升级 `token_usage_archive_v3.json` 原子写盘（Write-Rename）与 `model_attribution_cache_v1.json` 增量缓存，剔除无关大目录扫描（`TRANSCRIPT_SKIP_DIRS`），热读取稳定在 `~35ms`。
   - 吸收历史同步重入补偿队列（`pendingHistoryForce`）、窗口标题栏主题同步去重（`lastSyncedOverlayKey`）与热升级跨进程模型归因保留逻辑。

---

# Release Notes — v2.8.0

## Antigravity Context & Token Viewer v2.8.0

### Highlights
1. **Direction B 视觉体系（Antigravity 原生克制 + Claude 暖调质感）**
   - 重构顶栏胶囊与双面板视觉层级：采用 `1px` 半透明细腻描边、毛玻璃胶囊与 **Quiet-by-Default（安静默认）** 交互准则，日常健康状态下隐藏冗余横幅，仅在上下文占用 `>= 80%` 或超限时展示预警。
   - 新增 **暖陶土（Terracotta，默认）** 与 **极简冷灰（Mono）** 两套热力图色阶预设（共 7 套色阶预设）。

2. **顶栏圆环胶囊常驻上下文用量显示**
   - 无需鼠标悬停，扫一眼顶栏即可直接读取当前上下文用量与百分比（宽屏 `195.5K (76%)`、中屏 `76%`、极窄屏平滑折叠为纯圆环）。

3. **上下文构成微缩拆解条与缓存命中率**
   - 核心用量卡片新增 6 段上下文构成微条（`#ctx-breakdown-bar`：工具 / 系统 / 用户 / 助手 / 思考 / 附件）与实时缓存命中率（`#ctx-cache-hit`）。

4. **5 视图全周期 Token 热力图 + 区间汇总底栏 (`#h-summary-bar`)**
   - 热力图新增 **每月（4×3 日历网格）** 与 **今年（12 个月定宽气泡图）** 视图，支持 `每天 / 每周 / 每月 / 今年 / 累计总量` 5 视图无缝切换。
   - 底部新增区间汇总统计栏（区间合计、净消耗/缓存比、活跃周期均值、API 等值参考 `≈ $X.XX`）。

5. **Antigravity `v2.30.0+` 双层顶栏与 `BaseWindow` (`hubWcv`) 完整适配**
   - 适配 `v2.30.0` 新增的 `35px` 顶部菜单栏 + `40px` 会话标题栏双层结构，以及 `electron.BaseWindow` + `WebContentsView` (`hubWcv`) 宿主架构与多生命周期保活。
   - 兼容单行回退态下 `@property --right-cluster-width`（`inherits: false`）的窗口控制区（`— □ ×`）防遮挡自愈。
   - 实现与原生 `Overview` 浮层的双向互斥与 `z-index` 动态抬升，彻底解决右上角浮层遮挡。
   - 新增细粒度错误分类（`classifyRequestError`），区分真实上下文溢出（`context_overflow`）与配额/限流/超时错误，防止非容量报错冲掉有效上下文百分比。
