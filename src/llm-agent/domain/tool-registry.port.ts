/**
 * DI injection token for the tool registry port.
 *
 * The registry returns an opaque AI-SDK ToolSet to the LLM agent adapter.
 * Keeping the SDK types opaque to the domain lets us swap providers
 * without touching application code.
 */
export const TOOL_REGISTRY = Symbol('TOOL_REGISTRY');

/** Minimal contract the runner needs from the tool registry. */
export interface ToolRegistry {
  /**
   * Returns the registered tools as an AI-SDK ToolSet.
   * The shape is opaque to the domain; only the infrastructure adapter
   * knows how to consume it.
   */
  getTools(): Record<string, unknown>;
}