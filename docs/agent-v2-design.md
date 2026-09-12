# ComfyMuse Agent v2 设计文档

> 2026-09-12。本文件是 agent 内核重写的**设计权威**；docs/rewrite-plan-2026-09.md 仅作迁移节奏参考，两者冲突以本文为准。
> 设计基于两路先行研究（通用 agent loop 架构 + 对话式图片生成产品/开源项目），来源见文末 §10。原则：**不闭门造车，逐条注明出处；不照搬框架，只取机制**。

---

## 0. 现有内核的一句话病理

回合是多级硬门流水线（意图路由 → clarify/prepare 双闸 → 规划器一次性 JSON → 冻结 → 确认 → 执行），聊天与出图共用一个 16 态状态机和一个回合槽；失败是异常不是数据，计划与步骤结果不进对话线程。结果：环节断了续不上、生成期间聊天被抛异常或排队、竞态靠 `_runEpoch` 手写补丁。详细证据见 docs/rewrite-plan-2026-09.md §1。

## 1. 设计原则（每条注明来源）

| # | 原则 | 来源 |
|---|------|------|
| P1 | **单一主循环，无框架**：agent = "LLM 根据环境反馈在循环中使用工具"，保持朴素 while 循环，五种复杂度模式（链/路由/并行/编排者-工人/评估-优化）只在确有需要时引入 | Anthropic《Building Effective Agents》 |
| P2 | **错误是观察，不是异常**：工具失败以结构化错误注回线程，模型看到错误自处置（换参数重试/问用户/降级）；"让 agent 知道工具在失败并让它适应，效果出奇地好" | SWE-agent；Anthropic 多智能体系统 |
| P3 | **生成是后台 Job，不独占回合**：长任务立即返回 job_id，完成后以合成通知唤醒循环（空闲时自动续跑，忙碌时在回合边界投递）；用户在生成期间发的消息排队不丢弃 | Claude Code 后台任务 + task-notification（含官方 issue #88378 的教训：通知必须能唤醒空闲的 agent） |
| P4 | **产物是可寻址对象，上下文只带引用**：图片/视频落盘，线程里只放 artifact_id + 路径 + seed + 参数摘要；后续编辑按 ID 引用（Click-to-select ≈ id），绝不让 base64/元数据灌进上下文 | Anthropic artifact 模式；OpenAI image_generation_call id；Gemini previous_interaction_id |
| P5 | **确认 = 中断/恢复协议**：需要确认的工具调用挂起并产出预览卡，用户的批准/修改作为该调用的"返回值"注入后恢复——唯一确认机制，不设独立预览状态机 | LangGraph interrupt/resume |
| P6 | **工具面即产品**：参数 poka-yoke（枚举/绝对路径/schema 校验）、输出设上限、空输出补合成说明、**注册时校验工作流描述（防静默失效）**；"我们花在优化工具上的时间比提示词多" | Anthropic ACI；SWE-agent 四原则；comfyui_LLM_party 的静默失效反例 |
| P7 | **事件溯源**：线程 = append-only 日志（JSONL），UI/CLI/MCP 都是日志的投影；崩溃恢复 = 重放 + Job 状态重建 | OpenHands Event Stream |
| P8 | **固定流程走 workflow，不可预测的走 loop**：放大/批量等确定性路径保留直通（也顺带兜底弱本地模型） | Building Effective Agents |
| P9 | **自纠错要有预算上限**：可选评估门 + 最多 k 轮，不收敛时交出 best-so-far 与失败原因；"循环的价值在消融中最大，但 ~14% 硬例不收敛" | RefineEdit-Agent |

## 2. 核心概念与数据模型

```
Session（会话）
 └─ Thread（线程，append-only JSONL，一行一消息）
     ├─ Message { id, ts, role: user|agent|tool|system, content, toolCall?, artifactRefs?, meta }
     ├─ ToolCall  { id, name, args }
     └─ ToolResult{ callId, ok, summary /*≤2k 字符*/, error?, artifactRefs?, jobId? }
 └─ Job（后台任务；独立生命周期，可多个并存）
     { id, tool, args, status: pending|running|done|failed|cancelled, progress, artifactIds, error }
 └─ Artifact（产物；落盘文件 + 元数据）
     { id, kind: image|video|file, path, seed, params, thumb }
 └─ Confirmation（挂起的确认卡）
     { id, callId, preview, createdAt }
```

规则：
- 线程是唯一事实。`lastPrompt/lastImages` 之类的 project 字段降级为缓存，可随时从线程+产物重建。
- Job 与 Turn 解耦：Turn 会结束，Job 继续跑；Job 完成 → 合成 `system` 事件进线程。
- 每会话一个线程文件：`agent-data/threads/<sessionId>.jsonl`。

## 3. 主循环规范

```js
async function runTurn(thread, input) {
  thread.append(userMessage(input));               // 生成期间敲下的消息在 turn 边界排队投递，不丢
  for (let i = 1; i <= MAX_ITER /* 默认 12 */; i++) {
    const res = await llm.chat({
      system: systemPrompt(personality, projectState, jobManager.activeSnapshot()),
      messages: toLLM(thread, { compact: 'drop-bulky-tool-outputs' }),
      tools: TOOL_SCHEMAS, stream: true,
    });
    if (!res.toolCalls.length) { thread.append(assistantText(res)); return DONE; }
    for (const call of res.toolCalls) {
      const tool = registry.get(call.name);        // 注册时已做 schema/描述校验（P6）
      if (tool.confirmPolicy(call)) {              // P5：挂起，不独占
        thread.append(pendingConfirmation(call, await tool.preview(call)));
        return AWAITING_CONFIRMATION;
      }
      if (tool.kind === 'async') {
        const job = jobManager.start(tool, call);
        thread.append(toolResult(call, { jobId: job.id, status: 'running' }));
      } else {
        const out = await tool.execute(call, { signal });   // 失败 → 结构化 error，不 throw（P2）
        thread.append(toolResult(call, summarize(out, { cap: 2000 })));
      }
    }
  }
  thread.append(assistantText('本轮迭代已达上限，先汇报当前进展…'));
  return ITERATION_CAP;
}

// P3：Job 完成唤醒
jobManager.on('completed|failed|cancelled', job => {
  thread.append(systemEvent('task_notification', { jobId: job.id, summary, artifactRefs: job.artifactIds }));
  if (sessionIdle(thread)) runAgentIteration(thread);   // 空闲自动续跑；忙碌则回合边界投递
});

// P5：确认恢复 = 注入"返回值"并继续被挂起的迭代
resumeConfirmation(id, { approved, edits }) {
  thread.append(toolResult(call, { approved, args: mergeArgs(call.args, edits) }));
  continueSuspendedTurn(thread);
}
```

**时序要点**：
1. 生成中聊天：`generate_image` 返回 job_id 后循环继续，模型可以先说话；用户此刻发新消息 → 排队，回合结束后投递。**任何时刻输入框都可打字。**
2. Job 完成：空闲时自动唤醒模型对结果发言（成功→总结+图卡；失败→自处置）。
3. 确认：挂起的是这一次工具调用，不是整个 agent；挂起期间其他会话、聊天、其他 Job 全部正常。
4. 取消：取消的是 Job（UI 停止按钮必须能干净复位——ChatGPT 停止按钮粘连是已知反例）；回合本身可正常结束。
5. 崩溃恢复：重放线程 + 把 running 态 Job 重标为 interrupted，模型下次看到的是事实而不是"幽灵进行中"。

## 4. 工具面（第一版 ≤8 个，poka-yoke）

| 工具 | 类型 | 确认 | 说明 |
|---|---|---|---|
| `generate_image` | async Job | 可设置：预览确认/直出 | prompt 编译 + ComfyUI 执行链原样接入；结果含 revised/compiled prompt（调试可见，OpenAI 模式） |
| `edit_image` | async Job | 同上 | 引用 artifact_id，走 img2img/inpaint 适配器 |
| `reroll` | async Job | 否 | 同参数换 seed（Midjourney 🔄） |
| `upscale` | async Job | 否 | |
| `web_research` | sync | 否 | 现有 web 工具收敛 |
| `read_project` | sync | 否 | 工作流列表/项目文件/系统状态（filesystem+system 收敛，输出封顶） |
| `write_project` | sync | 确认 | 文件变更（filesystem_mutate 收敛，沙箱白名单不变） |
| `evaluate_output` | sync | 否 | 可选 VLM 打分门：分数+文字反馈注回线程（P9，k≤2） |

- **workflow-as-tool 的注册机制**（借鉴 comfyui_LLM_party，修正其静默失效）：现有 adapters/skills 把 ComfyUI 工作流登记为 generate/edit 的能力档案（modes、promptProfile），**登记时校验工作流可解析、描述非空**，不合格拒绝注册并给出错误。
- 模型不接触工作流 JSON 图本身，只看能力描述。原 36 个工具文件多数降级为实现细节。
- 工具描述按"给新人的优秀 docstring"标准写（P6），枚举参数全部 enum 化。

## 5. 事件与投影

单一事件流（复用现有事件骨架，去模块级全局单例，改构造注入）：
`message.appended` / `message.delta`（流式）/ `job.progress` / `job.settled` / `confirmation.pending` / `thread.compacted`。

- UI = 订阅投影：消息列表即线程，Job 进度卡即 job 事件，预览卡即 confirmation。
- CLI/MCP host 消费同一 loop（无 Electron 依赖），MCP 的 tools/call 直接映射为一次 runTurn。

## 6. 上下文管理

- 压缩策略（Anthropic context engineering）：接近预算时总结旧段，**保留**：已定决策、约束、artifact id、活跃 Job 状态、用户偏好；**丢弃**：大体积工具输出、图片元数据转储、已终结 Job 的过程细节。宁可召回优先，不做激进压缩。
- `evaluate_output`/调研类的长输出走 artifact 模式：落盘，线程只留引用与摘要。

## 7. 与旧系统的关系：干净重写守则（回应"同目录重构会偷懒"）

担忧成立：在旧目录里重构，边界立不住，人会往旧结构凑。因此：

1. **新代码住新目录 `agent-v2/`**（thread/loop/tools/jobs/确认），自己的 tsconfig strict。旧 `src/agent`、`src/runtime` 原样不动，直到切换完成。
2. **移植=拷贝不共享**：LLM provider、comfyui client/executor/adapters、governance/sandbox、memory 拷入 `agent-v2/adapters/` 后就地改造；lint 强制 `agent-v2/` 禁止 import `src/`（加进 scripts/lint.mjs）。
3. **切换走特性开关**：`electron/agent-worker-v2.ts` 新入口，配置项选择新旧内核；新旧可对照跑。
4. **平价清单=切换条件**（全过才默认切新、删旧）：聊天中出图不阻塞 ✓ 失败后对话式自处置 ✓ 确认卡挂起/恢复/修改参数 ✓ 取消干净复位 ✓ 多 Job 并存 ✓ 崩溃重放恢复 ✓ CLI/MCP 跑新内核 ✓ 旧 997 测试中工具/存储层全部对位移植 ✓ 稳定性用例重跑 ✓。
5. v0.3.7 tag 永远可回退；旧内核在切换稳定一个版本后整体删除。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 小参数本地模型工具调用质量差 | 工具面压到 8 个 + schema poka-yoke；S1 先修流式 tool_calls（审计 #5）并实测门禁；直通快速生成路径保留兜底（P8） |
| 模型不该出图时出图/该出图时不出图 | 工具描述写清"何时调用"；设置项提供"自动出图"开关与模式提示；revised prompt 可见便于纠偏（OpenAI 过度触发的教训） |
| 自纠错烧 GPU 时间 | P9 上限 + best-so-far；评估门默认关 |
| Job 输出失控（Claude Code 324GB 日志事故） | Job 日志/产物封顶、定期清理、产物按项目归档 |
| 迁移期双内核并存混乱 | 特性开关单点切换；平价清单全过才删旧；期限：双轨不超过 2 个版本 |

## 9. 实施顺序（概要，细节由迁移计划承载）

S1 provider 修复（流式 tool_calls/num_ctx，模型实测门禁）→ S2 `agent-v2/` 干净实现（thread/loop/jobs/确认/工具面 + harness 测试）→ S3 特性开关切换回合入口 → S4 UI 投影适配（Job 卡/确认卡/输入框解耦）→ S5 删旧与门禁。

## 10. 来源

- Anthropic — Building Effective Agents；Multi-Agent Research System；Effective Context Engineering for AI Agents；Claude Code best practices
- Claude Code 机制分析 — agiflow.io 内部逆向；rdiachenko.com 后台任务机制；官方 issue #88378 / #39027
- OpenHands — docs.openhands.dev（Event Stream Architecture）；arXiv:2407.16741
- LangGraph — docs.langchain.com interrupts/checkpointing
- SWE-agent — arXiv:2405.15793（ACI 四原则）
- smolagents / CodeAct — huggingface.co/blog/smolagents；arXiv:2402.01030
- OpenAI — image_generation tool 官方文档；4o image generation 发布说明；社区停止按钮/过度触发反馈
- Gemini — ai.google.dev image-generation 文档（多轮编辑、thought images）
- Midjourney — 官方 Discord 文档（job 卡片/Remix）
- comfyui_LLM_party — github.com/heshengtao/comfyui_LLM_party（workflow-as-tool 及静默失效反例）
- ComfyUI-Copilot — github.com/AIDC-AI/ComfyUI-Copilot；arXiv:2506.05010
- RefineEdit-Agent — arXiv:2508.17435（评估门消融与不收敛率）
