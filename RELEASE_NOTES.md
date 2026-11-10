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
