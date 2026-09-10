## 真 TS 迁移（零构建链）：先升 Electron，再渐进转 .ts

### Phase 0 — Electron 升级尖刺（承重墙，先验证）
1. `electron ^33.2.0 → ^44`（最新稳定，内置 Node 24.19，类型剥离默认开启）；electron-builder 如不兼容一并升。
2. 半小时尖刺验证：写个临时 `test.ts`，确认 ① 主进程 `electron.exe .` 能直接 import .ts；② `utilityProcess.fork` 的 agent-worker 也能加载 .ts。
3. 冒烟：`npm run dev` 起来点一遍核心流程、`npm test` + `test:ui` 全绿、`npm run build` + 打包流程验证。
4. CI：release.yml 的 Node 版本确保 ≥22.18（建议直接升 24 对齐本地）。
5. 兜底：若升级撞墙（预期不会，已排查无高危 API），回退为 Electron 33 + 纯 JSDoc/checkJs 方案。

### Phase 1 — TS 基础设施
1. `typescript` devDep；`tsconfig.json`：strict、noEmit、**erasableSyntaxOnly**、moduleResolution nodenext、allowJs+checkJs，include 初期限定已迁移切片（保证 typecheck 起步零错误，随迁移扩大）。
2. `npm run typecheck` 脚本，挂进 `lint` 链和 release.yml。

### Phase 2 — 契约层先转真 .ts（引用方同步改 specifier）
- `src/agent/schemas/*.mjs`（plan/tool/event/context/skill 等 + context-sanitizer）→ .ts
- `src/agent/events/agent-events.mjs` → .ts
- `src/runtime/generation-contract.mjs`、`src/runtime/global-presets.mjs`（渲染层共用，Vite 原生支持）
- `src/agent/index.mjs` barrel → .ts
- 硬约束：显式 `.ts` 扩展名 import、类型导入加 `type`、无 enum/namespace（const 对象 + 联合类型）
- 同步 sed 更新 tests/ 和 electron/ 里的引用路径

### Phase 3 — P1 bug 集群核心文件逐个转 .ts
按 bug 审计的数据契约集群逐个来，每个转完 typecheck 保持绿：
- `llm/provider.mjs`、`runtime/chat-request.mjs`、`llm/openai-compatible.mjs`（流式解析，覆盖 #5 delta.tool_calls）
- `runtime/execution-ops.mjs`、`runtime/executor.mjs`、`runtime/planner.mjs`
- `electron/agent-worker.mjs` / `agent-process.mjs` RPC 层（可保持 .mjs + `// @ts-check`）
- 核心类型落地：ChatMessage/ToolCall/AgentEvent/Plan/PlanStep/ToolDefinition/GenerationResult
- tsc 暴露的实 bug（如 #3 `ArrayBuffer.length`）顺手修，其余记入 bug 审计文档

### Phase 4 — 收口
- typecheck 零错误、npm test / test:ui 全绿、dev + 打包双冒烟
- 渲染层 .jsx 本轮不动，后续可渐进转 .tsx（Vite 零成本）

范围：契约层 + agent 核心 + worker RPC = 约 20~25 个文件；UI 组件、tools/memory 大部分、scripts 不动。不改打包结构、不改测试运行方式。