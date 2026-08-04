# ComfyUI Agent

ComfyUI Agent is a Windows desktop assistant for local ComfyUI workflows.
ComfyUI itself is an external dependency and is not included in this repository.

## Download

The portable Windows package is available from the [v0.2.0 release](https://github.com/xueLan-io/comfyui-agent/releases/tag/v0.2.0).

Download:

```text
ComfyUI-Agent-portable-v0.2.0.zip
```

Extract the ZIP and launch `ComfyUI-Agent.exe`. No Node.js or Python installation is required for the portable package.

On first launch, configure an existing ComfyUI portable root, or use a ComfyUI instance that is already running. A portable root contains:

```text
python_embeded\python.exe
ComfyUI\main.py
```

ComfyUI models are not included. Install or copy models into the ComfyUI `models` directory separately.

## Features

- Local ComfyUI workflow execution
- Text-to-image, img2img, inpaint, upscale, video, and batch workflows
- Prompt library with local search and prompt editing
- Local Ollama or LM Studio providers
- OpenAI-compatible cloud providers
- Project, session, and asset management
- CLI workflow inspection and generation commands

## Development

Requires Node.js 20 or later and a working ComfyUI portable directory.

```text
npm install
npm run dev
```

Run the checks before submitting changes:

```text
npm test
npm run lint
npm run build
```

## Build A Portable Package

Close any running portable build first, then run:

```text
pack-portable.bat
```

The script searches parent directories for `python_embeded\python.exe` and
`ComfyUI\main.py`, builds the frontend, validates the packaged runtime, and
creates `ComfyUI-Agent-portable-v0.2.0.zip`.

For an Electron installer build, run `build.bat`. The installer output is written to `releases\`; Electron Builder may need to download its runtime the first time it runs.

## Data And Paths

- API keys, projects, sessions, and Agent data are stored in the Windows user data directory under `comfy-agent`.
- The desktop app uses `ComfyUI\user\default\workflows` inside the selected portable root by default.
- Relative CLI paths use the command working directory. If `--workflow-dir` is omitted, the CLI searches for the portable ComfyUI workflow directory.
- Project images, videos, and traces stay inside the project directory.
- ComfyUI `input`, `output`, and `temp` directories remain separate from project files.
- Do not put API keys into `dist-portable` or commit `.env` files.

Optional local configuration can be placed in `.env`:

```text
AGENT_DATA_DIR=.\data
COMFYUI_PORTABLE_ROOT=C:\path\to\ComfyUI_windows_portable
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

## License

MIT License. See [LICENSE](LICENSE).
