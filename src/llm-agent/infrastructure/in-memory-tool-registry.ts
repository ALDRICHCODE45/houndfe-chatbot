import { Injectable } from '@nestjs/common';
import type { ToolRegistry } from '../domain/tool-registry.port';
import { getCurrentTime } from './tools/placeholder-tools';

/**
 * In-memory tool registry returning the placeholder tools available
 * to the LLM agent. As the project grows, additional tools will be
 * registered here (catalog search, cart pricing, order status…).
 *
 * The `getTools()` return type is opaque to the domain — only the
 * infrastructure layer (the agent adapter) knows how to consume it.
 */
@Injectable()
export class InMemoryToolRegistry implements ToolRegistry {
  getTools(): Record<string, unknown> {
    return {
      getCurrentTime,
    };
  }
}