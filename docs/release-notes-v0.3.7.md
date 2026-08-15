# ComfyMuse v0.3.7

ComfyMuse v0.3.7 正式版，适用于 Windows 便携安装与应用内更新。

> 本版本基于 v0.3.7-rc.1 的稳定性收尾，并纳入 P1 长期记忆、P2 批量创作流水线与 P3 插件生态三项能力。新功能尚未经过完整验证，已在界面中以「预览」徽标标记。

## Highlights

- 稳定生成生命周期与会话隔离：生成状态机（generation-state-machine）、运行时状态视图（runtime-status）、direct 路径与 Agent 路径的会话隔离修复；后台任务（归档 / 恢复 / OpenAI 生图）终态直写目标会话快照，避免切回会话出现虚空响应。
- 生成记录卡片 UI：生成进度、动作（重新生成 / 编辑 / 调整）与记录卡片（GenerationProgress / GenerationActions / GenerationRecordCard），媒体密集记录折叠为单条媒体带。
- 消息渲染增强：MarkdownContent 渲染、通知设置（NotificationSettings）与提示音。
- 模型提供商模板：provider-templates + ProviderPickerModal，快速选择常用提供商预设。
- 快捷命令：新增 `/` 斜杠命令（slash-commands），支持工作台布局相关 UI 契约。
- 自定义字体：内置 Starry Display / Starry UI 字体。
- **P1 长期记忆（预览）**：跨会话项目级记忆（风格偏好 / 不要清单 / 常用工作流计数 / 去重记忆段），原子 JSON 持久化，仅注入本地模型；设置页记忆分区可查看 / 编辑 / 清空 / 导出。角色卡因与预设卡及个性分页生态位重叠已移除。
- **P2 批量创作流水线（预览）**：生成队列（seed 矩阵 × 参数组合展开、生命周期与崩溃恢复、暂停 / 取消 / 单条重试、策展 Top-K）、批量工作室与队列 Tab。
- **P3 插件生态（预览）**：userData\plugins 目录加载、manifest 校验与 Ed25519 验签、启停 / 移除（含工具注册表注销）、外部技能声明式编辑器。
- 工程重构：agent.mjs 按子系统拆分（execution / chat / context / session / web research 等）、electron/main.mjs IPC 域拆分、App.css 拆分、i18n 表外提。

## Downloads

- Full portable package: `ComfyMuse-portable-v0.3.7.zip`
- Existing compatible installations: `ComfyMuse-update-v0.3.7.zip`
- Release page: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.7

The portable package is recommended for first installation or upgrades from an older incompatible version. The application-only package preserves the Electron runtime, ComfyUI installation, models, workflows, user data, and project assets.

## Checksums

```text
ComfyMuse-portable-v0.3.7.zip
a8e3eaf4c99e0df2a401e42f162180a50c2a6f97bc6662b8f8000847dbd7cb50

ComfyMuse-update-v0.3.7.zip
7bdf419e0384821e67f9662275d59c434d1d824506247e82c66dfbac29a75c7c
```

The signed `manifest-stable.json`, `manifest-stable.json.sig`, and `SHA256SUMS.txt` are attached to the release. The application verifies the Ed25519 manifest signature and update package SHA-256 before installation.

## Verification

- `npm test`: passed, 971 passed, 0 failed, 7 skipped (978 total).
- Renderer smoke tests: 17 passed.
- `npm run lint`: passed, 295 files checked.
- `npm run build`: passed.

## Preview features

长期记忆、生成队列 / 批量、插件与外部技能编辑器在界面中以琥珀色「预览」徽标与提示条标记：这些功能未经完整验证，界面与行为可能调整。

## Notes

- ComfyUI is not included. Configure an existing ComfyUI portable root or running ComfyUI endpoint on first launch.
- Models, workflows, and user data are not included in the release archives.
- Close ComfyMuse before applying the application-only update.
- Windows Authenticode signing depends on the release certificate configuration; SmartScreen may show an unknown publisher warning when the certificate is unavailable.
- 本项目已进入低维护状态，后续版本将按需发布。
