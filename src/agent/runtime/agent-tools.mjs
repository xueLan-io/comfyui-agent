// The canonical agent tool set and registry factory.
//
// Extracted from agent.mjs so the tool surface is declared in one place, can be
// reused by tests and future plugin wiring, and stays independent of the Agent
// class internals.

import { ComfyUITool } from '../tools/comfyui/index.mjs';
import { RuntimeTools } from '../tools/comfyui/runtime.mjs';
import { WorkflowReadTools } from '../tools/comfyui/workflow-read.mjs';
import { ComfyUIRuntimeParametersTool } from '../tools/comfyui/runtime-parameters.mjs';
import { WorkflowMutationTools } from '../tools/comfyui/workflow-mutation-tools.mjs';
import { WorkflowInspectTool } from '../tools/comfyui/workflow-inspect.mjs';
import { InspectImageTool } from '../tools/comfyui/image-inspect.mjs';
import { WorkflowPatchTool } from '../tools/comfyui/workflow-patch.mjs';
import { PromptEnhanceTool } from '../tools/prompt/enhance.mjs';
import { PromptLibraryTool } from '../tools/prompt-library/index.mjs';
import { FilesystemTool } from '../tools/filesystem/index.mjs';
import { FilesystemMutateTool } from '../tools/filesystem/mutate.mjs';
import { SystemTool } from '../tools/system/index.mjs';
import { WebTool } from '../tools/web/index.mjs';
import { createToolRegistry } from '../tools/registry.mjs';

export const AGENT_TOOL_MODULES = [
  ComfyUITool,
  PromptEnhanceTool,
  PromptLibraryTool,
  FilesystemTool,
  FilesystemMutateTool,
  SystemTool,
  WebTool,
  WorkflowInspectTool,
  InspectImageTool,
  WorkflowPatchTool,
  ...RuntimeTools,
  ...WorkflowReadTools,
  ComfyUIRuntimeParametersTool,
  ...WorkflowMutationTools,
];

export function createAgentToolRegistry() {
  return createToolRegistry({ tools: AGENT_TOOL_MODULES });
}
