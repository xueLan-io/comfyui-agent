# Third-Party Notices

本仓库（ComfyUI Agent / ComfyMuse）自身的代码与文档以 MIT License 授权（见仓库根目录 `LICENSE`）。

以下第三方内容以数据或资源形式包含在本仓库中。请在使用、再分发本仓库前阅读本节。除特别注明外，下述内容不随本仓库的 MIT License 授权，其权利归各上游版权人所有。

## 1. 提示词库数据（Danbooru 标签数据）

- **内容**: `src/components/prompt-library-segments/seg-*.mjs` 中的标签名、分类、计数等元数据
- **来源**: [Danbooru](https://danbooru.donmai.us) 标签 wiki 公开导出数据（SQL 导出，经 WeiLinPrompt 仓库再分发取得，见下节）
- **版权**: © Danbooru（donmai.us）
- **许可**: 无正式开源许可证；Danbooru 服务条款禁止未授权抓取与商业性再分发。本仓库仅以标签名称/元数据形式、出于本地提示词检索的有限目的使用，请在商用前自行核实 Danbooru 使用条款
- **仓库内位置**: `scripts/generate-prompt-library-translations.mjs` 生成；每条数据以 `Danbooru SQL` / `Danbooru 分类` 标注来源

## 2. WeiLin 标签词典

- **内容**: `src/components/prompt-library-segments/seg-*.mjs` 中 Danbooru 标签的中文翻译与分类（与 Danbooru 数据合并生成）
- **来源**: [weilin9999/WeiLin-ComfyUI-prompt-all-in-one](https://github.com/weilin9999/WeiLin-ComfyUI-prompt-all-in-one)（本地快照 `Agent-local-assets/WeiLinPrompt`）
- **版权**: Copyright (c) 2025 WeiLin
- **许可**: MIT License。许可证全文见本文件附录 A

## 3. Super Grimoire 双语词典 / 分类（超级无敌魔导书）

- **内容**: `src/components/prompt-library-segments/seg-*.mjs` 中的英文标签中译与分类（标注为 `Super Grimoire 双语词典` / `Super Grimoire 分类`）
- **来源**: [YUXIANSHENG777/comfyui-super-grimoire](https://github.com/YUXIANSHENG777/comfyui-super-grimoire)（本地快照 `Agent-local-assets/super_grimoire`）
- **版权**: © YUXIANSHENG777（余余先生呀AIGC）
- **许可**: 上游仓库未附带正式开源许可证文件，README 声明"完全免费开源、禁止倒卖"。本仓库仅以词条数据形式、出于本地提示词检索的有限目的使用。若计划商用或再分发，请先联系上游确认授权

## 4. CloudDB 艺术家词库

- **内容**: `src/components/prompt-library-artists.mjs`（`CloudDB_artist_names.txt`）中的艺术家名称清单
- **来源**: [ComfyUI-Prompt-CloudDB](https://huggingface.co/datasets/FRuoL/ComfyUI-Prompt-CloudDB)，ComfyUI-Prompt-Manager 插件的官方云端公共词库（本地快照 `Agent-local-assets/CloudDB`）
- **版权**: 由 ComfyUI-Prompt-Manager 插件社区共同维护（数据集作者 FRuoL）
- **许可**: 上游仓库未附带正式开源许可证文件；README 免责声明仅允许"AI 绘画技术学习、风格研究与插件功能测试"用途。本仓库出于本地提示词检索的有限目的使用。若计划商用或再分发，请先联系上游确认授权

## 5. Nowar 字体

- **内容**: `src/fonts/nowar-sans-ui.ttf`
- **来源**: Nowar Typeface（有爱字库）与 Roboto（Google）
- **版权**: © 2018—2020 Cyano Hao and Nowar Typeface；Portions Copyright 2011 Google Inc.；Portions © 2014-2019 Adobe
- **许可**: SIL Open Font License 1.1，许可证全文见 `src/fonts/LICENSE-Nowar.txt`

## 6. 本地规则分类

- **内容**: `src/components/prompt-library-segments/seg-*.mjs` 中标注为 `本地规则分类` 的分类归并、`prompt-library-artists.mjs` 的整理与去重
- **版权**: © 2026 xueLan-io
- **许可**: 随本仓库 MIT License

---

## 附录 A：WeiLin MIT License

```
MIT License

Copyright (c) 2025 WeiLin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```