# ComfyMuse (comfy-agent) 安全与代码质量审查

审查日期：2026-08-13
审查范围：Electron 主进程与 preload、更新链路、Agent 工具层（filesystem/web/system/comfyui/chat-vision）、提示词注入与云策略路由、MCP 服务、凭据存储、治理层（policy/operation-gateway/quota/audit）、CLI。
方式：人工阅读 + 两个并行深度子代理（`electron/main.mjs` 181KB 全量；agent 工具层 8 文件 + 执行链）+ 对既有审查 `docs/reviews/commit-95762c3-review.md`（88 条发现）逐条复验。
测试基线：`node scripts/run-tests.mjs` → **899 tests / 892 pass / 0 fail / 7 skipped**。

审查原则：只记录可由代码与调用链直接证明的问题；设计取舍与部署约定不作缺陷。编号：`N-` 本轮回审新增；`T-` 工具层新增；`F-` 复验既有审查。

---

## 一、新增发现

### N-01 [高] `app:update-download` 接受渲染进程自供 manifest → 任意包安装（RCE） — ✅ 已修复

> 修复（2026-08-13）：`electron/main.mjs` 新增 `verifiedManifest`（仅由 `checkForUpdate()` 在 `verifyUpdateManifest` 通过后写入）；`downloadUpdate()` 改为无参、只使用 `verifiedManifest`（无验签 manifest 即抛错）；`manifest.version` 经 `/^[A-Za-z0-9._-]+$/` 校验后才拼入下载路径；IPC `app:update-download` 不再接收渲染进程 manifest。`installUpdate()` 因 `downloadedUpdate` 只能由安全的 `downloadUpdate()` 写入，链路闭合。

位置：`electron/main.mjs:1263`（IPC `app:update-download`）、`:1795-1821`（`downloadUpdate`）、`:1823-1833`（`installUpdate`）。

- IPC handler 把渲染进程传入的 `manifest` 原样交给 `downloadUpdate(manifest)`；`updateState.manifest` 只是默认参数。
- `downloadUpdate` 从**渲染进程提供的** `manifest.updatePackage.url` 下载 zip，并用渲染进程自带的 `sha256` 校验（`:1813-1817`），随后 `installUpdate()` 把该 zip 直接交给本地 `ComfyUI-Agent-Updater.exe` 应用。
- 签名校验（`verifyUpdateManifest`）只发生在 `checkForUpdate()` → `fetchSignedManifest()`；`downloadUpdate` 既不验签也不核对 manifest 是否为已验签的那份。
- 附加：`:1798` `manifest.version` 未清洗拼入 `join(temp, 'comfy-agent-update-${version}.zip')`，`version: "1.0/../../evil"` 可任意路径写 zip（内容可控）。

结论：渲染进程一旦能执行任意代码（未来 XSS、注入依赖、devtools 误用），即可让主进程下载任意 zip 并安装 → 以当前用户身份 RCE。这绕过了签名更新设计的全部意义。

修复：`app:update-download` 忽略渲染进程参数，只使用已验签的 `updateState.manifest`；`app:update-install` 强制要求 manifest 已通过 `verifyUpdateManifest`；`version` 用 `/^[A-Za-z0-9._-]+$/` 校验。

### N-02 [中] `agent:get-config` 向渲染进程返回解密后的明文 API Key — ✅ 已修复

> 修复（2026-08-13）：返回改为 `publicLLM(config.llm || ...)`，`apiKey`/`_encryptedApiKey` 被剥离，仅暴露 `hasApiKey` 布尔值（`electron/main.mjs:2898-2906`）。

位置：`electron/main.mjs:2886-2892`。`getStoredConfig()` = `prefStore.getAll()`，`PreferenceMemory._load()` 已 `decryptProviders`（`src/agent/memory/preference.mjs:121-132`）把 `provider.apiKey` 换为明文。其余 LLM 通道均经 `publicProvider`/`publicLLM`（`main.mjs:406-417`）脱敏，唯独此通道绕过。
修复：返回 `publicLLM(prefStore.get('llm'))`。

### N-03 [中] 两个窗口均无 `will-navigate` / `setWindowOpenHandler`

位置：`electron/main.mjs:1070-1133`（floating）、`:1153-1195`（main）；全 `electron/` 零匹配。若渲染进程导航到任意源，preload 会在新源上重新执行，远程页面继承**整个** `electronAPI` 桥（含 N-01 update 通道）。
修复：两窗口注册 `will-navigate`（仅放行自身 `file://` 与 dev origin）+ `setWindowOpenHandler`（http/https 一律 `shell.openExternal` 后 deny）。

### N-04 [中] 更新相关请求允许明文 `http://` 回退

位置：`electron/main.mjs:1724`（`fetchJson`）、`:1739`（`fetchBytes`）、`:1499`（`downloadToFile`）。manifest 路径因内嵌 Ed25519 签名不可伪造（防篡改成立），但存在可用性破坏、陈旧 manifest 重放与内容泄露；包路径在 N-01 场景下完全无效。修复：更新请求强制 `https:`。

### N-05 [低/中] API Key “加密”在 `safeStorage` 不可用时静默降级为明文 base64

位置：`src/agent/memory/preference.mjs:46-53`。Windows DPAPI 可用时无问题；不可用时 `enc:` 前缀下是纯 base64（0o600 写入是好的）。修复：不可用时拒绝持久化或只存 `hasApiKey`。

### N-06 [低] `import-workflows` 通道是条件式任意文件读取

位置：`electron/main.mjs:1628-1635` → `src/runtime/workflow-import.mjs:58-87`。渲染进程可传任意 `paths`，内容像 workflow JSON 即被拷入工作流目录并可经 `agent:inspect-workflow` 读回。修复：删除通道或仅接受对话框返回的路径。

### N-07 [低] `agent:config` 持久化未校验的 LLM 配置（绕过 `llm:save-provider` 的 normalize）

位置：`electron/main.mjs:2847-2872`。

### N-08 [低] `agent:workflow-dir` 接受任意目录为 agent 工作流根（`main.mjs:3523-3529`；下游沙箱限定影响）

### N-09 [信息] 杂项

- `main.mjs:1086,1164-1168`：`webPreferences` 未显式 `sandbox: true`（Electron ≥20 默认开启，建议显式）。
- `dist/index.html:6`：CSP 仅 meta 标签（无 `unsafe-eval`，`script-src 'self'` 良好）；主进程未注入 CSP，dev 模式 `localhost:5173` 在其外。
- `request-ledger.mjs:93-108`：prompt/result 明文 JSON 持久化。
- `main.mjs:3719`：`void comfyManager.ensureStarted()` 无 `.catch`；`:1021-1029` 渲染进程日志字段未清洗。
- `agent-process.mjs:147-152`：`env: process.env` 全量传给 worker。
- `main.mjs:123-138` + `:838-840`：`.env` 可控制 userData 路径/更新 URL/MCP host/token，env 配置的 MCP host 绕过 loopback-token 规则。
- `src/agent/tools/comfyui/client.mjs:43-120`：手写最小 WebSocket（未校验 `Sec-WebSocket-Accept`；握手后 `setTimeout(0)` 使接收缓冲无上限）。

---

## 二、工具层（LLM 可控输入）发现

### T-01 [高] 任意本地图片文件读取 → 直送 LLM Provider（无沙箱、无用户知情） — ✅ 已修复

> 修复（2026-08-13）：见“四、修复记录”第 3 项（沙箱授权 + 大小上限 + fail-closed）。

位置：`src/agent/runtime/chat-vision.mjs:17-27`（`collectChatImages`）、`src/agent/tools/comfyui/client.mjs:353-358`（`imageDataUrl`）。

- `collectChatImages` 用正则扫描**每一条用户消息**中的路径式文本（`C:\...`、`/...`），凡 `existsSync` 且为图片扩展名的文件即作为视觉图片加入请求。
- `client.mjs:355-358`：`if (image.path) { readFile(image.path) → base64 }` — **无任何沙箱校验**。
- 触发点：`agent.mjs:3072`（chat 路径）、`intent-router.mjs:293`（每次消息的意图路由）；base64 随后经 `attachVisionImages` 注入 LLM 请求，发送给（可能为云端的）模型提供商。
- 影响：用户消息里提到任意本机图片路径（截图、扫描件、敏感图片）即被无提示读取并外发。

修复：读取前经 `resolveSandboxFile` 校验（根外路径拒绝或要求显式确认）；限制文件大小；UI 明示“本地文件将发送给模型提供商”。

### T-02 [高] 沙箱根来自 LLM 输入时缺省回退（executor 未 fail-closed） — ✅ 已修复

> 修复（2026-08-13）：见“四、修复记录”第 5 项（fail-closed + schema 收紧 + 根覆盖）。

位置：`src/agent/tools/filesystem/mutate.mjs:135-148`、`filesystem/index.mjs:20-28`、`executor.mjs:83-88,101-102`。

- 工具层 `rootInput(input)` 把 `workflowDir/allowedRoots/comfyRoot` 原样作为沙箱根传入 `resolveSandboxPath`；两工具的 schema 均未设 `additionalProperties:false`，LLM 可注入未声明字段 `allowedRoots:[{name:'input',path:'C:\\Users\\victim'}]`。
- 主路径上 `executor.mjs:83-88,101-102` 会用可信 context 覆盖这些字段 —— 但 `:83-85` 在 context 无 `workflowDir` 时**静默回退到 `stepInput.workflowDir`**，`:101-102` 的覆盖是条件性的。任何未注入 context 的调用路径都会回到“LLM 完全控制沙箱根”（任意读+写）。

修复：executor 缺根即抛错（fail-closed）；LLM schema 中去掉 `workflowDir` 或强制 `additionalProperties:false`；可信根只经 `sandboxInput` 通道注入。

### T-03 [高] `filesystem_mutate` 的 `execute` 标志未在工具层 fail-closed — ✅ 已修复

> 修复（2026-08-13）：executor 强制 `execute = context.confirmedFileMutation === true`（见“四、修复记录”第 4 项）。

位置：`mutate.mjs:364,372`、`executor.mjs:97-99`、`src/agent/schemas/confirmation-schema.mjs:30-35`。

- `mutate.mjs` 直接执行 `input.execute === true`（schema 向 LLM 广告 `execute: {type:'boolean'}`）。
- `executor.mjs:97-99` 只在 `context.confirmedFileMutation` 为真时**置位** `execute=true`；为假时**不强制清零**，LLM 写的 `execute:true` 会原样通过（通用 plan 路径 `ctx.confirmedFileMutation = options.confirmedFileMutation === true` → false，`agent.mjs:2303`）。
- 文件编辑专属预览路径会显式 `previewStep.input.execute = false`（`agent.mjs:1757`），证明代码库知道 LLM 会写该标志，但只保护了 preview 路径。
- 通用 plan 确认（`confirmationForPlan`）对 `filesystem_mutate` 只显示“确认文件变更：`action root/path`”通用文案（`confirmation-schema.mjs:30-35`），**不含 diff**。

修复：executor 强制 `enrichedInput.execute = context.confirmedFileMutation === true`（未确认一律 false）；确认 UI 展示实际 diff。

### T-04 [中] Web 工具：LLM 可控 `proxyUrl` / `baiduApiKey`

位置：`src/agent/tools/web/index.mjs:595-596,601,448-482`。恶意 LLM 可将全部抓取路由到攻击者代理（`proxyTunnel` CONNECT），代理可观测抓取目标与明文页面内容、注入响应；`baiduApiKey` 也可被 LLM 替换。修复：代理与 key 只取自可信配置，代理限制 loopback。

### T-05 [中] 外发内容无大小上限、无“发送给 Provider”披露

位置：`web/index.mjs:562`、`src/agent/tools/comfyui/image-inspect.mjs:46-47,75-77`。`inspect_image` 的 dataUrl 无上限返回模型（`runtime.mjs:62` 却限制 8 MiB，不一致）。修复：加大小上限 + UI 披露。

### T-06 [中] ComfyUI `/view` 的 `filename/subfolder/type` 未沙箱校验

位置：`client.mjs:321-342,360-369`、`src/agent/security/sandbox.mjs:137-139`。沙箱只校验 `path`，LLM 提供的 `subfolder:'..'` 等会原样发给 ComfyUI `/view`（历史上有服务端路径穿越风险）。修复：在 agent 边界限制 `subfolder`（拒绝 `..`）与 `type`。

### T-07 [中] LLM 可控上传文件名直达 ComfyUI `/upload`

位置：`src/agent/tools/comfyui/index.mjs:399`（`item.name || basename(filePath)`）、`client.mjs:261-281`。`..\..\x.png`、`x.png:stream` 原样转发。修复：basename 白名单 `[A-Za-z0-9._-]+`。

### T-08 [中] `validateToolInput` 无字符串/数组长度上限 → 内存 DoS

位置：`src/agent/schemas/tool-schema.mjs:105-133`、`mutate.mjs:204,211,222`。`filesystem_mutate` 的 `content/patch/old/new`、comfyui `prompts`、web `providers/allowedDomains` 均无上限，多 GB 字符串会完整物化。修复：validator 强制 `maxLength/maxItems` + 工具内钳制（如 ≤1 MiB）。

### T-09 [中] MCP 直调工具绕过 executor 沙箱

位置：`src/agent/mcp/web-server.mjs:224`（`tool.execute(input, context)` 直调，无 `assertToolCall`，无网络门、无媒体断言）。当前因只暴露只读文件 + 确认门控 mutation + Bearer token 而有界，但后续任何工具加入 `rawTools` 都会静默获得无沙箱执行。修复：MCP 调用走 executor（或同样注入可信根 + `assertToolCall`）。

### T-10 [低] 沙箱解析器细节

- `sandbox.mjs:59-61`：ENOENT 分支用词法切片拼接规范父路径，Windows 大小写不一致时非规范；应只用规范路径。
- `sandbox.mjs:16-18`：`hasParentSegment` 只匹配精确段 `..`，`.. `（尾空格）、`...`（NTFS 别名）、ADS `file.txt:stream` 未匹配（多数被下游 `realpathSync`+`inside()` 兜住）。
- `filesystem/index.mjs:48-51`：自研 resolver 对末段存在 TOCTOU 窗口，且与 sandbox 模块重复实现易漂移。
- `sandbox.mjs:100-102`：相对路径只尝试第一个根（功能怪癖非漏洞）。
- `sandbox.mjs:7-9`：`C:foo` 驱动相对形式语义需显式处理。

### T-11 [低] ComfyUI 客户端细节

- `client.mjs:96,108`：WebSocket 握手后 `setTimeout(0)`，`Buffer.concat` 增长无上限（对恶意对端低风险，因对端是本地 ComfyUI）。
- 无认证头（远程带鉴权 ComfyUI 无法连接 —— 功能限制，非安全漏洞）。

### T-12 [确认良好]

- 主路径沙箱单点执行：`executor.mjs:170` 每步 `sandbox.assertToolCall`，可信根 + `SANDBOX_AUTHORIZED_FILES` 经 `sandboxInput` 注入；comfyui 双重检查（`index.mjs:177`、`:397`）；`inspect_image` 校验 `image` 与 `other`（`sandbox.mjs:138-139`）；网络门（`:134-136`）接入 `researchConfig.allowNetwork`。
- Web 工具 SSRF 防御扎实：协议白名单、内嵌凭据拒绝、localhost/私网/IPv6 映射/云元数据网段拒绝、DNS 解析复核 + `options.lookup` 钉住已验 IP 防 DNS rebinding、重定向逐跳重验且上限 3、2 MiB 原始 + 解压后双重上限（zip-bomb 防护）、页面文本 12k 截断、搜索端点为固定常量、唯一 POST 指向固定百度端点 —— 无任意 POST 原语。
- 无 LLM 可控的 shell/eval/`new Function`；`web/index.mjs:416,420` 的 `reg` 调用参数固定。
- `baseUrl` 仅来自用户配置，LLM 不可改（`client.mjs:193,198-200`、comfyui schema 无 baseUrl 字段）。
- `filesystem_mutate` 动作白名单（write/edit/apply_patch，delete/move/copy 禁）、写前写中双重 hash 校验、失败回滚、patch 解析器严格。
- MCP：`requireAuth` 默认 true（无 token 即 401）、1 MiB body 上限、session 注册表 + principal 校验（F-35 已修复）、CORS `Allow-Origin: null` 在 token 保护下可接受。

---

## 三、对既有审查（commit-95762c3，88 条）的复验结果

### 已修复（当前代码验证通过）

| 旧编号 | 主题 | 当前证据 |
|---|---|---|
| F-03 | `media_compare` 任意文件读取 | `media-tools.mjs:7` 强制 `resolvePath` resolver |
| F-04 | 归档 taskId 目录逃逸 | `result-archive-service.mjs:31-35` ID 正则 + `relative()` 逃逸检查 |
| F-06 | Windows 原子写并发覆盖 | `atomic-write.mjs:29-37` fallback 前重验 hash |
| F-08 | 整数参数接受小数 | `runtime-parameters-contract.mjs:16` `Number.isInteger` |
| F-13 | 取消信号未传 ComfyUI executor | `executor.mjs:177`、`comfy-executor.mjs:53` 已贯通 |
| F-22/23 | direct/agent run-prepared 越权 | `main.mjs:2330,2529` `assertPreviewOwner` |
| F-24 | get-trace 不校验调用方 | `main.mjs:2716+` `assertOwnerMatch(task, currentGovernanceOwner())` |
| F-25 | 启动超时坏进程复用 | `comfyui-manager.mjs:240` 超时 `stopOwned()`，exit 置 null |
| F-35 | MCP session 不校验 principal | `session-registry.mjs:9-13` 增加 principal/tenant 比较 |
| F-40 | quota 并发超配 | `quota-manager.mjs:3` reserve 计入 reservations |
| F-41 | 已取消父 signal 仍执行 | `deadline.mjs:4` 创建时检查 `parentSignal?.aborted` |
| F-42 | audit sink 永久阻塞 | `audit-sink.mjs:11` `.catch(() => {}).then(...)` 可恢复 |
| F-51/52 | MCP bridge 绕过协调器/确认绑定 | `main.mjs:732-811` 走 ledger+coordinator，`assertConfirmationBinding` |
| F-53 | quota 提交伪造用量 | `quota-manager.mjs:4` 校验不超 reservation 并重查 limits |
| F-66 | 恢复任务无并发锁 | `main.mjs:1448-1476` `recoveryPromise` 单飞 |
| F-67 | 禁用 service 仍可调用 | `service-registry.mjs:15` `get()` 对 disabled 返回 null |
| F-68 | service permissions 未参与授权 | `service-policy.mjs:12-17` 校验 `owner.permissions` |
| F-73 | 共享 CloudPolicyRouter 状态污染 | `provider.mjs:524-526` 每请求新建 |
| F-80 | direct:prepare completed 非幂等 | `main.mjs:2188-2200` `REQUEST_TERMINAL`/`REQUEST_IN_PROGRESS` |
| F-83 | direct prepare 未启动 Agent | `main.mjs:2138` `startAgent` |
| F-86 | abandon 误标其他会话任务 | `agent.mjs:3345` `markAbandoned({taskId})` 限定 |

### 仍存在

| 旧编号 | 主题 | 当前证据 | 严重度 |
|---|---|---|---|
| F-09 | CLI `doctor` 失败仍返回退出码 0 | `agent-cli.mjs:620,681-683` 无条件 `EXIT.ok` | 中 |
| F-07 | manifest cache `invalidate` 不清 `pending` | `manifest-cache.mjs:46` 仅 `entries.delete` | 低-中 |
| F-54 | `createIpcGateway` 默认 `senderCheck = () => true` | `ipc-gateway.mjs:1`（main.mjs 未使用该模块，仅测试引用） | 低 |
| F-55 | 非法 deadline（NaN）当无期限 | `deadline.mjs:2-3` | 低 |
| F-74 | LLM cancel 绑定最后登记的 `_controller` | `openai-compatible.mjs:69,130,296`、`ollama.mjs:7,60,182`（上游串行缓解） | 低-中 |
| F-87 | mutation commit 未校验 `previewId` 一致性 | `workflow-mutation-service.mjs:140` 仅检查非空 | 低-中 |

### 未复验

F-01/02/05/10/11/12/14-21/26-34/36-39/43-50/56-65/69-72/75-79/81/82/84/85/88 —— 功能正确性/UI/适配器问题，本轮以安全为主未逐条复验（F-69/F-79 恢复后预览不可执行、F-88 `freezeRuntimeRequest` 未真正冻结属纵深问题，建议后续专题复验）。

---

## 四、修复记录与优先清单

**修复批次 1（2026-08-13）：**
1. ~~N-01 更新 IPC 只用已验签 manifest（含 version 路径注入）~~ → 已修复（`verifiedManifest` 单信任源 + version 白名单）
2. ~~N-02 `agent:get-config` 走 `publicLLM`~~ → 已修复

**修复批次 2（2026-08-13，全量）：**
3. ~~T-01 chat-vision 任意本地图片外发~~ → 已修复：`collectChatImages` 增加 `authorizePath`（沙箱校验，无授权器时文本扫描 fail-closed）+ 10 MiB 大小上限；Agent/IntentRouter 注入 `_authorizeVisionPath`（roots 内才允许）；`client.imageDataUrl` 路径分支 8 MiB 上限兜底
4. ~~T-03 filesystem_mutate 确认未 fail-closed~~ → 已修复：executor 强制 `enrichedInput.execute = context.confirmedFileMutation === true`
5. ~~T-02 沙箱根来自 LLM 输入 / executor 回退~~ → 已修复：executor 对沙箱工具（filesystem/filesystem_mutate/comfyui/inspect_image）缺 `workflowDir` 即抛 `SandboxViolation`（fail-closed）；`allowedRoots`/`comfyRoot` 一律由 context 覆盖；LLM schema 收紧（filesystem/mutate/inspect_image 移除 `workflowDir`/`allowedRoots`/`comfyRoot`，`additionalProperties:false`；`validateToolInput` 新增运行时注入字段白名单）
6. ~~N-03 缺导航守卫~~ → 已修复：两窗口注册 `will-navigate`（仅 file:// 与 dev origin）+ `setWindowOpenHandler`（http/https 转 `shell.openExternal`，一律 deny）
7. ~~N-04 更新链路明文回退~~ → 已修复：`assertHttpsUrl` 应用于 manifest URL/更新包 URL；`fetchJson`/`fetchBytes`/`downloadToFile` 重定向强制 https
8. ~~T-04 proxy/baiduApiKey LLM 可控~~ → 已修复：web schema 移除两字段 + `additionalProperties:false`（executor 路径拒绝）；`execute` 强制代理仅限 loopback（非 loopback 拒绝）
9. ~~T-05 外发无上限/无披露~~ → 已修复：`imageDataUrl` 统一 8 MiB 上限；web 工具与 `inspect_image` 描述明示内容可能发送给 LLM provider
10. ~~T-06 /view 参数未约束~~ → 已修复：`validateViewRef`（filename 禁分隔符/`..`、subfolder 禁 `..`/绝对路径/控制字符/冒号、type 白名单 input/output/temp），应用于 `inspectMedia`/`fetchImageBytes`/`imageDataUrl`
11. ~~T-07 上传文件名未约束~~ → 已修复：`_uploadMedia` 上传名强制 basename + `[A-Za-z0-9._-]` 白名单 + 200 字符上限
12. ~~T-08 输入无长度上限~~ → 已修复：`validateToolInput` 默认 string ≤2 MiB / array ≤50k 项（schema 可覆盖）；mutate 的 content/patch/old/new ≤1 MiB
13. ~~T-09 MCP 直调绕过沙箱~~ → 已修复：`createWebMcpServer` 注入 sandbox 策略，`tools/call` 按工具类别执行 `assertToolCall`（web 网络门 / inspect_image / comfyui 媒体检查）；main.mjs 以 research.allowNetwork 构造策略
14. ~~F-09 doctor 退出码~~ → 已修复：`doctor` 不健康返回 `EXIT.execution`
15. ~~N-05 safeStorage 降级明文~~ → 已修复：`encrypt()` 不可用时返回 null，保存路径丢弃 key 并置 `apiKeyError`（不再落盘可逆明文）
16. ~~F-54 ipc-gateway fail-open 默认~~ → 已修复：默认 `senderCheck = () => false`（fail-closed），测试同步显式传 `() => true`
17. 纵深：两窗口显式 `sandbox: true`；MCP env 配置 host 非 loopback 且无 token 直接抛错；`renderer:error` 日志清洗（截断+去换行）；`comfyManager.ensureStarted()` 补 `.catch`；WebSocket 接收缓冲 16 MiB 上限

**验证：** 18 个修改文件 `node --check` 全部通过；`node scripts/run-tests.mjs` → **899 tests / 892 pass / 0 fail / 7 skipped**；随行为新语义同步更新了 `tests/executor.test.mjs`（沙箱工具需 context 根）、`tests/chat-vision.test.mjs`（无授权器即 fail-closed）、`tests/ipc-governance.test.mjs`（显式 senderCheck）、`tests/preference.test.mjs`（无 safeStorage 不落盘）。

**未修复（设计取舍 / 低风险，建议后续）：**
- N-09 信息项：`.env` 信任边界（应用目录本就用户可写）、`agent-process` 全量 env 透传、request-ledger 明文持久化（可选 safeStorage 加密）、CSP 仅 meta 标签（可选主进程注入）
- F-07 manifest cache `invalidate` 不清 `pending`（竞态窗口小）
- F-55 非法 deadline 静默无期限（NaN，需调用方传坏值）
- F-74 LLM 单 `_controller` cancel 竞态（上游串行化缓解）
- F-87 mutation commit previewId 一致性（workflowName+expectedHash 已有实质约束）
