# ComfyMuse v0.3.7 稳定版测试结果记录

版本：0.3.7（main @ 5743f36 + P0-5 第九刀）
系统：Windows / Node v24.15.0 / AMD Radeon RX 9060 XT（16 GB VRAM，cuda backend）
ComfyUI 版本：portable（D:\ComfyUI_windows_portable，custom_nodes 完整加载，启动成功）
workflow：anima+miaomiao+8step测试_clean_单图_优化版.json（txt2img）
模型：miaomiaoHarem_anima14（Anima）+ anima-turbo-lora
测试时间：2026-08-15

## 自动化

- npm test：**978 tests / 971 pass / 0 fail**（含重构后行为快照；refactor 前后一致）
- npm run lint：**297 files ok**（refactor 前 295 → 新增 2 模块后 297）
- npm run build：通过（仅既有大 chunk warning，记录不阻断）
- portable validation：**Packaged runtime validation passed**（`dist-portable\resources\app`）
- pack-portable：成功（ComfyMuse.exe / ComfyMuseLauncher.exe / ComfyUI-Agent-Updater.exe / index.html / main.mjs / src\agent\index.mjs / verify-comfyui-recovery.mjs 全部存在；ComfyMuse-portable-v0.3.7.zip 重建）
- 签名：update-signature 2/2 通过；release:manifest 端到端生成 manifest-stable.json + .sig + SHA256SUMS.txt，Ed25519 签名用匹配公钥校验为 true；electron-builder signAndEditExecutable: true；pack-portable 在 RELEASE_CERT 存在时走 Authenticode 签名分支

## 手工矩阵 A–H（headless 实测 + 自动化套件覆盖）

### A. 启动和连接 — 通过（headless 实测）

- ComfyUI portable 启动成功，custom_nodes 完整加载，`system_stats` 可达。
- `doctor`：healthy=true，comfyui reachable，device=cuda:0 AMD Radeon RX 9060 XT，vramTotal 16 GB。
- 断开场景（指向未监听端口 9999）：`status` 返回 `reachable: false, error: "fetch failed"`——明确错误、立即收敛，无无限 loading。

### B. 普通图片生成主链路 — 通过（headless 实测，≥3 次成功）

使用低成本配置：512×512、steps 8、batch 1、固定 seed 42 + 新 seed 43/777。

- 预览：preflight valid、missingModels 空、modelReady true；提示词注入 diff（正向/负向）正确应用。
- 执行：`正在提交 → 已进入队列 → 开始执行 → 执行完成`，状态收敛无重复确认。
- 输出：anima1_00045（seed 42）、00046（seed 43）、00047（seed 42 重复）、seed 777 各一次成功；PNG 签名 89504e470d0a1a0a、512×512、大小 >0、可读；technicalEvaluation passed（comfyui success、outputFiles exists/readable/validFormat）。
- 同任务无重复归档（direct 链路 requestId/taskId 单次）。

### C. 图片渲染和资产库 — 由自动化套件覆盖（GUI 缩略图/大图需人工点验）

- 归档路径 `project\images\<taskId>\...` 与视频分类隔离：由 `result-archive-service` / `media-contract` / `project-assets` 测试覆盖。
- 图片引用 → data URL / 预览 URL、删除只影响当前项目：media-input / project-assets / archive-transaction 测试覆盖。

### D. 进度、完成和失败状态 — 通过（headless 实测 + 套件）

- 正常完成：progress 收敛到 completed，technicalEvaluation passed，最后一帧完成。
- workflow 缺少模型：missing-model-test.json → preflight `valid: false, modelReady: false`，停在预览不执行，明确失败不 loading。
- 不存在的 workflow：`ENOENT` 明确错误，非永久 loading。
- 点击取消：`cancel only interrupts the matching task` / `cancel drops queued tasks` / `drainQueue skips queued after cancel` 测试通过；执行中手动断开由 retry-policy / comfy-client-cancel 测试覆盖。
- 旧任务迟到进度不覆盖新任务：generation-state-machine / progress / agent-state-machine 测试覆盖。

### E. 会话隔离 — 由自动化套件覆盖

- `session-isolation.test.mjs`：A/B 会话消息、图片、进度、preview、recovery task 按 projectId/sessionId 过滤；快速切换停留在最后会话；project 级资产与会话级消息不混用。

### F. 重启和恢复 — 由自动化套件覆盖

- `task-recovery-ledger` / `agent-process` / `session-registry` / `execution-coordinator` 测试：已提交任务不重复提交、完成结果只归档一次、未完成任务显示 queued/running/unknown、recovery 失败可重试、重复点击不产生重复文件/asset。

### G. 参数和确认一致性 — 通过（headless 实测 + 套件）

- 固定 seed 预览和执行同一 seed：settings/parameters 均为 seed 42；重复执行（seed 42 → 00045 与 00047）**SHA-256 完全一致**（A7F2844B…）。
- 换新 seed（43 → 00046）：输出不同（E0E92C66…）。
- 修改正向/负向提示词：patch diff 显示 from→to 正确替换。
- 修改尺寸：settings 传入 512×512，timeEstimate basis width/height 512 生效。
- 小数 steps/width/height 拒绝：`Invalid steps: expected an integer` / `Invalid width: expected an integer`（准备阶段拒绝）。
- workflow 切换后旧 preview 不能执行 / 过期 preview：confirmation-binding / workflow-patch / operation-gateway（confirmationDigest）测试覆盖。

### H. 更新和发布 — 通过（headless 实测 + 套件）

- `update-signature.test.mjs` 2/2：真实 manifest 校验通过、篡改拒绝、畸形签名拒绝。
- `release:manifest` 端到端：manifest-stable.json + .sig（Ed25519）+ SHA256SUMS.txt 生成，签名与匹配公钥 verify=true。
- `ComfyMuse-update-v0.3.7.zip`（应用层更新包）构建成功，packaged runtime validation passed。
- 更新不修改 ComfyUI/模型/工作流/用户数据：更新包只含 `resources\app` 内容（create-update-package.mjs），架构保证。

## 灰片说明

H3/AMD 本次未测（本机为 AMD RX 9060 XT，普通 txt2img 正常出图，非灰片）。H3 不作为本版本阻断项。

## 失败现象

无。

## P0-5 第九刀（拆分验证）

- `chat-flow.mjs`：92 → 61 行（纯编排），对话装配外提到 `chat-request.mjs`（144 行）。
- `turn-flow.mjs`：194 → 25 行（纯编排），回合编排外提到 `turn-ops.mjs`（210 行）。
- 契约测试 `chat-actions.test.mjs` 改读新模块文件（遵循先前切片先例）。
- refactor 前后测试套件完全一致（978/971/0），行为快照未漂移。
