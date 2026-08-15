# Changelog

本项目的版本变更记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。发布产物与详细说明见 [Releases](https://github.com/xueLan-io/comfyui-agent/releases)。

## [v0.3.7] - 2026-08

正式版。基于 v0.3.7-rc.1 的稳定性收尾，纳入 P1 长期记忆、P2 批量创作流水线与 P3 插件生态三项能力（界面中以「预览」徽标标记）。

### Added

- **P1 长期记忆（预览）**：跨会话项目级记忆（风格偏好 / 不要清单 / 常用工作流计数 / 去重记忆段），原子 JSON 持久化，仅注入本地模型；设置页记忆分区可查看 / 编辑 / 清空 / 导出。角色卡因与预设卡及个性分页生态位重叠已移除。
- **P2 批量创作流水线（预览）**：生成队列（seed 矩阵 × 参数组合展开、生命周期与崩溃恢复、暂停 / 取消 / 单条重试、策展 Top-K）、批量工作室与队列 Tab。
- **P3 插件生态（预览）**：`userData\plugins` 目录加载、manifest 校验与 Ed25519 验签、启停 / 移除（含工具注册表注销）、外部技能声明式编辑器。
- 生成记录卡片 UI：生成进度、动作（重新生成 / 编辑 / 调整）与记录卡片，媒体密集记录折叠为单条媒体带。
- 消息渲染增强：MarkdownContent 渲染、通知设置（NotificationSettings）与提示音。
- 模型提供商模板：provider-templates + ProviderPickerModal，快速选择常用提供商预设。
- 快捷命令：新增 `/` 斜杠命令（slash-commands），支持工作台布局相关 UI 契约。
- 自定义字体：内置 Starry Display / Starry UI 字体。
- 工作区检查点：Anima 提示词基线注入。

### Changed

- 稳定生成生命周期与会话隔离：生成状态机、运行时状态视图、direct 路径与 Agent 路径的会话隔离修复；后台任务（归档 / 恢复 / OpenAI 生图）终态直写目标会话快照。
- 工程重构：agent.mjs 按子系统拆分（execution / chat / context / session / web research / preparation / prepared-run 等）、electron/main.mjs IPC 域拆分、App.css（8543 行）拆分为 9 个域样式文件、i18n 表外提、AgentContext 纯函数抽取到 agent-utils.mjs。
- 清理：移除孤立 ProjectSidebar.jsx 重复文件；裁剪捏造的提供商模板（277 → 80）并补充契约测试。
- 未测试的新功能在界面中以琥珀色「预览」徽标与提示条标记。

### Fixed

- 批量 / 队列与记忆边界情况。
- 插件停用 / 移除或启动失败时注销其工具注册。
- 生成终态写入所属会话快照，避免切回会话出现虚空响应。
- JSONFileStore 原子重命名在 Windows 瞬时锁下的重试。
- 修复 lockfile 以支持 `npm ci`，Release workflow 改用 Node.js 22。

### Security

- 安全加固批量：verifiedManifest 单信任源、publicLLM、窗口导航加固、加密 fail-closed、chat-vision 沙箱与 10 MiB 上限、executor fail-closed、代理 / 密钥从 LLM 可见面移除、上传 / 视图引用约束、输入长度上限、MCP 过沙箱、ipc-gateway 默认拒收、doctor 退出码。
- 生成提交绑定预览 digest，配额在治理协调器提交时计费。

## [v0.3.6] - 2026-08

### Added

- 治理的运行时服务与 MiniMax H3 视频生成。
- MCP 生成预览、确认、状态、取消、重复请求、owner、digest 与协调器忙碌覆盖。

### Changed

- 关闭 direct、Agent、service 与 MCP 生成路径的治理和资源所有权缺口。
- 加固归档路径、任务持久化、配额预留、截止时间取消与媒体归一化。

### Fixed

- 防止 Electron 主进程在父输出管道关闭时 `EPIPE` 日志失败成为未捕获异常。
- 从 electron-builder 配置移除不支持的根级 `companyName` 选项。

## [v0.3.5] - 2026-08

- 发布准备与文档更新（详见 GitHub Releases 页面）。

## [v0.3.2] - 2026-08

- 发布准备与文档更新（详见 GitHub Releases 页面）。
- 轮换更新签名密钥。

## [v0.2.1] - 2026-08

- 发布准备（详见 GitHub Releases 页面）。

## [v0.2.0] - 2026-08

- 首个正式版本：Windows 便携版桌面应用 + CLI + MCP 接入。
- 对话式提示词辅助、工作流管理、生成任务跟踪、项目与素材管理。

[v0.3.7]: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.7
[v0.3.6]: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.6
[v0.3.5]: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.5
[v0.3.2]: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.3.2
[v0.2.1]: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.2.1
[v0.2.0]: https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.2.0
