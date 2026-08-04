# ComfyUI Agent

ComfyUI Agent is a Windows desktop assistant for local ComfyUI workflows.
ComfyUI itself is an external dependency and is not included in this repository.

## 开发环境

需要 Node.js 20 或更高版本，以及一个可运行的 ComfyUI portable 目录。

```text
npm install
npm run dev
```

常用检查命令：

```text
npm test
npm run lint
npm run build
```

## 桌面便携版打包

日常使用项目目录中的批处理入口打包：

```text
pack-portable.bat
```

运行该文件即可。若使用桌面快捷方式，请让快捷方式指向项目目录中的脚本。

打包脚本会从当前目录向上查找包含 `python_embeded\python.exe` 和
`ComfyUI\main.py` 的 ComfyUI portable 根目录。

打包前请先关闭正在运行的便携版。打包完成后，桌面会生成：

```text
dist-portable\ComfyUI-Agent.exe
dist-portable\
```

启动 `ComfyUI-Agent.exe` 即可运行便携版。脚本会自动查找上级目录中的 `python_embeded\python.exe` 和 `ComfyUI\main.py`，并把找到的 ComfyUI 根目录写入便携包配置。

## 用户配置

API 密钥、项目、会话和 Agent 数据保存在：

```text
Windows 用户数据目录下的 `comfy-agent` 文件夹
```

重新打包不会删除该目录。不要把 API 密钥放进 `dist-portable`，也不要删除这个用户配置目录。

## 路径规则

- 桌面版默认使用同一 portable 根目录下的 `ComfyUI\user\default\workflows`。
- CLI 的相对路径以命令执行目录为基准；未指定 `--workflow-dir` 时会自动寻找 portable ComfyUI 的工作流目录。
- `AGENT_DATA_DIR` 和 `COMFYUI_PORTABLE_ROOT` 的相对路径以 Agent 应用目录为基准，建议发布配置使用绝对路径。
- 项目图片、视频和 trace 保存在项目目录内；ComfyUI 的 `input`、`output` 和 `temp` 不会混入项目目录。
- 安装版首次运行如果找不到 ComfyUI，请在设置中选择包含 `python_embeded` 和 `ComfyUI` 的 portable 根目录。

## 其他打包方式

项目内的 `build.bat` 使用 `electron-builder`，输出到 `releases\`，适合制作安装包；日常桌面便携版请使用上面的桌面批处理入口。
