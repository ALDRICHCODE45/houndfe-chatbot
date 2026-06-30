import { Injectable } from '@nestjs/common';
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
    // UPSERT: if no record exists, create one from the supplied patch.
    // This is a strict superset of the previous throw-on-missing contract
    // and is what the dispatcher / agent runner rely on so that one
    // write path handles both first contact and follow-ups.
    const existing = this.map.get(senderId);
    const updated: ConversationState = existing
      ? { ...existing, ...patch }
      : { senderId, ...patch };
    this.map.set(senderId, updated);
    return updated;
  }
}