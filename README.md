# ComfyUI Agent

![Platform](https://img.shields.io/badge/platform-Windows-0078D4)
![Electron](https://img.shields.io/badge/Electron-33-47848F)
![React](https://img.shields.io/badge/React-18-61DAFB)
![License](https://img.shields.io/badge/license-MIT-green)

ComfyUI Agent 是一个面向 Windows 的本地 AI 创作桌面助手，用于连接和操作本机的 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 工作流。它提供对话式提示词辅助、工作流管理、生成任务跟踪、项目与素材管理，以及 CLI 工具。

ComfyUI 是外部依赖，不包含在本仓库源代码或发布包的模型目录中。

## 功能

- 运行本地 ComfyUI 工作流
- 支持文生图、图生图、局部重绘、放大、视频和批量生成场景
- 导入、检查、编辑、重命名、删除和收藏工作流
- 本地提示词库、搜索、解析和提示词优化
- 支持 Ollama、LM Studio 和其他 OpenAI-compatible 模型服务
- 管理项目、会话、生成任务、图片、视频和执行追踪记录
- 提供安全边界明确的文件、系统、网络和 ComfyUI 工具
- 提供工作流检查、校验、补丁、生成、队列和诊断命令的 CLI

## 下载使用

从 [v0.2.1 Releases](https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.2.1) 下载最新便携版：

```text
ComfyUI-Agent-portable-v0.2.1.zip
```

解压后运行 `ComfyUI-Agent.exe`。便携版不要求另外安装 Node.js 或 Python。

首次启动时，在设置中选择已有的 ComfyUI portable 根目录，或填写已经运行的 ComfyUI 地址。portable 根目录通常包含：

```text
python_embeded\python.exe
ComfyUI\main.py
```

也可以将程序放在 ComfyUI portable 目录旁边，应用会尝试自动向上查找。模型权重不随本项目发布，请按照 ComfyUI 的要求单独放入 `ComfyUI\models`。

### 从源码运行

要求：

- Windows 10 1803 或更高版本
- Node.js 20 或更高版本
- 一个可访问的 ComfyUI 实例，或 ComfyUI portable 目录

```powershell
npm install
npm run dev
```

## 技术栈

- **桌面运行时**：Electron 33
- **前端**：React 18、React DOM、Vite 5、`@vitejs/plugin-react`
- **业务运行时**：Node.js ES modules（`.mjs`）
- **AI 服务接入**：Ollama、本地 OpenAI-compatible 服务、云端 OpenAI-compatible API
- **图像工作流引擎**：ComfyUI HTTP/WebSocket API
- **构建与发布**：Electron Builder、Windows NSIS、便携版打包脚本
- **测试**：Node.js built-in test runner
- **静态检查**：Node.js `--check` 递归语法检查

## 架构概览

```text
React renderer (src/)
        |
        | Electron preload IPC
        v
Electron main process (electron/)
        |
        +-- Agent runtime (src/agent/)
        |     +-- LLM providers and routing
        |     +-- planning, execution, evaluation and retry
        |     +-- ComfyUI, filesystem, prompt and web tools
        |     +-- project, session, memory and task state
        |
        +-- ComfyUI instance (local HTTP/WebSocket service)
```

- `src/`：React 界面、上下文、CLI 和运行时辅助模块
- `src/agent/`：Agent、模型提供商、工具、任务生命周期和数据结构
- `electron/`：主进程、预加载脚本、Agent worker 和 IPC
- `tests/`：业务模块和运行时行为测试
- `scripts/`：检查和打包验证脚本
- `docs/`：设计审查、验证记录和补充技术文档

## 开发命令

```powershell
# 启动 Vite 和 Electron 开发环境
npm run dev

# 运行测试
npm test

# 检查 src/ 下的 JavaScript 模块语法
npm run lint

# 构建前端资源
npm run build

# 构建 Electron 安装包
npm run pack
```

提交改动前，至少运行 `npm test`、`npm run lint` 和 `npm run build`。`npm run pack` 会生成安装包，可能需要首次下载 Electron Builder 运行时。

## CLI

CLI 通过 `npm run agent --` 调用，默认以预览模式运行；需要真正提交生成任务时显式传入 `--execute`。

```powershell
npm run agent -- workflow list --workflow-dir <dir>
npm run agent -- workflow inspect --workflow image.json --workflow-dir <dir>
npm run agent -- workflow validate --workflow image.json --workflow-dir <dir>
npm run agent -- generate --workflow image.json --positive "a red cat"
npm run agent -- generate --workflow image.json --positive "a red cat" --execute
npm run agent -- queue monitor --prompt-id <id>
npm run agent -- status queue
```

运行 `npm run agent -- --help` 查看完整命令和路径参数。文件相关命令要求显式指定受信任根目录，路径不会默认访问任意位置。

## 配置与数据

可在项目目录放置本地 `.env` 文件：

```text
AGENT_DATA_DIR=.\data
COMFYUI_PORTABLE_ROOT=C:\path\to\ComfyUI_windows_portable
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

- 未设置 `AGENT_DATA_DIR` 时，应用数据默认保存在 Windows 用户数据目录的 `comfy-agent` 下。
- `AGENT_DATA_DIR=.\data` 可启用便携数据模式，使设置、会话和 API key 跟随程序目录保存。
- 默认工作流目录为所选 portable 根目录下的 `ComfyUI\user\default\workflows`。
- 项目图片、视频和 trace 保存在项目目录；ComfyUI 的 `input`、`output` 和 `temp` 目录保持独立。
- API key 仅用于本地配置或系统用户数据目录。不要将 API key 写入 `dist-portable`、发布包或提交 `.env`。

## 发布说明

- 便携版构建：运行 `pack-portable.bat`。脚本会查找 ComfyUI portable 根目录、构建前端并验证打包运行时。
- 安装包构建：运行 `build.bat`，输出写入 `releases\`。
- 发布产物和压缩包不应提交到源代码仓库；相关目录和文件已加入 `.gitignore`。
- ComfyUI、模型权重及其第三方节点遵循各自项目和模型的许可证。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并确认测试、语法检查和构建均通过。

安全问题请按照 [SECURITY.md](SECURITY.md) 说明报告，不要在公开 Issue 中发布 API key、个人数据或可利用的漏洞细节。

## 许可证

本项目采用 [MIT License](LICENSE)。
