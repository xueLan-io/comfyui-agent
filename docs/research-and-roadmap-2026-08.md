# ComfyMuse（comfy-agent）体量 / 进度调研报告 与 重大能力新研发计划

> 调研日期：2026-08-14 ｜ 基线：`HEAD 79c896f`（v0.3.7-rc.1）+ 工作树在途改动
> 说明：本报告基于代码逐文件盘点（src/agent 92 文件、electron/ 15 文件、tests/ 131 文件）、git 历史、双份独立评审文档，以及在调研期间观测到的实时工作树变化。

---

## 第一部分 · 项目体量与能力现状

### 1.1 规模数字（实测）

| 维度 | 数值 |
|---|---|
| 仓库历史 | 28 commits，2026-08-04 首次提交 → 2026-08-12 HEAD |
| 发布节奏 | v0.2.1(08-05) → v0.3.0~v0.3.5(08-07 同日批量) → v0.3.6(08-08) → v0.3.7-rc.1(08-12) |
| 代码总量 | 约 555 个源文件，约 7.4 万行（不含 node_modules/数据） |
| src/ | 333 文件 / 51,892 行（agent 92 文件 16,907 行；components 161 文件 20,738 行；runtime 60 文件 2,661 行） |
| electron/ | 15 文件 / 5,063 行（main.mjs 单文件 3,826 行 / 184 KB） |
| tests/ | 131 文件 / 12,461 行；**899 tests / 892 pass / 0 fail / 7 skipped**（当前工作树实测） |
| scripts/ docs/ workflows/ | 21 文件 / 2,932 行；5 文档；5 个示例工作流（img2img/inpaint/upscale/wan_txt2video/minimax_h3_amd_smoke） |
| 大型数据/样式 | App.css 345 KB（约 8,125 行）、prompt-library-artists.mjs 363 KB、provider-templates.js 63 KB（约 260 个提供商模板） |
| 发布产物 | ComfyMuse-portable-v0.3.7-rc.1.zip 约 151 MB；CI 产出便携包+应用更新包+Ed25519 签名 manifest+SHA256SUMS |
| 技术栈 | Electron 33 / React 18 / Vite 5 / Node ESM / 自带测试器 / GitHub Actions（Windows） |

### 1.2 能力分层盘点（端到端已验证）

**Agent 运行时（src/agent/runtime/）**
- 用户请求全链路：`handleTurn → routeIntent →（cancel/clarify/suggest/chat/prepare）→ planner（150s deadline）→ prompt 编译 → freezeRuntimeRequest → 确认 → run → 观察 → 重试/重规划`。
- 意图路由：约 20 条确定性正则 + LLM 分类器（temperature 0，流式早停），无模型时有 fallback。
- 状态机：16 状态任务机（`task-manager.mjs` TASK_TRANSITIONS）+ 前端生成状态机（IDLE/PREPARING/PREVIEW/RUNNING/…）。
- 重试/评估：RetryPolicy 3 次/步、8 次/任务；evaluator 技术检查 + 可选视觉打分；重规划上限 2。
- 上下文管理：会话归档 ≤12 段、LLM 摘要压缩、本地降级重试（上下文 38%/25%/16%）、空闲预取。
- 新增 `chat-prompt.mjs`（在途）：本地/云端双系统提示词、核心运行规则、身份边界（防冒充）、人格 append/replace 与占位符注入。

**LLM 层（src/agent/llm/）**
- 路由策略 auto/local/cloud/manual；健康缓存 10s TTL；本地串行锁；降级与云端策略门（正则策略：色情/未成年/暴力/自残/非法指令）；`reasoning_effort` 预算膨胀；图像模型（OpenAI 兼容）独立于聊天池。

**工具层（src/agent/tools/，每工具带 schema + 副作用/确认/幂等契约）**
- comfyui：preflight（模型/显存/ffmpeg）、适配器（sdxl/flux/animatediff/wan/minimax-h3）、workflow 读/补丁/变异（preview-commit-rollback + revision 存储）、运行时参数、队列/状态/历史/object-info、取消/中断（需确认）、image-inspect。
- filesystem：白名单根 {workflow,project,input,output,temp}，mutation 仅 write/edit/apply_patch，预览默认 + expectedHash 冲突校验 + 原子写回滚。
- prompt：enhance 8 种模式、token 预算 guard、视频模板；prompt-library（本地 Danbooru TSV）。
- web：SSRF 强防护（协议白名单、DNS 复核钉 IP、重定向逐跳重验、2MiB 双上限）；system：状态/模型/队列/日志。
- 执行器 fail-closed：每步 `sandbox.assertToolCall`，`filesystem_mutate.execute` 只能由可信 context 置位。

**Skills / 插件 / 治理**
- Skills：8 内置 + 6 高频 + 自定义 + 外部声明式 manifest（仅限 prompt_enhance/comfyui，白名单参数）。
- 插件宿主已存在（`src/runtime/plugins/`：contract/host/registry，能力面 tools/services/skills/ipc/ui）——**无 UI、未接入 Electron 运行时**。
- 治理层（admission-controller/operation-gateway/policy-engine/quota/rate-limiter/retention/audit/session-registry）完整，但**目前只接入 CLI**，Electron worker 未使用。

**Electron / 发布**
- 出进程 agent worker（utilityProcess + Windows Job Object 整树管理）、持久 RequestLedger（2,000 上限/30 天 TTL/重启恢复）、comfyui-manager（portable 自动探测/拉起/下载 nvidia|amd|cpu）。
- 双窗口（主窗+悬浮快速生成窗，Ctrl+Shift+Space）、托盘、错误上报、恢复面板；preload 约 150 个 invoke 通道 + 20 个事件。
- 更新链路：Ed25519 签名 manifest + SHA-256 校验 + updater 原子替换；CI 完整流水线（test/lint/build/签名/发布）。

### 1.3 工程文化与质量信号

- **双份严格评审**：commit-95762c3 评审（88 条发现，41 高 / 47 中，每条带 file:line 证据）；security-review-2026-08（新增 N-01~N-09、T-01~T-12，并对 88 条逐条复验：19 条确认已修复、7 条仍存在、62 条未复验，另含"确认良好"清单）。评审风格：只记可由代码证明的问题，编号跟踪到修复。
- **测试纪律**：899 测试全绿（实测当前工作树），lint 276 文件通过，构建通过；覆盖状态机、会话隔离、治理准入、生成契约、工作流读/补丁/变异、提示词库、视频等。测试名即契约（governance-admission、generation-contract、confirmation-binding、trace-owner）。
- **测试盲区（评审自认）**：`planner.mjs` 仅间接覆盖；UI 层零测试；并发/退出/恢复/归档竞态基本不在覆盖内；`DEFAULT_RPC_TIMEOUT_MS=900000`（15 分钟）使 RPC 超时路径几乎不可达（无 fake-worker/fake-ComfyUI harness）。
- 仓库卫生：无 TODO/FIXME 残留、.gitignore 完整、发布产物不入库。

---

## 第二部分 · 开发进度评估

### 2.1 生命周期判断

- 公开叙事：v0.3.7-rc.1 发布说明声称“项目已进入低维护状态，后续按需发布”。
- **实测结论：项目实际处于活跃开发期。** 调研期间（约 1 小时内）工作树持续变化：
  - 文件在 00:40–00:56 期间以每 1–2 分钟一个的速度被写入（chat-vision → agent → executor → filesystem → web → comfyui → mcp → cli → preference → ipc-gateway → main.mjs → 对应测试）。
  - 改动集合从首次检查的 32 个修改文件增长到 37 个修改 + 4 个未跟踪文件。
  - 写入内容与 security-review-2026-08 的“待修复清单”逐项对应（N-05 safeStorage fail-closed、T-02/T-03 executor fail-closed、F-54 ipc-gateway 默认 fail-closed、N-01 verifiedManifest 等）；`executor.mjs` 中 T-02/T-03 修复已在代码中确认落地。
  - 结论：**另一开发进程正在实时执行安全评审修复清单**（两路独立观测一致：本报告与并行子代理均观察到改动集合从 32→38 个修改文件、测试从 3 处失败回到全绿），且完成后测试回到全绿（899/892/0/7）。

### 2.2 在途功能（未发布）

1. **提示词人格系统**：`chat-prompt.mjs` + `PromptPersonalitySettings.jsx` + `chat-prompt.test.mjs`（全局/按项目覆盖、append/replace、占位符、实时预览、身份边界护栏）；agent.mjs 已改为调用 `buildChatSystemPrompt`。
2. **安全加固批量**（占在途 diff 主体）：N-01 verifiedManifest 单信任源 + version 白名单 + HTTPS 强制；N-02 publicLLM；N-03 窗口导航加固 + sandbox:true；N-05 加密 fail-closed；T-01 chat-vision 沙箱 + 10 MiB 上限；T-02/T-03 executor fail-closed；T-04 代理/密钥从 LLM 可见面移除；T-06/T-07 上传/视图引用约束 + WS 缓冲上限；T-08 输入长度上限；T-09 MCP 过沙箱；F-54 ipc-gateway 默认拒收；F-09 doctor 退出码。测试与修复同步落地。
3. **提供商模板扩展**：provider-templates.js +283 行（约 150–260 个模板 + 选择器 UI）。⚠ 质量风险：疑似包含 LLM 生成的“填充条目”（如 WeChat LLM、Shopee LLM、Turkcell/Orange/AmX 系列）与无运行时处理器的 `type`（aws-bedrock、azure-openai、cloudflare-gateway、google-vertex、snowflake-cortex 等），发布前需清洗。
4. 提示词库 v6（收集词库 schema v3、IndexedDB 分桶搜索索引）、MiniMax H3 视频模板（director 模式、时间线校验器）、通知设置等。

### 2.3 遗留短板（新研发的机会窗口）

| # | 短板 | 代码位置 | 影响 |
|---|---|---|---|
| 1 | **无跨会话长期记忆** | memory/conversation.mjs（100 条上限）、session 级 contextArchive | 记忆不沉淀，换会话即失忆 |
| 2 | **严格串行、单任务** | agent.mjs `_enqueue/_drainQueue` | 无批量/队列自主生产 |
| 3 | **单模型路由、无编排** | llm/provider.mjs `_route`；cloud-policy-router 仅正则 | 无按子任务选模、无并行多模 |
| 4 | **无真正的 agentic 图像编辑闭环** | evaluator.mjs（单次浅打分）、无掩码合成 | “看图改图”能力弱 |
| 5 | **插件/治理层未接入 Electron** | 仅 src/cli/agent-cli.mjs 使用 governance/plugin-host | 双轨架构，能力浪费 |
| 6 | **GUI 确认绑定无摘要** | agent.mjs TURN_CONFIRM 正则 | 与 MCP digest 校验不一致，纵深不足 |
| 7 | **Skill 仅模板** | skills/external.mjs | 无过程式/链式技能 |
| 8 | **无语音/音频输入** | — | 无 ASR 触点 |
| 9 | **持久化整文件 JSON 重写** | memory/store.mjs（tasks 上限 200、归档 ≤12 段） | 长程使用天花板 |
| 10 | **单体文件** | agent.mjs 162 KB、main.mjs 184 KB、AgentContext.jsx 2,234 行、App.css 345 KB | 变更风险/并发冲突高 |
| 11 | **无渲染层测试** | tests/ 仅核心逻辑（planner 间接覆盖、UI 零覆盖、并发/恢复路径盲区） | UI 回归无防护 |
| 12 | **UI 体验缺口** | 无灯箱画廊/无工作流画布/无多视图布局；ProjectSidebar.jsx 孤儿重复组件 | 影响“创作工作台”定位 |
| 13 | **i18n 仅 zh/en 且大量硬编码中文** | I18nContext.jsx + 组件内字符串 | 扩展语种成本高 |
| 14 | **provider 模板含未清洗数据** | provider-templates.js（疑似生成填充条目 + 无处理器 type） | 用户配置到不可用服务 |
| 15 | **无单一任务所有权**（round-4 评审根因） | “RPC 只是传输层，不能充当任务生命周期管理器” | 恢复/归档竞态的根因 |
| 16 | **发布面窄：Windows-only、无自动更新** | electron-builder.yml 仅 NSIS x64；更新需用户进设置手动点 | 运维与分发达不到产品级 |

---

## 第三部分 · 重大能力新研发计划

### 3.1 战略判断

ComfyMuse 的**差异化资产是“能力平台”**：agent 规划/执行/治理 + 工具契约 + Skills + 插件宿主 + MCP + CLI 已相当完整且经过严格安全评审。下一步“重大能力”应当：

1. **复用而非重建**：所有候选能力都应建立在现有 planning/sandbox/governance/plugin 契约之上；
2. **先补地基再盖楼**：双轨架构（治理/插件只进 CLI）、GUI 确认无摘要、单体文件，是后续一切重大能力的结构性障碍；
3. **旗舰能力要用户可感**：选择能显著改变“创作工作流体验”的方向，而不是堆砌工具。

### 3.2 候选能力评估矩阵

| 候选能力 | 用户价值 | 可行性 | 工作量 | 结构性前置 | 结论 |
|---|---|---|---|---|---|
| A. 长期记忆与创作知识系统 | 高（粘性） | 高（归档/压缩/会话设施齐备） | 中 | 小 | **旗舰 1** |
| B. 批量创作流水线（队列编排+自动策展） | 高（专业用户） | 中高（batch skill/queue/task 已有） | 中大 | 中（需调度器） | **旗舰 2** |
| C. 插件/技能生态（UI+SDK+市场） | 中高（生态壁垒） | 中（plugin-host/external skill/MCP 已有） | 高 | 大（接 Electron） | 长期目标 |
| D. 架构重构与治理接通（拆单体、digest 确认、渲染层测试） | 低（间接） | 高 | 高 | — | **地基，先行** |
| E. 多模态升级（语音输入、灯箱、画布、多视图） | 中高 | 中高 | 中高 | 小 | 可穿插 |
| F. 多模型编排与 LLM 审核 | 中 | 中（provider 已分层） | 中 | 小 | 可穿插 |

### 3.3 推荐路线图

**P0 · 收尾与地基（第 1–2 周）——发布 v0.3.8 并解除结构债务**
- 目标：让安全修复与在途功能（人格系统、提供商模板）合入发布；把“双轨”收敛为单轨。
- 范围：
  1. 完成 security-review-2026-08 待修复项（T-01~T-09、N-03~N-05、F-09/F-54 等），以评审表闭环为准；
  2. 治理层（operation-gateway/admission/quota/audit）接入 Electron worker 与 GUI 生成路径；GUI 确认绑定改为 digest（与 MCP 对齐）；
  3. 拆分 `agent.mjs`：按 对话/规划执行/生成装配/会话 四域拆模块（保留行为快照测试）；
  4. 引入渲染层测试骨架（Vitest + Testing Library 或 Node test + jsdom），为首批 3–5 个关键组件建冒烟测试；
  5. 清理孤儿 `ProjectSidebar.jsx` 等重复件；修正 i18n 硬编码抽查。
- 验收：899+ 测试绿、lint/build 绿；评审表全部关闭或显式延后；GUI 与 MCP 确认语义一致。

**P1 · 旗舰 A：长期记忆与创作知识系统（第 3–6 周）**
- 目标：跨会话沉淀“这个用户/这个项目怎么创作”，显著提升助手粘性与成片一致性。
- 范围：
  1. 记忆 schema：项目级（风格偏好、常用工作流、常用参数、角色卡、禁用项）+ 用户级（语言、模式偏好）；
  2. 沉淀管线：会话结束/里程碑时把 contextArchive 摘要 → 结构化记忆（复用 `_compactConversationSegment` 设施），去重与版本化；
  3. 检索注入：`buildChatSystemPrompt` 增加 `memory_context` trust 块（复用 chat-prompt.mjs 占位符机制），检索按相关性 Top-K；
  4. 记忆 UI：设置页“记忆”分区（查看/编辑/删除/清空），角色卡编辑器（复用 PromptPersonalitySettings 交互范式）；
  5. 隐私与治理：记忆属于用户数据，提供一键清空与导出；沙箱/云策略对记忆内容同样生效（记忆注入云端前过 cloud-policy-router）。
- 验收：新建会话后能召回旧会话的关键偏好（E2E 场景脚本）；记忆读写有测试覆盖；删除/清空路径可审计。

**P2 · 旗舰 B：批量创作流水线（第 7–10 周）**
- 目标：把“一次一张”升级为“一次一批、自动策展”，服务画师/工作室场景。
- 范围：
  1. 调度器：复用 governance 的 rate-limiter/quota 实现队列调度（seed 矩阵、参数组合、batch 上限、暂停/取消/断点续跑）；改造 `_enqueue/_drainQueue` 为可持久化任务队列；
  2. 批量任务 UI：进度/成功失败/取消面板、单任务重试、组合参数编辑器（复用 NodeControlsPanel schema 驱动）；
  3. 自动策展：evaluator 批量化（逐张技术分+视觉分，Top-K 推荐），支持“满意/重试/换种子”批量操作（复用 GenerationRecordCard）；
  4. 结果对比：并排 A/B（补灯箱基础能力，见 E）。
- 验收：100 张批量任务可排队、暂停、续跑、策展；quota/审计在批量路径生效；崩溃后队列可恢复。

**P3 · 生态：插件/技能市场（第 11–16 周，可滚动）**
- 目标：把已有 plugin-host/external-skill/MCP 沉淀为可持续扩展生态。
- 范围：
  1. 插件宿主接入 Electron（P0 前置的成果直接复用），补插件生命周期 UI（列表/启用/禁用/安装/卸载/更新）；
  2. 插件签名与沙箱强化：manifest 签名校验（复用 Ed25519 基础设施）、能力权限声明 UI（沿用 plugin-contract 的 permissions）；
  3. 外部技能编辑器：声明式 skill 可视化构建（target/workflow/参数），替代手写 JSON；
  4. Skill 链：允许 skill 组合（顺序/条件），仍限安全白名单工具。
- 验收：第三方声明式插件可在 UI 安装并受权限约束；skill 链测试覆盖；发布插件指南文档。

**持续工程红线（贯穿 P0–P3）**
- 每个里程碑：`npm test`（≥899 且全绿）、`npm run lint`、`npm run build`、安全评审（对照既有评审表）；
- 新增对外能力一律走工具契约 + fail-closed 沙箱；确认一律 digest；云端外发一律过策略门与用户披露；
- 新 UI 字符串全部进 i18n（zh/en）；持久化上限问题（短板 9）在 P1 前评估增量存储方案。

### 3.4 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| “低维护状态”战略摇摆 → 新能力无人长期维护 | 高 | 先决策：若要执行本计划，需明确维护承诺与发布节奏（建议双周 RC）；否则仅做 P0 |
| 并发开发冲突（已观测到另一进程在写同一工作树） | 高 | 建立分支/提交纪律，避免多人同树直接编辑；先合入当前在途修复再开工 |
| provider 模板数据质量（填充条目/无处理器 type） | 中 | 发布前清洗：删除无运行时处理器条目、对剩余条目做端到端冒烟 |
| 单体拆分回归 | 中 | 拆分前先有行为快照测试（agent 状态机/生成链路已有良好覆盖） |
| 长期记忆引入隐私/合规风险 | 中 | 记忆默认可关、可清空、可导出；云策略门覆盖记忆注入 |
| ComfyUI/适配器版本漂移（H3、Wan 等） | 中 | 保留 smoke 脚本（run-h3-amd-smoke 等）并在 CI 定期跑 |
| 批量流水线触碰 quota/审计热点 | 中 | 直接复用治理层，禁止绕过（P0 接通后单轨执行） |
| Electron 33 安全维护 | 低 | 评估升级窗口；更新链路已签名，保持依赖审计 |

### 3.5 资源估算（粗）

- P0：1 人 × 2 周（或 2 人 × 1 周）
- P1 旗舰 A：1–2 人 × 4 周
- P2 旗舰 B：1–2 人 × 4–5 周
- P3 生态：2 人 × 6 周（含文档）
- 全程质量成本：约 25–30% 用于测试/评审/安全

---

### 3.6 P0 落地进度（2026-08-14 更新）

| 步骤 | 状态 | 提交 | 说明 |
|---|---|---|---|
| P0-0 合入在途批量 | ✅ | `0779182` | 在途安全修复 + 人格系统 + 提示词库 v6 + 提供商模板，门禁全绿后提交（43 文件 +1975/−216） |
| P0-1 清洗提供商模板 | ✅ | `98b00b4` | 277→80 个模板；移除无处理器 type、虚构厂商、重复/备用条目、非聊天 API；新增契约测试（类型/形状/分组/去重） |
| P0-2 清理孤儿组件 | ✅ | `51a7fd8` | 删除未引用的 ProjectSidebar.jsx 重复件（−155 行） |
| P0-3 GUI 确认绑定 digest | ✅ | `f471718` | prepareGeneration 计算 requestDigest 并回显 preview；runPrepared 用 assertConfirmationBinding 校验（accepted/digest/requestId/previewId）；渲染层发 digest 形态 confirmation + 独立 previewEdits；重启恢复保留 digest；5 个新测试 |
| P0-4 治理层接入 | ✅（收敛） | `18fe91b` | 实测治理栈已由 main.mjs 协调器接入全部生成执行（policy+admission+audit）；补齐 comfyui.submit 的 generation_count 配额扣减（与 CLI 对齐）+ 协调器接线模式测试（含配额耗尽拒绝） |
| P0-5 拆分 agent.mjs | 🔶 第一刀 | `a9defb9` | 抽出 chat-intents.mjs（确认/身份/联网启发式、附件归一化）与 agent-tools.mjs（工具清单+工厂）；`_getTools` 改工厂；6 个新测试；后续按 对话/规划执行/生成装配/会话 继续拆分 |
| P0-6 渲染层测试骨架 | ✅ | `798f227` | vitest + jsdom + @vitejs/plugin-react；`npm run test:ui`；electronAPI/matchMedia mock；Icon / GenerationProgress / PromptPersonalitySettings 冒烟测试（8 个） |

核心套件基线：**917 tests / 910 pass / 0 fail** + 渲染层 8 个冒烟测试；lint 278 文件；build 通过。
后续：P0-5 继续拆分（execution/chat/context 子系统）、P1 长期记忆、P2 批量流水线、P3 插件生态。

### 3.7 P1 长期记忆系统落地进度（2026-08-14 更新）

| 步骤 | 状态 | 提交 | 说明 |
|---|---|---|---|
| P1 核心（存储+沉淀+注入） | ✅ | `569797a` | `src/agent/memory/long-term.mjs`：项目级记忆（风格偏好/不要清单/常用工作流计数/角色卡/去重记忆段，均带上限），原子 JSON 持久化，`distillProfileSignals` 确定性蒸馏，关键词+时效排序的 recall 格式化；chat-prompt.mjs 新增 `{memoryContext}` 占位符与 `<memory_context>` trust 块（**仅本地模型注入，云端默认不注入**——比"过云策略门再发云端"更保守）；agent.mjs 可选 memory 选项、压缩管线沉淀钩子（尽力而为不阻断）、chat() 召回注入；顺带修复 chat taskId 同毫秒碰撞（`chat_<ts>_<rand>`）。13 个新测试 |
| P1 UI + 接线 | ✅ | `198178d` | worker 创建 LongTermMemory 并暴露 memory.* RPC；main 新增 memory:* IPC；preload 暴露 7 个通道；`MemorySettings.jsx`（偏好 tag 编辑器、角色卡增删改、记忆段浏览、清空确认、JSON 导出）挂入设置页 memory tab；zh/en i18n；2 个渲染层冒烟测试 |
| P1 隐私与治理 | ✅（设计收敛） | — | 记忆仅注入本地模型（与既有 cloud 提示词刻意剔除项目上下文的模式一致）；记忆数据属用户本地数据，UI 可查看/编辑/清空/导出；无云端外发路径 |

核心套件基线（P1 后）：**929 tests / 922 pass / 0 fail** + 渲染层 10 个冒烟测试；lint 279 文件；build 通过。
剩余：P1 可选增强（记忆设置开关、用户级记忆、召回在生成规划中的应用）→ P2 批量流水线 → P3 插件生态。

### 3.8 P2 批量创作流水线落地进度（2026-08-14 更新）

| 步骤 | 状态 | 提交 | 说明 |
|---|---|---|---|
| P2 调度核心 | ✅ | `a120f57` | `src/runtime/batch/batch-scheduler.mjs`：seed 矩阵 × 参数组合展开（含随机种子数）、job 生命周期 pending/running/completed/failed/cancelled/interrupted、受限并发（可配）、暂停（停取任务、在跑任务完成）、取消（中断在跑 + 标记排队）、单条重试（自动重启）、JSON 持久化 + 崩溃恢复（running→interrupted 重新入队）、批次/任务上限与旧批次淘汰、进度统计与事件、结果摘要。9 个新测试 |
| P2 接线与策展 | ✅ | `e284ca9` | job 携带 workflow 上下文；runJob 注入 governed executionCoordinator（policy/quota/audit 全复用）+ DirectService 逐 job 执行；worker 新增 `evaluator.score` RPC（技术分+视觉分 → 0-100）；main 持有调度器（agent-data/batch.json）并暴露 batch:* IPC（create/start/pause/resume/cancel/retry-job/get/list/curate）+ batch:event 转发；preload 对应通道；策展 Top-K 按分排序。3 个新测试 |
| P2 批量工作室 UI | ✅ | `129a7d8` | `BatchWorkspacePage.jsx`：新建批次表单（标题/工作流/正负提示词/种子数或指定种子/参数组合 JSON）、批次卡片（进度条 + job 表格：种子/状态/评分/操作）、开始/暂停/继续/取消、单条重试、查看图片、策展 Top-K；`batch` 视图 + 导航项；zh/en i18n；2 个渲染层冒烟测试 |

核心套件基线（P2 后）：**940 tests / 933 pass / 0 fail** + 渲染层 12 个冒烟测试；lint 280 文件；build 通过。
剩余：P2 可选增强（结果 A/B 对比灯箱、批量策略化 seed 管理、批次内分页）→ P3 插件生态 → P0-5 拆分续。

---

## 附录 A · 关键文件地图

- 编排核心：`src/agent/runtime/agent.mjs`（162 KB）、`intent-router.mjs`、`planner.mjs`、`executor.mjs`、`chat-prompt.mjs`（新）
- 会话/任务：`src/agent/runtime/session-manager.mjs`、`task-manager.mjs`
- LLM：`src/agent/llm/provider.mjs`、`cloud-policy-router.mjs`、`openai-compatible.mjs`、`ollama.mjs`
- 工具：`src/agent/tools/comfyui/index.mjs`（preflight/执行）、`workflow-mutation-*`、`filesystem/*`、`prompt/enhance.mjs`、`web/index.mjs`
- 治理：`src/runtime/governance/*`（admission/operation-gateway/policy/quota/audit/rate-limiter/retention/session-registry）
- 插件：`src/runtime/plugins/{contract,host,registry}.mjs`；Skills：`src/agent/skills/*`
- Electron：`electron/main.mjs`（184 KB）、`agent-process.mjs`、`agent-worker.mjs`、`comfyui-manager.mjs`、`preload.cjs`
- 前端：`src/App.jsx`、`src/contexts/AgentContext.jsx`（2,234 行）、`src/components/`（161 文件）、`src/i18n/I18nContext.jsx`
- 评审：`docs/reviews/commit-95762c3-review.md`（88 条，41 高/47 中）、`docs/reviews/security-review-2026-08.md`（N-/T- 系列 + 复验表）；发布门禁：`docs/stability-test-plan-v0.3.7.md`（A–H 手工矩阵，H3/AMD 灰帧明确不阻塞主线）；核心链路复验：`docs/comfy-agent-core-flow-review-verification-round4.md`（根因：无单一任务所有权）
