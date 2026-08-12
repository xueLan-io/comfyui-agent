# ComfyMuse v0.3.7-rc.1 (Pre-release)

ComfyMuse v0.3.7-rc.1 is available for Windows portable installation and application-only update.

> Pre-release: 此版本已完成主要稳定性收尾，但仍可能存在未覆盖的边界问题。如有异常请回退到 v0.3.6。

## Highlights

- 稳定生成生命周期与会话隔离：生成状态机（generation-state-machine）、运行时状态视图（runtime-status）、direct 路径与 Agent 路径的会话隔离修复。
- 生成记录卡片 UI：生成进度、动作（重新生成 / 编辑 / 调整）与记录卡片（GenerationProgress / GenerationActions / GenerationRecordCard）。
- 消息渲染增强：MarkdownContent 渲染、通知设置（NotificationSettings）与提示音。
- 模型提供商模板：provider-templates + ProviderPickerModal，快速选择常用提供商预设。
- 快捷命令：新增 `/` 斜杠命令（slash-commands），支持工作台布局相关 UI 契约。
- 自定义字体：内置 Starry Display / Starry UI 字体。
- 新增测试覆盖：backend-status-contract、comfy-client-cancel、runtime-status、slash-commands、ui-workbench-layout。

## Downloads

- Full portable package: `ComfyMuse-portable-v0.3.7-rc.1.zip`
- Existing compatible installations: `ComfyMuse-update-v0.3.7-rc.1.zip`
- Release page: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.7-rc.1

The portable package is recommended for first installation or upgrades from an older incompatible version. The application-only package preserves the Electron runtime, ComfyUI installation, models, workflows, user data, and project assets.

## Checksums

```text
ComfyMuse-portable-v0.3.7-rc.1.zip
<build-time checksum>

ComfyMuse-update-v0.3.7-rc.1.zip
<build-time checksum>
```

The signed `manifest-stable.json`, `manifest-stable.json.sig`, and `SHA256SUMS.txt` are attached to the release. The application verifies the Ed25519 manifest signature and update package SHA-256 before installation.

## Verification

- `npm test`: passed, 870 passed, 0 failed, 7 skipped (877 total).
- `npm run lint`: passed, 275 files checked.
- `npm run build`: passed.

## Notes

- ComfyUI is not included. Configure an existing ComfyUI portable root or running ComfyUI endpoint on first launch.
- Models, workflows, and user data are not included in the release archives.
- Close ComfyMuse before applying the application-only update.
- Windows Authenticode signing depends on the release certificate configuration; SmartScreen may show an unknown publisher warning when the certificate is unavailable.
- 本项目已进入低维护状态，后续版本将按需发布。
