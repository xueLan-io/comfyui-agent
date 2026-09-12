# ComfyMuse 底层重写计划 v2 — Agent 内核：从流水线到对话循环

> 2026-09-12 v2。推翻 v1（docs/rewrite-plan-2026-09.md 的进程/契约视角——那些是管道问题，不是核心问题）。
> 核心判断：**当前 agent 内核不是"正常的 Agent 设计"，而是一条多级硬门流水线**。用户描述的症状（环节断掉续不上、聊天和出图穿插出问题）都能在代码里指到机制。

---

## 一、诊断：为什么业务流脆弱

### 1. 现在的回合不是 agent loop，是流水线

```
handleTurn → 意图路由（正则+LLM分类+readiness评分）
  → cancel / clarify / file_edit / suggest / reply(chat) / prepare(生成)
chat 路径和 run 路径是两套独立流，各有自己的上下文组装
生成内部：planner一次性出JSON计划 → 校验 → 冻结 → 预览 → 确认 → 逐步执行 → 评估 → 重试/重规划
```

用户每句话先过意图路由这道闸（`turn-ops.mjs:132-200` 分发六种动作），分错了后面全错（bug #16："我想要它更亮一点"被判成新生成）。规划器一次吐完整 JSON 计划（`planner.ts:179-267`），模型没有工具可调、没有迭代机会，靠事后正则补丁救场：`_normalizeExpectedOutputs`、`_applyWorkflowContext` 改写工作流名、`_injectEnhanceStep` 挪步骤顺序、`run-flow.mjs:146-154` 再兜底一次——校验不过就整回合死掉。

### 2. 全局单槽回合 + 一个 16 态状态机，聊天和生成互相顶死

- 所有流程共用 `Agent._state`（16 态）+ `_running` + `_runEpoch` + `_pendingQueue`。
- **预览待确认期间聊天直接抛异常**：`chat-flow.mjs:17` `throw new Error('有待确认的生成预览，请先确认或取消当前预览。')`。
- **生成运行期间聊天被塞进匿名 thunk 队列**（`agent.mjs:553-572`），用户看到的就是"发出去没反应"。
- `_runtimeBusy()`（`agent.mjs:457-459`）进而禁止切换会话、禁止改模型配置。

这就是"图片和聊天穿插有问题"的机制根源：**出图占住了整个 agent，聊天只是排队等它**，而不是对话里挂一个后台任务。

### 3. "断掉续不上"的机制：失败即终结，计划不进对话

- 步骤失败 → 任务 failed，往对话里写一句 `Error: ...` 字符串（`run-flow.mjs:234,388`），模型完全不参与善后。用户说"换个采样器再来"，要重新过意图路由 → 重新规划，而上一轮的计划/步骤结果只存在 taskManager 里，不在对话线程里（chat 和 run 的上下文组装是两套：`assembleChatContext` vs `buildAgentContext`）。
- 重规划上限实际是 1 次（`run-flow.mjs:215` 检查 `_replanCount < 1`，与 `_maxReplans ?? 2` 已经漂移）。
- 每条终态路径要**手工同步 5 处状态**：taskManager、sessionState（6-8 个字段）、conversation、STATUS/MESSAGE 事件、clearCurrentTask（成功路径 `run-flow.mjs:329-371`、失败路径 `:383-402`）。漏一处就是 UI 卡死/幽灵状态——审计里的 #9、#14、#28、#29、#30、#31 全是这个设计的孩子。

### 4. 并发安全靠手写补丁，不靠结构

`_runEpoch` 代际协议要求每条异步路径在 ~10 个检查点记得比对代数、绝不碰共享状态（`run-flow.mjs:134,163,198,217,379`、`chat-flow.mjs:22,45,71`、cancel/abandon/discardPrepared 各自的 settling 判断）。每加一种新流程（视频、批处理）就要重新推导一遍这些守卫。**正确做法是让"回合"与"任务"两个生命周期解耦，这类竞态在结构上不存在，而不是靠纪律防住。**

## 二、目标设计：对话驱动的 Agent Loop

```
Session = 一条持续对话线程（用户消息、助手文本、工具调用与结果都是线程里的一等消息）

每回合:
  用户消息 → 追加进线程
  循环: LLM（系统提示 = 身份 + 项目状态 + 在跑的任务状态）→
    ├ 回复文本 → 流式给用户，回合结束
    └ 工具调用 →
        generate_image / edit_image / upscale / web_research / files …
        → 注册为后台 Job，立即返回 job_id，线程继续
        → Job 完成/失败后，结果（图/错误）作为 tool result 注回线程
        → LLM 再次被调用：总结成果、对错误自处置（换参数重试/问用户/降级）、继续别的事
  需要确认的操作：tool 返回 needs_confirmation + 预览卡片
        → 用户点确认 → 该 Job 继续执行（同一条确认协议，无独立预览状态机）
```

**要点对照**：

| 用户痛点 | 新设计里的解法 |
|---|---|
| 环节断了续不上 | 失败是 tool result，模型看到错误自己决定重试/改参数/问用户；计划与步骤结果都在线程里，"再来一次"是模型看得见的上下文 |
| 聊天/出图穿插坏 | 出图是后台 Job，占住的是 Job 而不是对话；渲染期间照常聊天，Job 完成事件自己浮上来 |
| 不像正常 Agent | 去掉前置意图路由闸门，模型每回合自己决定"说话还是调工具"；澄清问题是模型的自然文本输出，不再是 pending-state 问答机 |

**复用资产**（这些不动）：LLM provider 层、13 个 comfyui 工具文件 + 适配器 + skills、governance/sandbox、memory、session/project 存储、997 个测试中的工具层/存储层部分、CLI/MCP host。

**删除对象**（脆弱的中段）：`intent-router.mjs`、`turn-flow/turn-ops` 分发、chat-flow 与 run-flow 双轨、`planner.ts` 一次性出计划（其提示词知识迁移到工具描述+系统提示）、`prepare-ops` 816 行冻结/预览机构、16 态任务 FSM、clarify pending 状态机、`_runEpoch` 代际协议（被 Job 生命周期取代）。

## 三、切片（每片可合入，主分支可发布）

### S1 — 让 tool-calling 真的能用（2-3 天，前置硬条件）
- 修流式 tool_calls 累积（bug #5：openai-compatible 与 ollama 流式分支从不累积 delta.tool_calls——loop 设计的前提）。
- 修 ollama `num_ctx`（bug #35）、工具调用回归测试（fake LLM + 真本地模型各一轮）。

### S2 — AgentLoop 内核（~1 周，最大件）
- 新建 `src/agent/core-loop/`（或 packages/agent-loop）：对话线程模型、tool-calling 循环（流式、最大迭代、取消）、JobManager（后台任务、事件、取消、多任务并存）、确认协议（needs_confirmation 卡片）。
- `generate_image` 工具包装现有 comfyui 执行链（executor/adapter/prompt 编译原样接入）。
- 测试：现成的 fake-comfyui + fake-LLM harness 上跑脚本化 tool-calling 用例（聊天中出图、失败自处置、确认续跑、多 Job 并存、取消）。

### S3 — 回合入口切换（~1 周）
- `handleTurn` 改走 loop；AI 聊天与生成统一进线程；意图路由/clarify/prepare 冻结机构对 AI 路径下线。
- 恢复逻辑改为 Job 状态恢复（重启后续跑/标记失败），替换 `_recoverAbandonedTasks` 的会话状态重置。
- 移植回合相关测试（失败续聊、确认流、取消）。

### S4 — UI 适配（3-5 天）
- ChatPanel 渲染工具调用气泡：确认卡片=预览、Job 进度卡片与输入框状态解耦（聊天时不再禁输入）。
- 拆 AgentContext 的生成 phase FSM，改为订阅 Job 事件。
- 保留"快速生成/批处理"确定性直通路径不动。

### S5 — 清理与门禁（2-3 天）
- 删除 S3 已下线的管线代码与状态机；三套 FSM（request-ledger/task/generation-state-machine）收敛到 Job 一套。
- 文档/架构图更新。

**总量级约 3 周。** 风险：小参数本地模型工具调用质量参差 → 保留直通路径兜底 + S1 的模型实测门禁；流式工具调用各提供商行为不一 → S1 逐 provider 验证。
