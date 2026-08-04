# ComfyUI Agent 核心业务流程审查·第四轮复核（行级证据核验）

报告性质：针对桌面文件 comfy-agent-core-flow-review-supplement.txt 的第四轮复核。
本轮对第三轮报告的全部结论做了逐条代码行级核验，未修改任何业务代码。
审查时间：2026-08-03
审查方式：静态源码阅读 + 调用链核对。
证据等级说明沿用第三轮：已确认 / 高概率 / 待复现。

---

## 一、核验结论汇总

| # | 第三轮结论 | 核验结果 | 关键证据 |
|---|-----------|---------|----------|
| P1-1 | worker 并发执行所有 IPC call，无请求队列 | **已确认** | `electron/agent-worker.mjs:113-136` |
| P1-2 | RPC 超时只删 pending，不停止业务任务 | **已确认** | `electron/agent-process.mjs:264-269` |
| P1-3 | stop/退出无收尾协议，任务不落 abandoned | **已确认** | `electron/agent-process.mjs:303-317`、`main.mjs:1201-1208`、`agent-worker.mjs:138` |
| P1-4 | 重启后内存状态与持久化状态互相矛盾 | **已确认** | `agent.mjs:274-284`、`task-manager.mjs:48-55` |
| P1-5 | 项目状态写入 fire-and-forget | **已确认** | `project.mjs:23-26`、`session-manager.mjs:213-229,402-430` |
| P1-6 | 归档多文件复制非原子 | **已确认** | `main.mjs:276-357` |
| P1-7 | trace 查询按活动项目而非任务 owner | **已确认** | `main.mjs:381-389` |
| P1-8 | Direct 事件无 session/task 过滤 | **已确认** | `main.mjs:709,733,737,743-748`、`AgentContext.jsx:351-362` |
| P2-1 | reconfigure 换 LLM 实例导致取消失效 | **已确认** | `provider.mjs:37-42`、`openai-compatible.mjs:129-131` |
| P2-2 | JSON 损坏被静默当成无数据 | **已确认** | `store.mjs:12-19` |
| P2-3 | Legacy run-prompt 绕过任务生命周期 | **已确认** | `main.mjs:597-623` |

核验结论：**第三轮报告的结论全部准确，无一处需要修正。** 报告对"RPC 被当成任务生命周期管理器使用"的总体判断成立。

---

## 二、逐条行级证据

### P1-1 并发执行、无串行队列

- `agent-worker.mjs:113` `const handleMessage = async message => {...}`：每次消息立即进入 `await invoke(...)`。
- `agent-worker.mjs:135-136` `parentPort.on('message', handleMessage)` / `process.on('message', handleMessage)`：Node/Electron 的消息分发本身不串行化 async handler。
- `agent-worker.mjs:74-96` `invoke` 中 `agent[method](...args)`：`handleTurn`/`prepareGeneration` 长运行期间，`project.set`、`config.llm`、`cancel`、`useSession` 可以并发进入同一个 `agent`。
- 共享可变字段：`agent.mjs:248-259` 的 `_running`、`_taskId`、`_state`、`_traceId`、`_currentPromptId`，以及 `sessionManager.activeProjectId`/`activeSessionId`/`sessionState`。
- 补充观察：`AgentProcessClient`（`agent-process.mjs:256-288`）的 pending Map 只保证"主进程侧可以同时等待多个 RPC"，不提供 worker 侧串行化。这正是报告指出的错位。

### P1-2 RPC 超时与业务任务脱钩

- `agent-process.mjs:266-269`：定时器回调只执行 `this.pending.delete(id)` 和 `reject(...)`。
- 超时路径没有向 worker 发送任何取消消息，也没有 AbortSignal。
- worker 侧 `agent-worker.mjs:128-132`：`invoke` 完成或失败后照常发送 `response/state/event`，只是该 response 因 pending 已删除而被 `agent-process.mjs:236-237` 忽略。
- 结论成立：超时只把调用从前端视野删除，业务副作用（LLM 生成、ComfyUI 提交、项目写入、归档）继续执行且不可追踪。

### P1-3 退出无收尾协议

- `agent-process.mjs:303-317` `stop()`：直接 `_failPending` + `disconnect` + `kill`，最多等 2 秒，不请求任务取消。
- `main.mjs:1201-1208`：`before-quit`/`will-quit` 都是 `void agent?.stop?.()`，fire-and-forget，不等待取消确认。
- `agent-worker.mjs:138` `process.on('disconnect', () => process.exit(0))`：worker 收到 disconnect 立即退出，不把运行中任务标记为 interrupted。
- `agent.mjs:274-284` `init()`：只处理 `awaiting_confirmation` 状态；`task-manager.mjs:48-55` `load()` 原样读入所有任务，queued/executing/observing/retrying 保持非终态。
- 结论成立，且补充确认：worker 被杀不影响 ComfyUI 服务（独立进程），已提交的 prompt 不会被取消。

### P1-4 重启后状态矛盾

- 四套独立状态来源确实可同时存在：
  1. `tasks.json`：`task-manager.mjs:48-55` 原样加载，任务可为 executing。
  2. `conversations.json`：`session-manager.mjs:197-210` 恢复 sessionState，可为 executing。
  3. worker 内存：`agent.mjs:274-284` 未扫描运行态，`_state` 默认 `idle`、`_running` 默认 `false`（`agent.mjs:248-254`）。
  4. 前端：`AgentContext.jsx:224-227` 无 `preparedPreview` 时直接 `setStatus('idle')`。
- 结论成立。

### P1-5 写入 fire-and-forget

- `project.mjs:23-26` `set()`：仅修改内存 + 调 `onChange`，不落盘。
- `session-manager.mjs:213-229` `_saveProjectMemory()`：`void this._persistProjects().catch(() => {})` + `void this._persistConversations().catch(() => {})`。
- `session-manager.mjs:402-430` `setSessionState()`：`void this._persistConversations().catch(() => {})`。
- `agent-worker.mjs:82-89`：`project.set`/`project.update` 在内存修改后立即 return。
- 结论成立：`main.mjs` 里 `await agent.project.set(...)` 只是等 RPC 返回，不等 JSON 文件写完。两个 store 是独立文件，无跨文件事务。

### P1-6 归档非原子

- `main.mjs:276-307`：`mkdir` → 循环 `copyFile`，任一失败直接 throw，前面已复制的文件不回滚。
- `main.mjs:342-354`：索引 `lastImages`/`assets` 更新在复制之后。
- `main.mjs:357`：`persistTaskTrace` 在索引更新之后。
- 结论成立：复制、索引、trace 之间没有临时目录提交或幂等提交标记。

### P1-7 trace 查询按活动项目

- `main.mjs:365-379` `persistTaskTrace`：`agent.taskManager.get(taskId)` → 用 `task.projectId` 定位 owner project，方向正确。
- `main.mjs:381-389` `readTaskTrace`：先 `getActiveProject()`，从当前活动项目读 `traces/<taskId>.json`；仅当文件不存在时才用 `task.projectId` 做兜底判断。
- 结论成立：跨项目任务在未切回 owner 项目时读到 null。

### P1-8 Direct 事件无过滤

- `main.mjs:709,733,737,743-748`：`direct:status`/`direct:progress` 只带 `source`/`requestId`（progress 为 `{...progress, source, requestId}`）。
- `AgentContext.jsx:351-362`：`onDirectStatus`/`onDirectProgress` 回调不调用 `isCurrentAgentEvent`（`AgentContext.jsx:264-269`），也不比较 requestId。
- 结论成立：旧 Direct 事件可直接改写当前 AI 任务的 `status`/`statusMsg`/`generationProgress`/`generationPending`。

### P2-1 reconfigure 换实例

- `provider.mjs:37-42` `reconfigure()`：合并配置后 `_createInstance()` 重建 `_instance`。
- `openai-compatible.mjs:129-131` `cancel()`：只 abort 当前 `_controller`；`openai-compatible.mjs:125` 在请求结束时若 controller 仍是自己才置空。
- 结论成立：config.llm 并发执行时，旧请求还在旧实例、旧 controller 上，新 cancel 只作用于新实例。

### P2-2 JSON 损坏静默

- `store.mjs:12-19` `load()`：单个 `catch` 同时覆盖 readFile 失败、JSON.parse 失败、格式错误，全部落为 defaults。
- 且 `session-manager.mjs:164` `init()` 末尾 `await this._persistAll()` 会把 defaults 写回原文件。
- 结论成立，且补充确认了"损坏后覆盖写回"这条破坏性路径存在。

### P2-3 Legacy run-prompt 旁路

- `main.mjs:597-623` `run-prompt`：读 workflow → 改 `widgets_values` → `ComfyUITool.execute(...)` → 只返回 `promptId`/`images`。
- 没有创建 Agent task、没有 trace、没有 `archiveProjectResult`、不写 `project.assets`、不写会话完成消息。
- 结论成立。

---

## 三、对第三轮报告中"刁钻时序推演"的复核

四个场景（A 超时重试、B 关闭重开、C 归档中删除资产、D 切配置同时取消）的前提全部有代码支撑，推演成立。需要补充的一点：

- 场景 C 除"归档 vs 删除资产"竞争外，还存在 `main.mjs:343-354` 的 `assets` 读取是 `agent.project.get('assets')`（无版本/时间戳检查），多次并发归档时用旧数组追加，可能重复记录或覆盖删除结果。这与 P1-5 的 fire-and-forget 叠加，风险更高。

---

## 四、测试盲区复核

第三轮列的 10 项盲区与现有测试结构一致。补充确认：`agent-process.mjs:10` 的 `DEFAULT_RPC_TIMEOUT_MS = 900000`（15 分钟）意味着超时路径在正常测试中几乎不可达，进一步说明"可控 fake worker/fake ComfyUI harness"的必要性。

---

## 五、修复优先级复核与建议排序

第三轮的优先级排序合理。本次复核补充两点排序建议：

1. 在"worker 状态调用串行化 + task-scoped cancellation"（一-1）落地前，建议同步合并"RPC 超时与业务 task 解耦"（一-2），因为两者共享同一套 requestId/taskId/AbortController 绑定改造，分开做会产生两次接口改动。
2. "退出时落 abandoned + 启动扫描"（一-3）可与 P1-4 的启动恢复一起做，共用同一套非终态任务收敛逻辑。

其余条目（二-5 归档原子提交、二-6 trace 按 owner、二-7 flush/commit 结果；三-8 JSON 损坏恢复、三-9 Direct preview 治理、三-10 Legacy 统一合同）独立性强，可并行推进。

---

## 六、结论

- 第三轮报告**全部 12 条结论核验通过，无需修正**。
- 本轮未修改任何业务代码；工作区中既有改动保持不变。
- 核心判断再次确认：任务的唯一 owner 与终态缺失，是当前全部 P1 问题的根因；RPC 只是传输层，不能充当任务生命周期管理器。
- 现有基线（npm test 445 passed / 2 skipped / 0 failed，lint/build 通过）仍不能证明并发、退出恢复、归档竞态安全，因为上述路径基本不在现有测试覆盖内。
