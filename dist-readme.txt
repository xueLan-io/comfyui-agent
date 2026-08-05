ComfyUI 智能创作台 - 便携版
==============================

一、快速开始
  双击 ComfyUI-Agent.exe 即可启动，无需安装 Node.js 或 Python。

二、首次使用（三种方式任选其一）
  1. 本机已有 ComfyUI：启动后点击"配置"，选择包含
     python_embeded 和 ComfyUI 文件夹的根目录即可。
  2. ComfyUI 已在运行：在"配置"中填写其地址（默认
     http://127.0.0.1:8188，局域网其他机器填 http://IP:8188）。
  3. 全新安装：在"配置"中选择"下载 ComfyUI portable"，
     程序将从官方源下载并自动解压、启动（约 1~2 GB，不含模型）。

  提示：把本文件夹放在 ComfyUI portable 根目录旁边时，
  程序会自动向上探测并找到它，无需手动配置。

三、配置模型
  打开"设置 - 模型"：
  - 本地：Ollama 或 LM Studio（无需 API Key）
  - 云端：DeepSeek / GLM / Moonshot / DashScope 等 OpenAI 兼容接口

四、便携数据模式（可选）
  在本文件夹内创建 .env 文件（UTF-8 编码），可固定数据目录：

    AGENT_DATA_DIR=.\data
    COMFYUI_PORTABLE_ROOT=D:\ComfyUI_windows_portable
    COMFYUI_BASE_URL=http://127.0.0.1:8188

  AGENT_DATA_DIR 指向本文件夹内 data 目录时，设置、会话、
  API Key 都跟随本文件夹，可随 U 盘迁移；不配置时数据
  保存在系统 AppData 目录。

五、常见问题
  1. 启动报"未找到内置 ComfyUI"：请按第二部分配置。
  2. 下载安装后仍无法生成：确认磁盘剩余空间足够（模型
     权重需另行下载到 models 目录）。
  3. 双击无反应：检查 Windows 10 1803 及以上版本。

六、更新方式
  完整便携包只需首次下载。后续更新请使用
  ComfyUI-Agent-update-v*.zip，不要重新下载完整便携包。
  关闭程序后，将更新包解压到现有 dist-portable 文件夹并覆盖
  resources\app 目录。不要删除或替换 electron.exe 及其旁边的
  Chromium 运行时文件。

卸载：直接删除本文件夹即可，不留注册表残留。
