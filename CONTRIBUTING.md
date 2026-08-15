# Contributing

感谢参与 ComfyUI Agent。提交 Issue 或 Pull Request 前，请先确认问题可以在当前版本复现，并避免在公开内容中包含 API key、模型凭据、个人数据或本地绝对路径。

## 开发环境

- Windows 10 1803 或更高版本
- Node.js 20 或更高版本（CI 使用 Node.js 22）
- `npm install` 已完成
- 用于本地验证的 ComfyUI 实例或 portable 目录

## 工作流程

1. 从 `main` 创建主题分支。
2. 保持改动聚焦，避免将无关格式化或构建产物混入提交。
3. 新增或修改业务逻辑时同步补充 `tests/` 中的测试。
4. 提交前运行：

```powershell
npm test
npm run lint
npm run build
```

界面或渲染逻辑改动请同时运行 `npm run test:ui`（渲染进程冒烟测试）。

5. 在 Pull Request 中说明改动目的、验证命令和已知限制。涉及界面变化时附上截图或录屏。

## 代码约定

- 遵循现有的 JavaScript ES modules、React 和命名风格。
- 优先使用小而明确的改动，不为尚未存在的外部消费者添加兼容层。
- 不提交 `node_modules/`、`dist/`、`releases/`、`dist-portable/`、压缩包、可执行文件或 `.env`。
- 修改 IPC、文件系统、网络请求、任务状态或模型调用时，明确说明权限边界和失败行为。
- 面向使用者的行为变化请同步更新 [README.md](README.md) 与 [CHANGELOG.md](CHANGELOG.md)；新发布版本在 `docs/` 下补充发布说明。

## Issue 与 Pull Request

Issue 请包含版本、Windows 版本、复现步骤、预期行为、实际行为和相关日志。请先删除凭据和敏感路径。

Pull Request 标题应简明描述改动。维护者会重点检查行为变化、错误处理、数据安全、测试覆盖和对便携版构建的影响。
