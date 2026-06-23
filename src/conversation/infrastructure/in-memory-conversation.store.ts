import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ConversationState,
  ConversationStore,
} from '../domain/conversation-store';

/**
 * In-memory implementation of ConversationStore.
 *
 * State is keyed by WhatsApp sender id and lives in a plain Map.
 * Data is NOT persisted between process restarts — this adapter is
 * used for the echo-bot slice only. A Postgres adapter will replace
 * or augment this in a future slice.
 */
@Injectable()
export class InMemoryConversationStore implements ConversationStore {
  private readonly map = new Map<string, ConversationState>();

  async get(senderId: string): Promise<ConversationState | null> {
    return this.map.get(senderId) ?? null;
  }

  async create(
    senderId: string,
    state: Omit<ConversationState, 'senderId'>,
  ): Promise<ConversationState> {
    const record: ConversationState = { senderId, ...state };
    this.map.set(senderId, record);
    return record;
  }

  async update(
    senderId: string,
    patch: Partial<Omit<ConversationState, 'senderId'>>,
  ): Promise<ConversationState> {
    const existing = this.map.get(senderId);
    if (!existing) {
      throw new NotFoundException(
        `ConversationState not found for senderId: ${senderId}`,
      );
    }
    const updated: ConversationState = { ...existing, ...patch };
    this.map.set(senderId, updated);
    return updated;
  }
}
