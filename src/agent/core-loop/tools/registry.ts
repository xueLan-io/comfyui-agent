import type { ToolCall, ToolDescriptor, ToolResult } from '../core/types.ts';
import { zodToJsonSchema } from '../util/schema.ts';
import type { AnyToolDefinition, ToolContext } from './types.ts';

/**
 * The single source of truth for what the agent can do.
 *
 * Both entrypoints consume this: the agent loop calls `descriptors()` to build
 * the model's tool list, and the MCP server re-exports the same descriptors over
 * stdio. There is deliberately no second tool definition anywhere — that is the
 * "dual form" structural bet from docs/architecture.md.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, AnyToolDefinition>();
  private readonly ordered: AnyToolDefinition[] = [];

  constructor(definitions: readonly AnyToolDefinition[]) {
    for (const definition of definitions) {
      if (this.byName.has(definition.name)) {
        throw new Error(`Duplicate tool name: ${definition.name}`);
      }
      this.byName.set(definition.name, definition);
      this.ordered.push(definition);
    }
  }

  get size(): number {
    return this.ordered.length;
  }

  /**
   * Descriptors in a stable order.
   *
   * Deterministic ordering is a specification requirement for `tools/list`
   * (docs/research/2026-landscape.md §4) and it also keeps the prompt prefix
   * cacheable across calls, which matters because tool schemas sit in context on
   * every single request.
   */
  descriptors(): ToolDescriptor[] {
    return this.ordered.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.schema),
    }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  mutatingNames(): string[] {
    return this.ordered.filter((d) => d.mutating).map((d) => d.name);
  }

  /**
   * Validate and execute one model-requested call.
   *
   * Validation failure is returned as a `ToolResult` with `ok: false` rather
   * than thrown: the model needs to see what it got wrong and retry. This is the
   * mechanism that turns "compounding errors" into self-correction
   * (docs/research/2026-landscape.md §3).
   */
  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const def = this.byName.get(call.name);
    if (!def) {
      return {
        ok: false,
        errorCode: 'UNKNOWN_TOOL',
        content: {
          error: `No tool named "${call.name}".`,
          available_tools: [...this.byName.keys()].sort(),
        },
      };
    }

    // A provider that emitted unparseable arguments leaves us unable to know
    // what was intended; report it rather than dispatching a guess.
    if (call.rawArguments !== undefined) {
      return {
        ok: false,
        errorCode: 'MALFORMED_ARGUMENTS',
        content: {
          error: `Arguments for ${call.name} were not valid JSON.`,
          received: call.rawArguments.slice(0, 300),
          hint: 'Re-issue the call with a well-formed JSON object matching the tool schema.',
        },
      };
    }

    const parsed = def.schema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGUMENTS',
        content: {
          error: `Arguments for ${call.name} did not match its schema.`,
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      };
    }

    // Mutating tools need explicit human approval unless we are in dry-run, in
    // which case the handler simulates the action and nothing is sent.
    if (def.mutating && !ctx.policy.dryRun) {
      const decision = await ctx.approvals.request({
        action: def.name,
        detail: describeCall(def.name, parsed.data),
      });
      if (!decision.approved) {
        return {
          ok: false,
          errorCode: 'APPROVAL_DENIED',
          content: {
            error: `The user declined ${def.name}.`,
            ...(decision.reason ? { reason: decision.reason } : {}),
            hint: 'Do not retry this action. Briefly explain what you prepared and stop.',
          },
        };
      }
    }

    try {
      return await def.handler(parsed.data as never, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`tool ${def.name} threw`, { error });
      return {
        ok: false,
        errorCode: 'TOOL_THREW',
        content: {
          error: `${def.name} failed: ${message}`,
          hint: 'If the cause is unclear, check server_status and retry with corrected arguments.',
        },
      };
    }
  }
}

function describeCall(name: string, args: unknown): string {
  const rendered = JSON.stringify(args);
  const short = rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered;
  return `Call ${name} ${short}`;
}
