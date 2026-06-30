import { InMemoryToolRegistry } from './in-memory-tool-registry';

/**
 * Unit tests for InMemoryToolRegistry.
 *
 * Spec scenario: a ToolRegistry provider MUST supply at least one
 * placeholder tool (`getCurrentTime`).
 */
describe('InMemoryToolRegistry', () => {
  let registry: InMemoryToolRegistry;

  beforeEach(() => {
    registry = new InMemoryToolRegistry();
  });

  // ─── Scenario: placeholder tool available ─────────────────────────
  it('exposes the getCurrentTime tool', () => {
    const tools = registry.getTools();
    expect(tools).toHaveProperty('getCurrentTime');
  });

  it('returns an object with AI-SDK tool-shape fields on each tool', () => {
    const tools = registry.getTools();
    const tool = tools.getCurrentTime as {
      description?: string;
      inputSchema?: unknown;
      execute?: unknown;
    };

    expect(typeof tool.description).toBe('string');
    expect(tool.description!.length).toBeGreaterThan(0);
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('the getCurrentTime execute function returns an ISO 8601 timestamp', async () => {
    const tools = registry.getTools();
    const tool = tools.getCurrentTime as { execute: () => Promise<{ now: string }> };

    const result = await tool.execute();

    expect(result.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Round-tripping through Date confirms parseability.
    expect(Number.isFinite(new Date(result.now).getTime())).toBe(true);
  });
});