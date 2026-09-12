import type { ChatMessage, ChatModel, ModelDecision, TokenUsage, ToolCall, ToolDescriptor } from '../core/types.ts';

/**
 * A deterministic, scripted model.
 *
 * Two jobs, and both matter more than they look:
 *
 *  1. It makes the offline test suite possible. The full loop — context
 *     assembly, tool dispatch, validation, compaction — runs with no network and
 *     no API key, so it can be the regression net (docs/architecture.md).
 *  2. It makes the loop debuggable. When a run misbehaves, swap in this model to
 *     separate "the agent's plumbing is wrong" from "the LLM chose badly".
 *
 * It is a state machine driven by the messages it has already seen, not a
 * random or fake text generator. Plan position is derived from the number of
 * assistant messages, which stays correct when one turn issues parallel calls.
 */

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type MockTurn =
  | { kind: 'tools'; calls: readonly MockToolCall[] }
  | { kind: 'final'; text: string };

/** Pull the user's request out of the assembled user message. */
export function extractUserPrompt(messages: readonly ChatMessage[]): string {
  const user = messages.find((m) => m.role === 'user');
  const content = user?.content ?? '';
  const match = content.match(/<request>\s*([\s\S]*?)\s*<\/request>/);
  return (match?.[1] ?? content).trim();
}

/** Count assistant turns so far — i.e. how far into the plan we are. */
function decisionsSoFar(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role === 'assistant').length;
}

/**
 * Derive image dimensions from the prompt when stated, so the mock exercises the
 * parameter extraction a real model would do (e.g. "1024x1024").
 */
export function extractDimensions(prompt: string): { width: number; height: number } {
  const match = prompt.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
  const rawWidth = match?.[1];
  const rawHeight = match?.[2];
  if (rawWidth !== undefined && rawHeight !== undefined) {
    return { width: Number(rawWidth), height: Number(rawHeight) };
  }
  if (/\b(square|1:1)\b/i.test(prompt)) return { width: 1024, height: 1024 };
  return { width: 512, height: 512 };
}

/** Strip size hints and stray punctuation so the prompt is usable as a caption. */
export function extractScene(prompt: string): string {
  return prompt
    .replace(/\b\d{3,5}\s*[x×]\s*\d{3,5}\b/gi, '')
    .replace(/\b\d+\s*[x×]\s*\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}

export const DEFAULT_NEGATIVE_PROMPT =
  'text, watermark, signature, blurry, lowres, deformed, extra limbs, jpeg artifacts';

/**
 * The reference plan for a text-to-image request.
 *
 * This is the sequence a real model is expected to follow, and the offline
 * test asserts the loop carries it out end to end. It deliberately issues
 * parallel calls in the middle turns — that path must work for real models too,
 * since they routinely batch independent lookups.
 */
export function textToImagePlan(prompt: string): MockTurn[] {
  const { width, height } = extractDimensions(prompt);
  const scene = extractScene(prompt) || 'a scenic landscape';

  return [
    // 1. Orient: is the server up, and which node catalogue is this?
    { kind: 'tools', calls: [{ name: 'server_status', arguments: {} }] },

    // 2. Find a checkpoint loader and see which checkpoints actually exist.
    {
      kind: 'tools',
      calls: [
        { name: 'search_node_types', arguments: { query: 'checkpoint loader', limit: 3 } },
        { name: 'list_models', arguments: { folder: 'checkpoints' } },
      ],
    },

    // 3. Read the schemas for every node the graph will use — batched, because
    //    they are independent.
    {
      kind: 'tools',
      calls: [
        { name: 'get_node_schema', arguments: { class_type: 'CheckpointLoaderSimple' } },
        { name: 'get_node_schema', arguments: { class_type: 'CLIPTextEncode' } },
        { name: 'get_node_schema', arguments: { class_type: 'EmptyLatentImage' } },
        { name: 'get_node_schema', arguments: { class_type: 'KSampler' } },
        { name: 'get_node_schema', arguments: { class_type: 'VAEDecode' } },
        { name: 'get_node_schema', arguments: { class_type: 'SaveImage' } },
      ],
    },

    // 4. Assemble the graph. Values come from the server's real enumerations.
    {
      kind: 'tools',
      calls: [
        {
          name: 'build_workflow',
          arguments: {
            nodes: [
              {
                id: '1',
                class_type: 'CheckpointLoaderSimple',
                inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' },
              },
              { id: '2', class_type: 'CLIPTextEncode', inputs: { text: scene, clip: ['1', 1] } },
              {
                id: '3',
                class_type: 'CLIPTextEncode',
                inputs: { text: DEFAULT_NEGATIVE_PROMPT, clip: ['1', 1] },
              },
              { id: '4', class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
              {
                id: '5',
                class_type: 'KSampler',
                inputs: {
                  model: ['1', 0],
                  seed: 42,
                  steps: 20,
                  cfg: 7,
                  sampler_name: 'euler',
                  scheduler: 'normal',
                  positive: ['2', 0],
                  negative: ['3', 0],
                  latent_image: ['4', 0],
                  denoise: 1,
                },
              },
              { id: '6', class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
              {
                id: '7',
                class_type: 'SaveImage',
                inputs: { images: ['6', 0], filename_prefix: 'comfyagent' },
              },
            ],
          },
        },
      ],
    },

    // 5. Verify before acting.
    { kind: 'tools', calls: [{ name: 'validate_workflow', arguments: {} }] },
    { kind: 'tools', calls: [{ name: 'submit_workflow', arguments: {} }] },
    { kind: 'tools', calls: [{ name: 'wait_for_result', arguments: {} }] },

    // 6. Report.
    {
      kind: 'final',
      text: `Built and validated a ${width}x${height} text-to-image workflow. See the tool output above for the prompt id and output image.`,
    },
  ];
}

export class MockChatModel implements ChatModel {
  readonly name = 'mock';
  private readonly scripted = new Map<string, MockTurn[]>();

  /**
   * Register a plan for requests containing `signature`. Tests use this to drive
   * specific scenarios — including failure and recovery — without touching the
   * default text-to-image plan.
   */
  script(signature: string, turns: MockTurn[]): this {
    this.scripted.set(signature, turns);
    return this;
  }

  private planFor(prompt: string): MockTurn[] {
    for (const [signature, turns] of this.scripted) {
      if (prompt.toLowerCase().includes(signature.toLowerCase())) return turns;
    }
    return textToImagePlan(prompt);
  }

  async chat(
    messages: readonly ChatMessage[],
    _tools: readonly ToolDescriptor[],
  ): Promise<ModelDecision> {
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const plan = this.planFor(extractUserPrompt(messages));
    const index = decisionsSoFar(messages);
    const turn = plan[Math.min(index, plan.length - 1)];

    if (!turn || turn.kind === 'final') {
      return {
        text: turn?.text ?? 'Nothing left to do.',
        toolCalls: [],
        usage,
      };
    }

    const toolCalls: ToolCall[] = turn.calls.map((call, i) => ({
      id: `mock_${index + 1}_${i + 1}`,
      name: call.name,
      arguments: call.arguments,
    }));

    return {
      text: `Calling ${toolCalls.map((c) => c.name).join(', ')}.`,
      toolCalls,
      usage,
    };
  }
}

/** A model that answers immediately. Useful for testing finalize/refusal paths. */
export class StaticChatModel implements ChatModel {
  readonly name = 'static';
  private readonly response: string;

  constructor(response: string) {
    this.response = response;
  }

  async chat(): Promise<ModelDecision> {
    return { text: this.response, toolCalls: [] };
  }
}
