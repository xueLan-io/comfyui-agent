# ComfyMuse v0.3.7 稳定版测试方案

目标：只验证会影响日常图片生成和项目使用的主链路。H3/AMD 不作为本版本发布阻断项；如果只能生成灰片，只记录为模型/节点输出质量问题，不阻断 UI、进度、会话和归档发布。

## 发布门槛

- `npm test`：0 failed。
- `npm run lint`：通过。
- `npm run build`：通过；已有大 chunk warning 可记录，不阻断。
- Portable 打包：`pack-portable.bat` 成功。
- `resources\app` packaged runtime validation：通过。
- 普通 txt2img 至少成功生成 3 次。
- 图片能够在聊天结果、快速生成结果、资产库和大图预览中显示。
- 进度能够从准备、执行、完成或失败完整收敛。
- 两个会话之间不能互相看到消息、结果、进度或恢复任务。
- 取消、重试、重启后的任务不能产生重复归档或永久 loading。
- 更新页显示“已是最新”时不能错误显示可用版本。

## 自动化检查

在仓库根目录执行：

```powershell
npm ci
npm test
npm run lint
npm run build
node scripts/verify-packaged-runtime.mjs dist-portable\resources\app
```

注意：`verify-packaged-runtime.mjs dist` 是错误用法。`dist` 只是前端资源目录，验证器需要完整的 `dist-portable\resources\app`。

如果已经有 ComfyUI portable 根目录，再执行：

```powershell
pack-portable.bat
```

打包成功后确认：

- `dist-portable\ComfyMuse.exe` 存在。
- `dist-portable\ComfyMuseLauncher.exe` 存在。
- `dist-portable\resources\app\dist\index.html` 存在。
- `dist-portable\resources\app\electron\main.mjs` 存在。
- `dist-portable\resources\app\src\agent\index.mjs` 存在。
- `dist-portable\resources\app\scripts\verify-comfyui-recovery.mjs` 存在。

## 手工测试数据

普通图片测试使用低成本配置：

- 一个已知可用的 SDXL、SD1.5 或 Flux 工作流。
- 分辨率使用 `512 x 512` 或 `768 x 768`。
- steps 使用 `4` 到 `12`。
- batch 使用 `1`。
- 固定 seed 做一次可重复性测试，再换一个 seed 做一次新图测试。
- 正向提示词：`a red apple on a wooden table, soft studio light`。
- 负向提示词：`blurry, malformed, low quality`。

灰片只用于判断“生成链路是否完成”。本版本不把灰片视觉质量当作 UI 稳定性失败，除非输出文件为空、损坏、无法读取或没有被归档。

## A. 启动和连接

1. 关闭 ComfyUI 和 ComfyMuse。
2. 启动 ComfyMuse portable launcher。
3. 确认设置中的 ComfyUI 状态最终变为已连接或已启动。
4. 如果 ComfyUI 未启动，确认错误提示明确且没有无限 loading。
5. 关闭 ComfyUI，再回到应用检查状态能变为断开。
6. 重新启动 ComfyUI，应用能恢复连接。

通过条件：状态能在 `checking -> starting/connected -> ready` 或明确 error 之间收敛；不允许页面卡在“检查中”。

## B. 普通图片生成主链路

1. 新建项目 `Test Project`。
2. 在项目中创建会话 `Session A`。
3. 选择一个普通图片 workflow。
4. 输入测试提示词，选择“生成”或“直接生成”。
5. 确认预览中显示 workflow、正向提示词、负向提示词、尺寸、steps、seed。
6. 点击确认执行。
7. 观察状态：准备、排队、执行、完成。
8. 等待结果出现。
9. 重复生成两次。

每次通过条件：

- 确认卡不会重复出现。
- 确认后不会再次要求确认。
- 状态不会回到 idle 而后台继续跑。
- 进度条至少显示执行中或明确的 indeterminate 状态。
- 完成时进度到 100% 或明确显示完成。
- 结果区显示图片，不是空白卡片。
- 结果消息包含图片引用。
- 输出文件大小大于 0，能够正常读取。
- 同一任务不会出现两份重复归档。

## C. 图片渲染和资产库

对每次成功结果依次检查：

1. 聊天消息中的缩略图。
2. 快速生成浮窗中的结果图。
3. 资产库中的缩略图。
4. 点击缩略图打开大图。
5. 大图左右切换。
6. 另存为。
7. 打开文件位置。
8. 删除资产后刷新资产库。
9. 重启应用后再次打开资产库。

通过条件：

- 图片引用能转换为 data URL 或可用预览 URL。
- 不出现“预览失败”但磁盘文件存在的情况。
- 项目归档图片路径为 `project\images\<taskId>\...`。
- 视频路径为 `project\videos\<taskId>\...`，即使本次不测试视频，也不能污染图片分类。
- 删除只影响当前项目当前资产，不影响其他项目。

## D. 进度、完成和失败状态

分别测试：

- 正常完成。
- workflow 缺少模型。
- ComfyUI 执行中手动断开。
- 点击取消。
- ComfyUI 启动超时。

通过条件：

- 正常完成保留最后一帧 100% 或完成状态。
- 失败显示可读错误，不停在 loading。
- 取消后按钮恢复可用。
- 旧任务的迟到进度不会改写新任务。
- 失败重试不会复用错误的 taskId 或旧 preview。
- 进度至少携带当前 project/session/task 归属。

## E. 会话隔离

1. 在项目 P1 创建会话 A 和 B。
2. 会话 A 发送一条聊天消息并生成一张图。
3. 生成完成后切换到 B。
4. 确认 B 看不到 A 的消息、图片、进度、preview 和恢复任务。
5. 在 B 发送一条不同消息并生成一张图。
6. 快速连续点击 A、B、A，直到完成多次切换。
7. 切换回 A，确认 A 的消息和资产仍然存在。
8. 在项目 P2 创建会话 C，确认 P1 的资产和消息不出现。
9. 在 A 生成过程中尝试切换会话，确认应用拒绝切换并提示先取消。

通过条件：

- 快速切换最终停留在最后一次选择的会话。
- 旧的 `project:state` 不覆盖新会话。
- A 的进度不会出现在 B。
- A 的完成图不会出现在 B。
- recovery task 按 projectId/sessionId 过滤。
- 项目级资产和会话级消息不混用。

## F. 重启和恢复

1. 让一个普通图片任务进入执行状态。
2. 关闭 ComfyMuse，不强制关闭 ComfyUI。
3. 重新启动 ComfyMuse。
4. 打开 recovery task 列表。
5. 监控任务状态。
6. 对已完成远端任务执行归档。
7. 重复点击恢复按钮。

通过条件：

- 已提交任务不会被重新提交。
- 完成结果只归档一次。
- 未完成任务显示 queued/running/unknown，而不是错误地显示 completed。
- recovery 失败能重试。
- 重复点击不会产生重复文件和重复 asset 记录。

## G. 参数和确认一致性

至少检查：

- 固定 seed 预览和执行使用同一个 seed。
- 修改正向提示词后，执行结果使用修改后的值。
- 修改负向提示词后，执行结果使用修改后的值。
- 修改尺寸后，实际 workflow 使用新尺寸。
- 小数 steps、width、height、frames、fps 会在准备阶段拒绝。
- workflow 切换后旧 preview 不能执行。
- 过期 preview 不能执行。

## H. 更新和发布

1. 打开设置的应用更新页。
2. 当前已经是最新版本时确认不显示错误的“可用版本”。
3. 使用测试 manifest 验证签名失败会拒绝安装。
4. 验证错误 SHA-256 的更新包会拒绝安装。
5. 关闭应用后再测试应用层更新。
6. 更新后重新打开项目、会话、资产和设置。

通过条件：

- 更新不会修改 ComfyUI、模型、工作流和用户数据。
- 更新失败不会破坏当前安装。
- 更新后 session/project 数据仍可读取。

## 灰片说明

H3/AMD 本版本只做以下检查即可：

- H3 readiness 能结束，不永久 loading。
- H3 workflow 能被识别。
- 缺少官方节点或模型时，在提交前给出明确错误。
- 如果节点成功执行但输出是灰片，记录为模型、量化、VAE、条件输入或硬件兼容问题。
- 灰片不能作为本版本普通图片 UI 发布阻断项。

H3 不应继续牵引普通图片生成、会话隔离、资产显示和进度修复。它单独留在实验能力中，等有可用硬件和正确模型后再处理。

## 结果记录模板

```text
版本：
系统：
ComfyUI 版本：
workflow：
模型：
测试时间：

自动化：
- npm test：
- npm run lint：
- npm run build：
- portable validation：

普通图片生成：通过 / 失败
图片渲染：通过 / 失败
进度和终态：通过 / 失败
取消和重试：通过 / 失败
会话隔离：通过 / 失败
重启恢复：通过 / 失败
更新：通过 / 未测试 / 失败
H3：未测试 / 灰片 / 通过

失败现象：
taskId：
requestId：
projectId：
sessionId：
相关日志：
```
