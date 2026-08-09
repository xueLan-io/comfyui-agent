# Commit 95762c3 Review

目标提交：`95762c3 feat: add governed runtime services and MiniMax H3 video generation`

审查范围：相对父提交的 143 个文件，`4168 additions / 222 deletions`。

审查原则：只记录能够由代码和调用链直接证明的问题。仅有设计疑虑、风格问题、测试不足或依赖具体部署约定的内容不列为缺陷。本次审查不修改业务代码。

截至当前：完整测试 `731 passed / 0 failed / 7 skipped`。测试全绿不代表下列并发、权限和边界条件已经覆盖。

## Findings

### F-01 [高] IPC 写操作缺少确认绑定，合法 UI 操作会被治理层拒绝

位置：`electron/main.mjs:237-245`，以及 `:2479-2487`、`:2513-2527`、`:2588-2622`。

`runGovernedIpcMutation()` 将 `confirmation` 原样传给治理网关，但这些调用点没有传入确认绑定。`policy-engine.mjs:18` 对 `project.write`、`session.write`、`comfyui.cancel` 等动作要求确认，`OperationGateway.run()` 随后会在执行前校验确认摘要。因此项目创建、重命名、删除，会话创建、队列取消、任务归档等 handler 会在执行函数前返回确认错误，原来的 IPC 操作不会发生。

### F-02 [高] `service_status` / `service_result` 缺少请求资源所有权校验

位置：`src/runtime/service-invoke.mjs:31-32`，`src/runtime/service-tools.mjs:11-12`。

这两个公开工具只要求 `serviceId`，任意 `requestId` 或 `taskId` 会被直接传给 service，或者用于查询 ledger。代码没有校验 principal、tenant、project、session、preview 或 request owner，调用者可以查询其他请求的状态、结果和媒体引用，绕过本提交新增的治理所有权模型。

### F-03 [高] `media_compare` 可读取任意可读本地文件

位置：`src/runtime/media/media-tools.mjs:7`，`src/runtime/media/media-metadata.mjs:17-23`，`src/agent/mcp/web-server.mjs:162-164`。

`media_compare` 直接把输入路径传入 `inspectMediaFile()`，执行文件存在性检查、stat、SHA-256 哈希和图片读取。MCP 创建媒体工具时没有提供 allowed roots 或路径 resolver。启用该工具的调用者可以读取任意可读本地文件的大小、哈希、文件名及图片元数据。

### F-04 [高] 归档服务的 `taskId` 可逃逸项目目录

位置：`src/runtime/media/result-archive-service.mjs:24-30`。

`taskId` 未限制为安全单段 ID，且拼接后没有验证目标路径仍位于项目目录内。类似 `../../outside` 的值会使 `mkdir`、临时文件写入和最终 rename 落到项目目录之外。

### F-05 [高] Workflow revision 保存了错误方向的备份内容，rollback 不能恢复目标 revision

位置：`src/agent/tools/comfyui/workflow-mutation-service.mjs:149-153`，`workflow-revision-store.mjs:24-30`，`workflow-mutation-tools.mjs:48`。

commit 先将新 workflow 写入磁盘，但随后用 `current.content`（提交前内容）作为该 revision 的 backup。revision 元数据的 `afterHash` 却指向新内容。rollback 读取该 backup 并写回，因此 rollback 到 revision R 实际恢复的是 R 之前的内容，而不是 R 代表的内容。

### F-06 [高] Windows atomic write fallback 存在并发覆盖窗口

位置：`src/agent/tools/filesystem/atomic-write.mjs:8-37`。

目标文件的 expected hash 只在函数开始检查一次。Windows rename fallback 在之后直接将目标文件移动为 backup，再将临时文件置为目标。如果首次检查后另一写入者修改目标文件，fallback 不会重新检查，会静默覆盖并发写入，破坏 workflow commit/rollback 依赖的 optimistic hash protection。

### F-07 [中] manifest cache 的进行中加载会在 invalidate 后写回旧缓存

位置：`src/agent/tools/comfyui/manifest-cache.mjs:14-41,46-47`。

`invalidate()` 只删除已完成的 `entries`，不处理 `pending`。若旧的异步 `resolveManifest()` 在 invalidate 后完成，仍会执行 `entries.set()`，使刚失效的旧 manifest 重新进入缓存。

### F-08 [中] 运行时参数契约允许整数参数使用小数

位置：`src/runtime/runtime-parameters-contract.mjs:13-18,43-45`。

`steps`、`width`、`height`、`batch`、`frames`、`fps`、`seed` 都只检查有限数值和范围，不检查整数性。因此 `frames: 1.5`、`steps: 10.5`、`width: 1024.5` 等输入会进入适配器并写入 workflow。

### F-09 [中] CLI `doctor` 检测失败仍返回退出码 0

位置：`src/cli/agent-cli.mjs:601-616,681-684`。

`runDoctor()` 会输出 `healthy: false`，但 dispatch 对 `doctor` 无条件返回 `EXIT.ok`。ComfyUI 不可达或设备检查失败时，脚本和 CI 仍会得到成功退出码。

### F-10 [中] service preview 成功调用后可重复消费

位置：`src/runtime/service-invoke.mjs:19-29`。

成功 invoke 后 preview 没有删除或标记为已消费，也没有强制通过 ledger 去重。同一个未过期 `previewId` 可再次调用非幂等 service，重复触发副作用。

### F-11 [高] service 生成调用链停在 prepared，不会真正执行生成

位置：`src/runtime/service-invoke.mjs:23-29`，`src/runtime/builtin-service.mjs:15-21`。

`ServiceInvoker.invoke()` 调用 service 的 `invoke()` 后直接返回。内置 ComfyUI generation service 的 `invoke()` 只调用 `directService.prepare()`，返回 `state: 'prepared'` 和一个 preview，没有调用 `directService.run()`。公开 service surface 没有后续 service run 工具，因此通过 `service_invoke` 请求生成不会提交 ComfyUI，也不会产生结果。

### F-12 [高] MCP 媒体 inspect/download 工具没有注入 resolver，启用后必然不可用

位置：`src/agent/mcp/web-server.mjs:162-163`，`src/runtime/media/media-tools.mjs:4-8`，`src/runtime/media/media-download-service.mjs:5-17`。

MCP 使用无参数的 `createMediaTools()`。因此 `media_inspect` 没有 `resolvePath`，调用时必然抛出 `A media resolver is required`；`media_download` 使用没有 `assetResolver` 且 `allowedRoots` 为空的默认服务，无法解析资产并会拒绝所有输出路径。该 MCP 功能声明为可选公开工具，但启用后没有一条成功调用链。

### F-13 [高] Agent 取消信号未传递给 ComfyUI executor

位置：`src/agent/runtime/executor.mjs:163-169`，`src/runtime/executor/comfy-executor.mjs:41-53`。

Agent 已将父信号写入 `enrichedInput.signal`，但调用 `executeToolInput()` 时只传入了 `workflowDir`、`sandboxInput` 和 `onProgress`，没有传入 `signal`。`ComfyExecutor.executeToolInput()` 的参数 `signal` 因而是 `undefined`，并用它覆盖工具输入中的 signal。父级取消无法中止 ComfyUI 的提交、观察和等待流程。

### F-14 [高] 外部 Skill 的已校验 workflow 可被调用上下文替换

位置：`src/agent/skills/external.mjs:71-81`。

外部 Skill manifest 的 `target.workflowName` 经过安全名称校验，但生成步骤使用：

```js
workflowName: context.workflowName || target.workflowName || ''
```

调用上下文提供 `workflowName` 即可替换 manifest 指定 workflow。这样外部 Skill 的执行目标不再由已校验的 manifest 固定，运行时上下文可以绕过该 Skill 的 workflow 约束。

### F-15 [中] workflow mutation 成功后 Agent 仍停留在确认状态

位置：`src/agent/runtime/agent.mjs:1519-1529`。

workflow mutation commit 成功后只删除 `_preparedRuns` 中的预览并返回，没有清除 session 的 `preparedPreview`、`pending`、`needsConfirmation`，也没有将 Agent 状态从 `awaiting_confirmation` 转为 idle/completed。下一次请求仍会看到待确认状态，但再次确认时预览已经被删除并报告过期。

### F-16 [中] 丢弃 workflow mutation preview 会完成错误的历史任务

位置：`src/agent/runtime/agent.mjs:1463-1477`，`:1723-1729`。

`prepareWorkflowMutation()` 没有为预览创建或绑定 task，但 `discardPrepared()` 在丢弃预览时使用全局 `this._taskId` 调用 `taskManager.complete()`。如果该字段仍指向此前任务，拒绝新的 workflow mutation 会把无关任务标记为 `cancelled/confirmation_declined`。

### F-17 [中] 结果媒体去重会丢弃同名不同引用

位置：`src/runtime/generation-contract.mjs:10-23`。

结果去重键只使用 `path`、`filename` 或 `url`，不包含 `subfolder`、`type`、`mediaType` 或 `assetId`。例如不同 node/subfolder 下的两个 `result.png` 会被认为是同一个媒体，第二个引用被丢弃。

### F-18 [中] 归档结果同时包含 images/videos/media 时会重复归档

位置：`src/runtime/media/result-archive-service.mjs:12-13`。

当调用方未传 `media` 时，归档服务会把 `result.images`、`result.videos` 和 `result.media` 全部拼接。`normalizeGenerationResult()` 又会同时保留这三个字段，因此同一媒体可能进入归档列表多次，产生重复文件和 asset 记录。

### F-19 [中] 归档取消被转换成可重试的普通失败

位置：`src/runtime/media/result-archive-service.mjs:18-20,38-43`。

循环检测到 abort 后抛出 `CANCELLED`，但外层 catch 无条件返回 `archive_failed` 和 `retryable: true`，并把 task 标记为 `archive_failed`。上层无法区分用户取消和归档故障，取消任务会被当成可重试失败处理。

### F-20 [中] H3 readiness 面板的 loading 状态不会结束

位置：`src/components/H3VideoPanel.jsx:6,13-20,26`。

成功和失败回调都直接保存返回对象，没有将 `loading` 设为 `false`。因此渲染条件始终优先显示“检查中”，即使 readiness 请求已经成功返回或明确失败。

### F-21 [中] H3 面板可把视频控制污染到非 H3 生成请求

位置：`src/components/H3VideoPanel.jsx:32`，`src/components/QuickGenerateFloat.jsx:644`，`src/contexts/AgentContext.jsx:745,774-789`。

“应用”按钮只调用全局 `setGenerationControls`，没有检查当前 workflow 是否为 H3，也没有检查 readiness。H3 的 frames/fps 等 settings 会被写入共享 generation controls，之后普通图片 workflow 也会读取这些 controls，造成跨 workflow 的生成参数污染。

### F-22 [高] `direct:run-prepared` 使用预览自身 owner，未校验当前调用方

位置：`electron/main.mjs:2036-2058`。

该 handler 在执行 prepared preview 时使用 `executionOwner(preview)`，而不是当前 IPC 调用方的 project/session，并且没有像 `direct:get-preview`、`direct:discard-preview` 那样调用 `assertPreviewOwner()`。知道其他 project/session 的 `previewId` 后，可以通过该 handler 执行该 preview。

### F-23 [高] `agent:run-prepared` 在 coordinator 没有 preview 时仍绕过边界执行 Agent preview

位置：`electron/main.mjs:2332-2349`。

当 coordinator 找不到 `previewId` 时，handler 不拒绝请求，仍把原始 ID 传给 `agent.runPrepared()`，而 coordinator 的 owner 校验路径不会执行。只要 Agent 内部 `_preparedRuns` 仍有该 preview，就可以绕过 IPC 边界的 preview owner 检查执行它。

### F-24 [高] `agent:get-trace` 校验的是 trace 自身，不是当前调用方

位置：`electron/main.mjs:604-623,2414`。

读取 trace 时以 task 自己的 `projectId/sessionId/tenantId` 作为 expected owner，等价于校验“trace 与 task 一致”，没有将其与当前 IPC 调用方的 owner 比较。知道其他 taskId 的调用者可以读取对应任务 trace。

### F-25 [高] 启动超时后坏的 ComfyUI 进程仍被 manager 复用

位置：`electron/comfyui-manager.mjs:210-227`。

启动轮询超时只把状态设为 error 并返回，没有停止当前进程、清空 `this.process` 或释放启动锁。后续 `ensureStarted()` 会因 `this.process` 仍存在而跳过重新启动，导致一个未就绪进程被永久复用。

### F-26 [高] CLI `agent:turn` 等 RPC 超时后仍可能继续执行副作用

位置：`electron/agent-process.mjs:301-306` 及 `:12` 附近的 task-scoped method 集合。

超时回调只有在能从参数中提取 taskId 时才自动发送 cancel；`prepareGeneration`、`prepareWithWorkflow`、`runPrepared`、`handleTurn`、`chat` 等方法没有可靠的 task-scoped cancel 路径。调用方已经收到 timeout 后，worker 仍可能继续准备或提交生成，重试会造成重复执行。

### F-27 [中] ComfyUI manager 释放启动锁早于旧子进程退出

位置：`electron/comfyui-manager.mjs:279-280`。

`stopOwned()` 调用 `killTree()` 后立即释放锁，但旧进程的 exit 事件可能尚未发生。另一个 manager 可以立即取得同一锁并启动新进程，造成短时间双进程、端口竞争，并允许旧进程的迟到 exit 回调覆盖新进程状态。

### F-28 [中] `setStartupLockPath()` 更换路径时遗留旧锁

位置：`electron/comfyui-manager.mjs:112-116`。

方法直接替换 `startupLockPath`，没有先释放旧路径；同时保留 `startupLockHeld = true`。之后释放操作会针对新路径执行，旧锁文件会永久残留，新的路径却未必实际持有锁。

### F-29 [中] Agent RPC worker error 后仍可能被认为可用

位置：`electron/agent-process.mjs:152-161,77,295-296`。

`error` 事件只失败 pending 请求，没有立即清理 child 或标记 fatal。error 到 exit 之间如果 child 仍显示 connected，新的 RPC 仍可发送给已处于错误状态的 worker，最终表现为无意义的超时而非进程不可用。

### F-30 [中] 取消回调失败后仍保留 `cancelRequested = true`

位置：`electron/execution-coordinator.mjs:104-113`。

取消开始时设置 `cancelRequested = true`，但取消回调抛错时只恢复 phase 和 cancelPromise，没有恢复该标志。任务表面恢复为 running，后续执行仍会读取取消标志并按取消路径处理结果。

### F-31 [中] H3 工作流切换到普通 workflow 后 generation page 不会恢复

位置：`src/components/QuickGenerateFloat.jsx:363-365`。

代码只在识别到 H3 时设置 `generationPage('video')`，从 H3 切换到普通 workflow 时不设置回 `image`。此时 `videoPage` 仍为真但 `h3Selected` 为假，`generationReady` 会持续为 false，普通图片 workflow 被错误阻塞，直到用户手动切换页面。

### F-32 [中] AnimateDiff adapter 使用完整 inputs 索引写入 widgets_values

位置：`src/agent/tools/comfyui/adapters/animatediff.mjs:26-32`。

adapter 用 `node.inputs` 中 frames/fps 的数组索引直接访问 `widgets_values`。ComfyUI 的 `widgets_values` 只对应未连接 widget；当 frames/fps 前面存在 link 输入时，数组索引发生偏移，参数会写入错误控件。

### F-33 [中] 直接生成重试无条件覆盖用户指定 seed

位置：`src/runtime/direct/direct-service.mjs:231-236`。

每次可重试失败后都用随机数覆盖 `request.settings.seed`，包括用户显式指定 seed 的请求。这样同一已确认请求的实际重试参数发生变化，结果不再由用户确认的 seed 决定。

### F-34 [中] 结果媒体去重键不能区分不同 subfolder 的同名文件

位置：`src/runtime/generation-contract.mjs:14-17`。

该条与 F-17 同一根因，但补充影响：ComfyUI 常见的不同输出节点可以产生同名文件，引用的 `subfolder/type` 被忽略后会丢弃后续结果，导致归档和 UI 结果列表缺媒体。

### F-35 [中] HTTP MCP session 只验证 session 存在，不验证所属 principal

位置：`src/agent/mcp/web-server.mjs:284-298`。

HTTP 请求会解析当前 principal，但后续只调用 `sessionRegistry.assertSession(requestedSession)` 验证 session ID 有效，没有比较 session 创建时保存的 principal 与当前请求 principal。持有有效 bearer token 且知道其他 session ID 的调用者可以访问该 session 的 MCP 请求上下文。

### F-36 [中] CLI 治理执行器丢弃治理层 signal 和 deadline

位置：`src/cli/agent-cli.mjs:299-302`。

治理网关会将 `{ signal, deadline }` 传给 `execute`，但 CLI 使用 `execute: () => execute()`，没有转发这些参数。因此通过 governed CLI 执行的长操作无法响应治理层的取消和 deadline。

### F-37 [高] runtime preview 将 prompt 对象写入 H3 的字符串 widget

位置：`src/agent/tools/comfyui/runtime-parameters.mjs:13,55`，`src/agent/tools/comfyui/adapters/minimax-h3.mjs:78-86`。

`compileRuntimeParameters()` 将规范化后的 request 直接传给 adapter，而规范化 request 的 `prompt` 是包含 `positive`、`positivePrompts`、`negative` 的对象。H3 adapter 却使用 `input.prompt` 作为 prompt widget 值，因而会把整个对象而不是文本写入 H3 节点的 prompt 输入。

### F-38 [高] workflow active-node 判断错误地排除省略 `mode` 的节点

位置：`src/agent/tools/comfyui/workflow-adapter.mjs:9-13,150-153`，`src/agent/tools/comfyui/prompt-profile.mjs:1-3`。

代码把 `node.mode === 0` 作为 active 节点；只要 workflow 中存在一个显式 `mode: 0` 节点，就会排除所有省略 `mode` 的节点。ComfyUI 中省略 mode 的节点通常也是 active。混合格式 workflow 会因此漏掉模型需求、采样器、输出节点和 prompt targets，导致 manifest、校验和实际运行预览错误。

### F-39 [高] workflow link 校验遗漏目标节点和输入

位置：`src/agent/tools/comfyui/workflow-inspect.mjs:103-143`。

`validateLinks()` 检查了源节点、源输出数量和 link ID，但没有检查 link 的目标节点是否存在、目标节点是否 active、目标输入索引是否有效，也没有拒绝负的源输出索引。损坏的 link 因而可能被报告为 valid，调用方会依据错误校验结果继续执行。

### F-40 [高] quota reservation 不计入并发 reservation，允许并发超配

位置：`src/runtime/governance/quota-manager.mjs:1-6`。

`reserveQuota()` 只用 `used` 判断额度，不加上现有 `reservations`。额度为 1 时两个并发请求都可以看到相同的已用量并成功预留 1，导致 admission 接受超过配置额度的并发请求。

### F-41 [高] 已取消的父 AbortSignal 不能阻止治理执行启动

位置：`src/runtime/governance/deadline.mjs:1-4`。

`deadlineSignal()` 只监听父 signal 未来发生的 abort，没有在创建 controller 时检查 `parentSignal.aborted`。父请求已经取消时，返回 signal 仍未 aborted，`OperationGateway.run()` 仍会调用 execute。

### F-42 [高] audit sink 一次写入失败后永久继承 rejected queue

位置：`src/runtime/governance/audit-sink.mjs:11-12`。

队列字段直接保存当前写入 Promise。若一次 mkdir/appendFile 失败，该 Promise 变为 rejected；之后的 emit 继续在该 rejected Promise 上调用 `.then()`，不会再尝试实际写入。一次临时 I/O 错误会使实例剩余生命周期内的审计事件全部无法落盘。

### F-43 [中] retention 删除成功但审计失败时同时计为 deleted 和 failed

位置：`src/runtime/governance/retention.mjs:21-30`。

删除计数在文件删除后已经增加，但随后 audit 失败会进入同一 catch，再增加 failed，并可能抛错。结果统计同时报告删除成功和失败；`continueOnError: false` 时，文件已经删除但调用方收到失败异常。

### F-44 [中] LLM 请求完成后不移除调用方 AbortSignal listener

位置：`src/agent/llm/ollama.mjs:48-52,128-131`，`src/agent/llm/openai-compatible.mjs:69-73,169-172`。

调用方 signal 的 abort listener 只在 fetch 抛错路径移除，成功响应、JSON 解析和流式读取完成路径都保留 listener。频繁调用会持续保留已完成请求相关的闭包和 controller，造成长期资源泄漏。

### F-45 [中] `includeWorkflowMutationTools: false` 仍暴露 workflow mutation 工具

位置：`src/agent/mcp/web-server.mjs:160`。

配置为 false 时，代码仍返回 `[WorkflowMutationPreviewTool, WorkflowRevisionListTool]`，只有 true 时才增加 commit 和 rollback。调用方无法通过该选项关闭整个 workflow mutation surface，参数的关闭语义没有兑现。

### F-46 [中] TaskStore 一次持久化失败后永久阻塞后续 flush

位置：`src/runtime/task-store.mjs:5,9-11`。

`flushPromise` 在写入失败后保持 rejected，后续 flush 只会继续继承该 rejection，不再重新执行写入。`put()` 和 `delete()` 又是 fire-and-forget，因此临时磁盘错误后，内存状态和持久化状态会永久分离，直到重新创建 store 实例。

### F-47 [中] H3 硬件 profile 的 runtime 配置被丢弃

位置：`src/config/minimaxH3HardwareProfiles.json:6,12`，`src/components/h3-video-controls.mjs:3-11`。

配置声明了 `recommendedReservedVramGiB` 和 AMD `cpuOffload`，但 `controlsFor()` 返回值只包含 `name`、`hardware`、`settings`、`nodeOverrides` 和 `outputNodeIds`，没有返回 `runtime`。因此这些 profile 配置不会进入 generation request、资源估算或执行控制。

### F-48 [中] H3 quant 修复脚本使用硬编码绝对路径

位置：`scripts/repair-h3-quant-metadata.mjs:3-4`。

脚本固定操作 `D:/ComfyUI_windows_portable/ComfyUI/...`，没有参数、环境变量或相对根目录配置。应用安装到其他路径时脚本会操作错误路径并失败；package 也没有提供可配置的脚本入口。

### F-49 [中] H3 quant 修复脚本不是原子修复，后续校验失败会留下部分文件

位置：`scripts/repair-h3-quant-metadata.mjs:24-30`。

脚本边校验 tensor 边直接写回原 safetensors 文件。前几个 tensor 已写入后，后续 key 缺失或长度不符会抛错，但不会恢复原文件。最终备份是完整旧文件，当前文件却是部分修复状态。

### F-50 [中] DirectService 未执行预览会永久占用 busy 状态

位置：`src/runtime/direct/direct-service.mjs:88-102,124-129`。

预览写入 `_previews` 后，只有成功执行或显式 discard 才删除；没有过期清理或实例销毁清理。用户只预览不执行时，`isBusy` 永久为 true，后续调度会持续认为 direct service 忙，且预览快照持续累积。

### F-51 [高] MCP generation bridge 绕过 coordinator、ledger 和确认摘要绑定

位置：`electron/main.mjs:626-650`，`src/agent/mcp/web-server.mjs:125-132`。

MCP generation bridge 直接调用 `DirectService.prepare/run` 和归档逻辑，没有经过 `ExecutionCoordinator`、`RequestLedger`、`OperationGateway` 或 `assertConfirmationBinding()`。MCP 工具只检查 `confirmation === true`，没有校验确认内容与 preview/request digest 的绑定。因此 MCP 生成既可与 Electron 任务并发提交，也没有统一的幂等、恢复和确认边界。

### F-52 [高] MCP generation status/cancel 不校验当前 session 或资源 owner

位置：`electron/main.mjs:641-649`。

bridge 根据任意 `requestId`、`taskId` 或 `previewId` 直接查询 ledger、读取 trace、取消 Agent 任务、丢弃 direct preview 或取消当前 direct service。这里没有 MCP session、principal、tenant、project、session owner 校验。知道其他请求标识的 MCP 调用者可以读取或操作其他会话的任务。

### F-53 [高] quota 提交阶段允许调用方伪造实际用量突破上限

位置：`src/runtime/governance/operation-gateway.mjs:55`，`src/runtime/governance/quota-manager.mjs:4`。

执行完成后 `input.actualQuota` 直接传入 `commitQuota()`。`commitQuota()` 不检查 limits，也不限制 actual 不得超过 reservation。调用方可以预留小额 quota、在完成时提交更大的 `actualQuota`，使 `used` 超过配置上限。

### F-54 [高] IPC gateway 默认 sender 校验为放行

位置：`src/runtime/governance/ipc-gateway.mjs:1`。

`senderCheck` 默认值是 `() => true`。集成方一旦忘记传入校验函数，任意 IPC sender 都会被视为已授权并进入治理执行路径。授权边界的默认行为是 fail-open，而不是拒绝未配置的 sender 校验。

### F-55 [高] 非法 deadline 会被静默当成无期限

位置：`src/runtime/governance/context.mjs:21-22`，`src/runtime/governance/deadline.mjs:2-4`。

deadline 未经过有限数值校验。传入字符串、`NaN` 等不可转换值后，`remainingMs()` 返回 `NaN`，`deadlineSignal()` 不创建 timer，最终操作失去 deadline 约束而不会被拒绝。

### F-56 [高] Agent clarification plan 会在准备阶段被错误判为缺少 ComfyUI 步骤

位置：`src/agent/runtime/planner.mjs:285-290`，`src/agent/runtime/agent.mjs:1290`。

planner 明确生成 `status: 'clarify'` 且 `steps: []` 的 clarification plan，schema 也允许这种计划。但 Agent prepare 流程随后无条件要求 plan 中存在 ComfyUI step。触发缺少媒体或意图不明确的 clarification 后，计划不会返回澄清请求，而会抛出“prepared plan has no ComfyUI execution step”。

### F-57 [高] `comfyui_get_output` 声明 image/video 输出但实际返回不含对应字段

位置：`src/agent/tools/comfyui/runtime.mjs:55-66`，`src/agent/schemas/plan-schema.mjs:114-130`。

工具声明 `output_types: ['image', 'video']`，实际结果却是 `{ promptId, mode, outputs, count }`。executor 的 expected-output 检查通过声明后，会根据实际结果查找 `result.image` 或 `result.images`，因而合理的 `expected_output: 'image'` 计划在实际执行后被判定为 Unexpected output。

### F-58 [中] auto 路由选中的本地 provider 不健康时跳过云端 fallback

位置：`src/agent/llm/provider.mjs:326-335,460-499`。

auto 策略下，如果 active provider 是本地 provider，健康探测失败会直接返回 error；即使存在可用云端 provider，也不会进入后续 fallback。结果是本地服务暂时不可用时请求直接失败，与同一 provider 路由中存在云端 fallback 的预期不一致。

### F-59 [中] runtime 工具未声明输出类型，合理的计划 expected_output 会被拒绝

位置：`src/agent/tools/comfyui/runtime.mjs:23-66`，`src/agent/schemas/plan-schema.mjs:71-130`。

新增 queue/status/history/object-info/system-stats 等查询工具大多使用空的 `output_types` 和宽泛 `{ type: 'object' }` schema。planner 对 `queue`、`status`、`logs` 等实际输出类型没有可匹配声明，因此包含这些合理 `expected_output` 的计划会在校验阶段被拒绝，新增查询工具无法正常进入规划链。

### F-60 [中] Agent context 的默认工具清单遗漏新增 runtime 工具

位置：`src/agent/schemas/context-schema.mjs:76`。

默认 `availableTools` 没有包含本提交新增的 runtime status/queue/history/object-info/system-stats/output/cancel/interrupt/runtime-parameters 工具。实际 registry 与提供给 LLM/planner 的上下文清单不一致，正常路由不会知道这些已注册能力。

### F-61 [中] 精确 node override 绕过节点整数、枚举和范围校验

位置：`src/agent/tools/comfyui/node-overrides.mjs:19-31,86-107,145-149`。

`setOverride()` 只根据当前 JavaScript 值类型做转换，不使用节点 manifest 的 INT、范围和 enum 定义。`steps: 8.5`、超范围 cfg 或非法 sampler enum 会被报告为 applied，随后直接进入实际 prompt。通用 runtime settings 的校验不能覆盖 nodeOverrides，因此该入口仍可注入节点不接受的值。

### F-62 [中] Skill compatibility blocker 不会阻止不兼容 Skill 被选中

位置：`src/agent/skills/compatibility.mjs:9-14`，`src/agent/skills/matcher.mjs:14-20`，`src/agent/runtime/planner.mjs:282-313`。

匹配结果会记录 workflow capability blocker，但澄清逻辑只检查 `missing`，不会过滤或拒绝带 blocker 的候选。于是明确要求 `inpaint` 等能力、而当前 workflow 不具备该能力时，Skill 仍可能被选中并生成执行计划，最终把不兼容 workflow 送入 ComfyUI，而不是重新选择或澄清。

### F-63 [中] 无 AI fallback 丢失视频请求的 frames/fps

位置：`src/agent/runtime/planner.mjs:56-85,282-309`，`src/agent/skills/video.mjs:33-40`。

fallback 只把 images、modelType、promptProfile 等上下文传给 `skill.steps()`，没有传 `videos`、`frames`、`fps`；而视频 Skill 只从 context 读取这些字段。`extractRequestedSettings()` 也不解析 frames/fps。因此不需要 AI 规划的简单视频请求，即使用户指定帧数或 FPS，生成计划仍使用 workflow 默认值。

### F-64 [中] `attachMediaToPlan()` 会删除计划原有但当前附件集合为空的媒体字段

位置：`src/agent/runtime/planner.mjs:92-105`。

对于每个 ComfyUI step，只要当前 context 中某个媒体数组为空，就执行 `delete step.input[kind]`。这不是只补充用户附件，而会删除 Skill/Planner 已经生成的 videos、masks 或 images 字段，导致后续冻结请求和执行阶段丢失原计划媒体。

### F-65 [中] MCP 默认 Skill 集合遗漏 HighFrequencySkills

位置：`src/agent/mcp/web-server.mjs:151,176-179`，`electron/main.mjs:656-666`，`src/agent/skills/index.mjs:28-30`。

Agent 默认 registry 使用 `BUILTIN_SKILLS`，包含 `HighFrequencySkills`；MCP 默认却把 `skills` 设为基础 `SKILLS`，并以此创建 registry。嵌入式 MCP 也从基础集合构造 active skills。因此 MCP 的 skills list/match/requirements 看不到代码已注册的高频 Skill。

### F-66 [高] 恢复任务没有并发锁，重复状态请求可重复归档同一结果

位置：`electron/main.mjs:1192-1217,3020-3021`。

`agent:status` 每次都会调用 `recoverAgentTasks()`，该函数没有进行中锁或任务级去重。两个并发状态请求可以同时得到同一已完成任务，在任一请求结算任务前都调用 `recoverResult()` 和 `archiveProjectResult()`，产生重复文件、重复资产更新和重复 ledger 结算。

### F-67 [高] 禁用 service 仍可通过已知 ID prepare/invoke

位置：`src/runtime/service-registry.mjs:15-18`，`src/runtime/service-invoke.mjs:9-10,23-27`。

`list()` 默认过滤 `service.enabled === false`，但 `get()` 不检查 enabled；`ServiceInvoker.prepare()` 和 `invoke()` 直接使用 `get()`。因此禁用 service 只从列表隐藏，知道 ID 的调用者仍可创建 preview 并执行它，紧急下线无法阻断执行。

### F-68 [高] service manifest permissions 没有参与授权决策

位置：`src/runtime/service-policy.mjs:12-19`，`src/runtime/service-invoke.mjs:24-27`。

`assertServiceConfirmation()` 只读取并返回 `manifest.permissions[action]`，不验证调用者是否拥有该 permission，也不拒绝未声明 permission。ServiceInvoker 只校验 owner、confirmation 和 preview identity，manifest 声明的 execute/mutate/read 权限因此不产生实际授权效果。

### F-69 [高] 重启后恢复出的待确认 preview 必然无法执行

位置：`src/agent/runtime/agent.mjs:316-327,403-413,1485-1487`。

`init()` 会从持久化 session state 恢复 `awaiting_confirmation` 和 `preparedPreview`，但 `_preparedRuns` 只存在内存中，没有恢复对应的执行计划。用户确认时 `handleTurn()` 找到 previewId 后调用 `runPrepared()`，由于 `_preparedRuns` 为空，只能返回“执行计划已失效”。因此恢复 UI 状态与实际可执行状态不一致。

### F-70 [高] Worker 暴露的 `recoverTasks()` RPC 不在 worker 白名单中

位置：`electron/agent-process.mjs:97`，`electron/agent-worker.mjs:21-50,107-138`。

客户端提供 `recoverTasks()` 并发送同名 RPC，但 worker 的 `agentMethods` 没有 `recoverTasks`，`invoke()` 也没有独立分支。进程模式调用任务恢复时会直接返回 `RPC method is not allowed: recoverTasks`，Electron 的恢复链无法通过该客户端接口工作。

### F-71 [中] TaskStore 重复 load 不会删除磁盘中已移除的旧任务

位置：`src/runtime/task-store.mjs:6`。

`load()` 只向现有 Map 写入文件内容，没有先清空 `this.tasks`。同一个实例先加载任务 `a,b`，文件后来只剩 `a`，再次 load 后内存仍保留 `b`；后续 list/get/flush 还可能继续暴露或重新写回已从磁盘删除的任务。

### F-72 [中] TaskStore 持久化后无法读取非字符串任务 ID

位置：`src/runtime/task-store.mjs:6-10`。

`put()` 用 `String(value.id)` 作为 Map key，但 `load()` 使用原始 `task.id` 作为 key。数字 ID 写入文件并重新加载后，`get(123)` 会查询字符串 key `"123"`，返回 null；同时数字 `1` 和字符串 `"1"` 在 load 时还可能成为两个 Map 项。

### F-73 [高] 共享 CloudPolicyRouter 的状态会污染并发 LLM 请求

位置：`src/agent/llm/provider.mjs:277,507-573`。

`LLMProvider` 只有一个 `CloudPolicyRouter` 实例，但多个 `chat()` 请求可以并发调用其 `review/useLocal/block/complete`。路由器只有单一全局 state，没有 request scope；请求 B 在请求 A 处于 cloud_allowed 时开始 review 可能触发非法状态转换，或被请求 A 的 complete 提前重置为 idle。并发聊天会出现与响应顺序相关的随机策略错误。

### F-74 [中高] LLM cancel 不是按请求绑定，可能取消错误的并发请求

位置：`src/agent/llm/provider.mjs:373-375,576-578`，`src/agent/llm/openai-compatible.mjs:66-72`，`src/agent/llm/ollama.mjs:45-52`。

Provider 只保存一个 `_active`，底层 provider 只保存一个 `_controller`。云端调用没有按实例串行，后启动请求会覆盖 controller；调用 `cancel()` 时只能取消最后登记的请求，不能保证取消调用方指定的请求，存在取消错误请求的确定性竞态。

### F-75 [中] 云端 SSE 缺少 `[DONE]` 仍会被视为成功

位置：`src/agent/llm/openai-compatible.mjs:130-168`。

流式读取结束后只在 `this.local` 为真时检查 `sawDone`。云端 OpenAI-compatible 响应即使没有 `[DONE]`，也会返回 assistant 内容作为成功结果。代理截断或服务端异常关闭时，不完整内容可能继续进入上层计划或结构化输出解析。

### F-76 [中] `set_property.title` 接受任意 JSON 类型

位置：`src/agent/tools/comfyui/workflow-mutation-service.mjs:8,75-78`。

`set_property` 只限制属性名为 `title` 或 `mode`；`title` 没有字符串校验。对象、数组、数字和布尔值都可以被写入 UI workflow 节点标题字段，提交后产生非法 workflow 数据。

### F-77 [中] Adapter detection 对缺少 type 的节点抛出 TypeError

位置：`src/agent/tools/comfyui/workflow-adapter.mjs:158,162-167`。

`types` 直接取 `node.type`，随后对每个值调用 `includes()`。workflow 中只要存在缺少 `type` 的节点，Flux/SDXL/AnimateDiff/ControlNet/IPAdapter 检测路径就会抛出 TypeError，而不是返回 generic 或明确的 workflow validation error。

### F-78 [中] mutation 结构校验不拒绝重复 node ID

位置：`src/agent/tools/comfyui/workflow-mutation-service.mjs:62-68,70-73`。

校验只把 node ID 放入 Set，没有比较节点数量与 Set size。重复 ID 会通过结构校验，后续 mutation 只修改 `.find()` 返回的第一个节点，而 prompt/link 映射按 ID 工作流可能覆盖或引用不确定。该歧义 workflow 仍可被提交。

### F-79 [高] 重启后恢复出的待确认 preview 只能澄清，不能继续执行

该条与 F-69 属于同一根因的调用层表现：持久化只恢复了 session/UI 状态，没有恢复内存中的 `_preparedRuns` 执行计划。确认路径最终只能返回“请重新提交生成请求”，因此当前恢复状态并不能兑现“恢复待确认操作”的语义。

### F-80 [高] `direct:prepare` 对 completed requestId 不是幂等操作

位置：`electron/main.mjs:1950-1956`。

当 request ledger 中相同 `requestId` 已经是 `completed`、但没有旧 preview 时，代码只拦截 `executing/observing`，随后再次调用 `DirectService.prepare()`。同一个逻辑 request 可以重新变成 prepared 并再次执行，覆盖已完成请求的生命周期和结果。

### F-81 [高] 手动 recovery 完成归档后没有完成 request ledger

位置：`electron/main.mjs:2431-2439,2464-2471`。

`agent:monitor-task` 和 `agent:retry-recovery` 已经将 TaskManager 任务 settle 为 completed 并返回 completed，但没有对 `task.requestId` 调用 `requestLedger.complete()`。因此 task 状态与 request status 可以长期不一致，后续 requestId 幂等判断仍可能把已完成任务当成 observing 或旧状态。

### F-82 [高] direct 归档失败后 task 状态与 retry/archive handler 不兼容

位置：`electron/main.mjs:2117-2123`，以及 `:716-724`、`:2479-2487`。

归档异常会通过 `completeDirectTask(...error...)` 将 task 标记为 `failed`，但 `agent:archive-task` 只接受 `submit_unknown`、`observe_timeout`、`archive_failed`、`observing` 等状态。于是 request ledger 记录 `archive_failed`，task 却是 `failed`，生成结果无法通过该归档入口重试。

### F-83 [高] `direct:prepare` 未启动 Agent 时仍允许进入 prepared/run 链

位置：`electron/main.mjs:1906-1950`、`:2036-2166`。

direct prepare/run 路径没有像 Agent prepare/generate 路径那样先 `startAgent()`。Agent 尚未初始化时，task 只生成临时 taskId，不会进入 TaskManager；后续归档无法写入项目资产和 trace，但调用仍可能向 UI 返回完成结果，造成生成结果已完成而任务、trace、项目持久化缺失。

### F-84 [中] 取消通知把 taskId 填入 requestId

位置：`electron/main.mjs:2179-2193`。

该路径同时持有 coordinator 的 `taskId` 和 preview 的 `requestId`，但发送 `direct:status` 事件时将 `requestId: entry.taskId`。当两者不相同时，renderer 按 requestId 更新状态或查询 ledger 会无法匹配原请求，取消状态不能正确收敛到对应请求。

### F-85 [中] 取消聊天后执行非法 `cancelled -> failed` 状态转换

位置：`src/agent/runtime/agent.mjs:2721`。

`cancel()` 已把 Agent 状态设置为 `cancelled`，被中断的 chat catch 路径却无条件调用 `_transitionState('failed')`。该转换不在状态机允许边中，会再次抛出 `Invalid task state transition`，使正常取消表现为状态机错误。

### F-86 [高] `Agent.abandon()` 会把其他 session 的任务全部标记为 abandoned

位置：`src/agent/runtime/agent.mjs:2802-2803`，`src/agent/runtime/task-manager.mjs:280-289`。

abandon 使用 TaskManager 的全量 `markAbandoned()`，没有按当前 project/session 或 taskId 过滤。放弃当前会话任务时，其他会话仍在运行、排队或观察的任务也会被批量改成 abandoned。

### F-87 [高] mutation commit 未校验 input.previewId 与 preview.previewId 一致

位置：`src/agent/tools/comfyui/workflow-mutation-service.mjs:129-136`。

commit 只检查 `input.previewId` 非空，未检查它是否等于传入 preview 的 `previewId`。因此调用者可以携带一个有效 preview/frozenContent，但使用任意非空 ID 通过该身份校验提交，预览绑定字段没有真正生效。

### F-88 [中] `freezeRuntimeRequest()` 只深拷贝，不执行不可变冻结

位置：`src/runtime/runtime-parameters-contract.mjs:71`。

函数返回 `structuredClone()` 结果，没有对根对象或嵌套 settings/nodeOverrides/media 执行 `Object.freeze()`。调用方可以在确认后修改所谓 frozen request，使 request digest、确认内容和最终执行参数脱钩。

## 已检查但暂不列为缺陷

- H3 视频引用的 `input/` 前缀依赖具体 ComfyUI 节点约定，当前证据不足。
- `refImageSize` 是否应属于公共运行时契约，当前无法排除有意限制。
- runtime preview 是否必须执行完整硬件和模型 preflight，属于接口语义取舍。
- FFmpeg `reject()` 后的 close 处理存在改进空间，但当前无法证明一定产生错误的外部行为。
- `signal` 未定义变量候选不成立，实际函数入口存在局部 `signal`。
- Skill fallback 的 schema 不完整，但当前无法证明 MCP transport 一定会因该兼容返回失败。

## 后续审查

本轮已继续覆盖 Electron 主进程与 worker 生命周期、MCP/CLI、Agent runtime、Skill/Tool 注册、workflow 工具、媒体服务、治理模块、LLM provider、H3 UI/适配器和修复脚本。新增条目仍需满足上述高置信标准。

以下候选在本轮复核中没有纳入：仅依赖具体 ComfyUI 节点实现的 Wan/H3 widget 顺序、plugin permissions 是否应限制 capability、WindowRegistry 返回对象是否要求不可变、以及部分低概率跨进程写入竞态。它们目前缺少足够直接的调用链证据，按审查原则暂不列为确定缺陷。
