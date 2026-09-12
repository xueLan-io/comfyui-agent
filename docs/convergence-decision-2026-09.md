# 收敛决策：ComfyAgent 内核并入 ComfyMuse（2026-09-12）

> 状态：已决策，S2 已落地。设计权威仍是
> [`agent-v2-design.md`](./agent-v2-design.md)；本文记录"两个仓库收敛成一个"的
> 方向选择、供体关系与归档条件，供后续会话与协作者直接引用，不再重新推导。

## 一、背景与结论

存在两个仓库：

| | ComfyMuse（本仓库） | D:\ComfyAgent（供体） |
|---|---|---|
| 定位 | 产品：UI、会话、批处理、预设、打包、发布 | 内核实验田：对话式 agent loop 的干净实现 |
| 内核 | 流水线（已判死刑，见 rewrite-plan 诊断） | tool-calling loop + 校验门禁 + JIT 检索 + 压缩 |
| UI | React 18 + Vite，8 主题、i18n、资产库等 | ~1000 行 vanilla 存根 |
| 测试 | 997 测试 + 打包链 | 52 离线测试（mock 模型 + fixture） |

**结论：收敛到本仓库。** 把 ComfyAgent 的内核移植进来作为
`src/agent/core-loop/`（即 agent-v2-design.md §7 指定的复制目标），而不是把
3.4 万行 UI + ~190 个 IPC 通道反向迁去 ComfyAgent。理由：

1. 产品资产（UI/打包/发布/历史/997 测试）在本仓库，内核只有数千行——移动少
   的那份，增量切片、每片可发布（rewrite-plan 的切片原则）。
2. 反向收敛是 4.5 万行以上的大爆炸迁移，特性追平前两边都得冻结，正是
   agent-v2-design §7 用"复制不共享 + 双内核并行"要避免的形态。
3. ComfyAgent 作为独立实现恰好验证了 v2 设计可行（它就是 S2 的净室版本），
   它的离线测试网随内核一起移植，成为新内核的回归基准。

## 二、已完成：S2 内核移植（本次）

`src/agent/core-loop/` 已就位并通过验证（2026-09-12）：

- 来源：ComfyAgent `src/{core,tools,comfy,guardrails,model,context,config,observe,util}`
  + `runtime.ts`，目录形状 1:1 保持，相对导入零改动。
- 适配点：仅两处——8 个构造器参数属性改为显式字段（本仓库
  `erasableSyntaxOnly` 禁止），测试 fixture 移至 `tests/core-loop/fixtures/`。
- 测试网：`tests/core-loop/`（51 离线 + 1 live 门禁用例），运行
  `npm run test:core-loop`；vitest 配置独立于主配置（`vitest.core-loop.config.mjs`，
  node 环境），不影响 `tests/ui`。
- 依赖：新增直接依赖 `zod@^4`、`ws@^8`、`openai@^5`、`dotenv`（与供体仓库
  同版本线；openai 的 peerOptional zod@^3 冲突用 `--legacy-peer-deps` 安装，
  内核不使用 openai 的 zod 集成，二者共存是供体仓库验证过的组合）。
- 门禁：`scripts/lint-core-loop.mjs` 已接入 `npm run lint`——core-loop 内
  禁止任何指向旧 src/ 的相对导入（copy-don't-share，§7）。
- 未移植（有意）：MCP 服务（2026-07-28 spec，留在供体仓库按需再取）、CLI、
  桌面壳。

当前 core-loop 是**自包含内核**：自带 ModelPort（mock + openai-compatible
两个实现）与自包含 env 配置。它尚未接入本仓库的任何运行路径——这正是下一片。

## 三、切片计划（承接 agent-v2-design §9，S2 已完成）

| 切片 | 内容 | 验收 | 状态 |
|---|---|---|---|
| S1 | 修流式 tool_calls 累积（bug #5）、ollama num_ctx（bug #35） | fake-LLM + 真本地模型各一轮工具调用回归 | **已完成**（代码修复已随 TS 迁移落地；回归网 `tests/llm-streaming-toolcalls.test.mjs`：假 SSE/NDJSON 服务器 4 用例 + `LLM_LIVE=1 LLM_LIVE_MODEL=模型名 npm test` 真模型门禁用例） |
| S2 | core-loop 内核 + 离线测试网 | `npm run test:core-loop` 全绿；`npm run lint` 通过 | **已完成并扩展**：在供体内核（loop/12 工具/门禁/JIT/压缩）之上补齐设计 §2/§3 缺件——`thread.ts`（P7 JSONL 事件溯源线程）、`jobs.ts`（P3 后台 JobManager：进度/取消/结算通知/快照）、`../v2-bridge/`（llm-adapter：旧 LLMProvider→内核 ChatModel，含 ollama 无 id 工具调用的 id 合成与坏参数 rawArguments 透传；generation-tools：generate_image/reroll = prepare→P5 确认→后台 Job→立即返回 job_id）。`tests/core-loop/` 64 绿 |
| S3 | 回合入口切换：`handleTurn` 走 core-loop；ProviderLayer 适配 ModelPort；JobManager（后台生成、确认协议）；feature flag 双内核 | flag 开启后：聊天中出图、失败自处置、确认续跑、取消，各一条脚本化测试；flag 关闭行为与现状逐字节一致 | **代码已完成（2026-09-12）**：`electron/agent-worker-v2.ts`（同协议外壳；Thread/JobManager/审批门/DirectService runner/ALL_TOOLS+生成工具/事件映射/trace）+ `agent-process.ts` fork 开关（`config.agentV2Kernel === true`，默认旧 worker，旧路径未动）。验证：tsc 全绿、worker 模块纯 Node 整链加载 OK、1001+20 测试零影响。**待做**：开 flag 的端到端手册验证（聊天/生成/确认/取消四条路径）+ 平价清单剩余项打勾 |
| S4 | UI 适配：ChatPanel 渲染工具调用气泡/Job 卡片/确认卡片；拆 AgentContext 生成 FSM，改订阅 Job 事件；快速生成/批处理直通路径不动 | 双内核 flag 下 UI 手册过一遍 + ui 测试绿 | **代码已完成（2026-09-12）**：`AgentApprovalCard.jsx`（自包含审批卡，内联样式避开主题级联，AgentContext 零改动）挂载于 AppLayout；preload 新增 `agentOnApproval`/`agentRespondApproval`；main 新增 `agent:approval` 事件转发与 `agent:approval-response` IPC、`agentV2Kernel` 透传进 `agent.start(config)`。Job 进展经 task_notification 以 `agent:message` 呈现。测试：审批卡 3 用例 + 全套件绿。**待做**：`agentV2Kernel: true` 开启后的四条路径手册验证（见下） |
| S4 手册验证指引 | 在设置存储（prefStore JSON）写入 `"agentV2Kernel": true` 并重启应用后依次验证：① 聊天不生成 → `agent:message` 正常流式回复，`agent-data/threads/<sessionId>.jsonl` 增长；② 生成 → 模型调用 generate_image → 右下角出现审批卡 → 允许 → job_id 立即返回、聊天可继续 → 完成后收到 task_notification 且 agent 自动总结；③ 拒绝 → 卡片消失、模型收到 APPROVAL_DENIED 且不重试；④ 取消 → 生成期间取消，Job 与回合干净复位。问题排查：主进程 stderr 看 `[agent-worker-v2]` 前缀日志；trace 在 `agent-data/traces-v2/`。 | | 待人工执行 |
| S5 | **移出而非删除**（用户决策 2026-09-12）：平价清单全过后，把旧流水线 `git mv` 到仓库根 `_legacy/` 隔离区（不参与构建/测试/lint），默认 worker 切为 v2；旧内核代码保留备查，随时可回退 | 切换后：默认路径走 v2 worker；`npm test`/`lint` 全绿（隔离区不扫描）；grep 确认存活代码无指向 `_legacy/` 的导入 | 待做（前置：S4 手册验证通过） |

**S5 候选移动清单**（执行时以依赖分析为准，原则：编排层移走，工具/存储层留下）：

- **移入 `_legacy/`**：`src/agent/runtime/` 中的编排件——`intent-router.mjs`、`turn-flow.mjs`、`turn-ops.mjs`、`chat-flow.mjs`、`run-flow.mjs`、`chat-intents.mjs`、`chat-ops.mjs`、`planner.ts`、`prepare-ops.mjs`、`task-manager.mjs`（Job 取代）、`agent.mjs`（流水线枢纽）+ `electron/agent-worker.ts`（旧 worker 本体）
- **留下（被 v2 复用的资产）**：`src/agent/tools/`（comfyui 执行链+适配器）、`src/agent/memory/`、`src/agent/schemas/`、`src/agent/security/`（sandbox）、`src/agent/runtime/session-manager.mjs`（会话/项目存储）、`src/runtime/executor/`（ComfyExecutor）、`src/runtime/direct/`（直通路径，P8 保留）、governance/plugins、批处理
- **连带修改**：`electron/agent-process.ts` 默认 fork 路径切 `agent-worker-v2.ts`；`tsconfig.json` include 移除已迁移 TS 文件（planner/executor/execution-ops/chat-request）；`src/agent/index.ts` 等存活文件的导入指向修正；`AgentContext.jsx` 的生成 phase FSM 拆除（S4 遗留项，随 S5 一起收尾）
- **不做**：不删 git 历史、不删 `_legacy/` 里的代码、不强求隔离区可编译（它是档案不是代码）

### S3 剩余接线（✅ 2026-09-12 已完成，留档实现要点）

已落地：`electron/agent-worker-v2.ts` + `agent-process.ts` fork 开关。实现要点：
- 描述符约定：core-loop/v2-bridge 内部导入用 **`.ts` 后缀**（Node type-stripping 不解析 `.js`→`.ts`，Electron 运行时会 ERR_MODULE_NOT_FOUND——已实测并全量切换）；tests/core-loop 保持 `.js` 描述符由 vitest resolver 处理。
- 组合：`LLMProvider(config.llm)` → `BridgedChatModel`；`createRuntime()` 提供工具上下文（审批门注入 PendingApprovalGate）；registry = `ALL_TOOLS` + `createGenerationTools`（runner 包装 DirectService.prepare/run/cancel，workflowName 来自 config）。
- 回合：线程投影为 history（末 40 条，system→`[system]` 前缀 user）+ `Agent.run({history})`；事件映射为旧事件名 + 新增 `agent:approval`；Job 结算 → 线程 task_notification + 空闲时自动续跑一轮（P3 唤醒）。
- 已知限制（S4 处理）：v2 worker 仅支持 handleTurn/cancel/session.getState/approval.response，其余 RPC 回 `NOT_IMPLEMENTED_IN_V2`；会话/项目管理 UI 在 v2 模式下不可用（快照为空壳）；`config.agentV2Kernel` 需 UI 设置透传才能开启。

## 四、ComfyAgent（供体仓库）的归档条件

满足以下**全部**条件后，供体仓库归档（只读保留，不删除）：

1. S3 完成：`handleTurn` 默认走 core-loop，双内核 flag 下连续一周真实使用无回切；
2. S4 完成：UI 在新内核上功能对等（出图/失败自处置/确认/取消）；
3. 供体独有的 MCP 服务如仍需要，已迁出或确认放弃；
4. 本文档 + agent-v2-design.md 足够后人理解内核来源与设计。

在那之前，若 core-loop 发现缺陷需要源头修复，**直接在本仓库修**（copy 站
原则），不再回流供体仓库——避免双头维护。

## 五、给后续会话的操作指引

- 跑新内核测试：`npm run test:core-loop`
- 全套检查：`npm run lint`（已含 tsc + 主题 lint + core-loop 门禁）
- S3 开工顺序：先 S1（provider 流式修复）→ ProviderLayer→ModelPort 适配器 →
  JobManager → handleTurn 切换（flag）→ 移植 S3 测试。
- 内核结构说明见 `src/agent/core-loop/` 内各文件头注释与供体仓库
  `docs/architecture.md`、`docs/adr/0003`（JIT 检索）。
