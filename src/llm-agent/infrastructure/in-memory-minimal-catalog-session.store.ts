import { Injectable } from '@nestjs/common';
import type {
  MinimalCatalogSessionStore,
  MinimalCatalogTurn,
} from '../domain/minimal-catalog-session.store';

/**
 * In-memory MinimalCatalogSessionStore: per-sender turns in a plain Map.
 *
 * Data is NOT persisted between process restarts — a fresh instance (and a
 * fresh process) forgets every sender. This is the only adapter for the
 * experimental read-only catalog route.
 */
@Injectable()
export class InMemoryMinimalCatalogSessionStore implements MinimalCatalogSessionStore {
  private readonly turns = new Map<string, MinimalCatalogTurn[]>();

  read(senderId: string): MinimalCatalogTurn[] {
    return this.turns.get(senderId) ?? [];
  }

  write(senderId: string, turns: MinimalCatalogTurn[]): void {
    this.turns.set(senderId, turns);
  }
}
