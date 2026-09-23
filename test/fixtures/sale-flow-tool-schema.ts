/**
 * Test-only typed boundary for AI SDK tool objects.
 *
 * `ai@7` types `tool.inputSchema` as the `FlexibleSchema` union, which does
 * not statically expose the Zod methods the specs exercise. This helper
 * runtime-verifies that the concrete tool really exposes a nonempty string
 * `description` plus callable `safeParse`/`parse` methods, then narrows only
 * those two fields at the type level. It returns the original tool object
 * unchanged, so the original generic `T` is preserved and `execute` keeps
 * its inferred input, output, and context types.
 */
import type { InferToolInput, Tool } from 'ai';

/** Minimal structural result of a Zod-style `safeParse`. */
export type SchemaSafeParseResult<INPUT> =
  | { success: true; data: INPUT }
  | { success: false; error: unknown };

/** Zod-style schema methods narrowed for spec assertions. */
export interface TestInputSchema<INPUT> {
  safeParse: (value: unknown) => SchemaSafeParseResult<INPUT>;
  parse: (value: unknown) => INPUT;
}

/** The same tool with only `description`/`inputSchema` narrowed. */
export type SchemaVerifiedTool<T extends Tool> = T & {
  description: string;
  inputSchema: TestInputSchema<InferToolInput<T>>;
};

/**
 * Validates the runtime schema surface and returns the original tool with the
 * schema methods and description narrowed. Throws when the invariant does not
 * hold, so a mis-shaped tool fails loudly instead of silently compiling.
 */
export function asSchemaVerifiedTool<T extends Tool>(
  tool: T,
): SchemaVerifiedTool<T> {
  const description: unknown = Reflect.get(tool, 'description');
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error('expected a nonempty string tool description');
  }
  const schema: unknown = Reflect.get(tool, 'inputSchema');
  if (typeof schema !== 'object' || schema === null) {
    throw new Error('expected an object tool inputSchema');
  }
  if (
    typeof Reflect.get(schema, 'safeParse') !== 'function' ||
    typeof Reflect.get(schema, 'parse') !== 'function'
  ) {
    throw new Error('expected callable inputSchema safeParse/parse');
  }

  return tool as SchemaVerifiedTool<T>;
}
