import { z } from 'zod';

/**
 * Zod -> JSON Schema 2020-12, which is what MCP requires for `inputSchema`.
 *
 * `io: 'input'` matters: it describes what the *caller* must supply, so a field
 * with a Zod `.default()` is not listed as required. Using the output view would
 * wrongly force the model to pass every defaulted field.
 *
 * `$schema` is stripped — it is redundant per-descriptor and costs tokens.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}
