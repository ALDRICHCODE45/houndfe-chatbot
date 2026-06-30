import { TOOL_REGISTRY, type ToolRegistry } from './tool-registry.port';

/**
 * Domain contract tests for the tool registry port.
 */
describe('Tool registry port', () => {
  it('is a unique Symbol usable as a NestJS DI token', () => {
    expect(typeof TOOL_REGISTRY).toBe('symbol');
    expect(TOOL_REGISTRY).not.toBe(Symbol('TOOL_REGISTRY'));
  });

  it('a fake registry returning getCurrentTime satisfies the contract', () => {
    const fakeTimeTool = { description: 'time', inputSchema: {}, execute: jest.fn() };
    const registry: ToolRegistry = {
      getTools: () => ({ getCurrentTime: fakeTimeTool }),
    };

    const tools = registry.getTools();
    expect(tools.getCurrentTime).toBe(fakeTimeTool);
  });
});