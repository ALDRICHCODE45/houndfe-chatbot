/* eslint-disable @typescript-eslint/require-await */
import { Injectable } from '@nestjs/common';
import {
  ConversationState,
  ConversationStore,
  isPendingHumanRequest,
  isPendingHumanRequestId,
  isReceiptAmountPointer,
  ReceiptAmountPointer,
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

  async setReceiptAmountPointer(
    senderId: string,
    pointer: ReceiptAmountPointer,
  ): Promise<boolean> {
    const state = this.map.get(senderId);
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      !isReceiptAmountPointer(pointer) ||
      !state
    )
      return false;
    const current = state.data.receiptAmountPointer;
    if (
      Object.hasOwn(state.data, 'receiptAmountPointer') &&
      (!isReceiptAmountPointer(current) ||
        current.receiptMediaId !== pointer.receiptMediaId ||
        current.saleId !== pointer.saleId ||
        !this.isNewer(pointer.receiptVersion, current.receiptVersion))
    ) {
      return false;
    }
    state.data = { ...state.data, receiptAmountPointer: pointer };
    return true;
  }

  async clearReceiptAmountPointer(
    senderId: string,
    pointer: ReceiptAmountPointer,
  ): Promise<boolean> {
    const state = this.map.get(senderId);
    const current = state?.data.receiptAmountPointer;
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      !isReceiptAmountPointer(pointer) ||
      !state ||
      !Object.hasOwn(state.data, 'receiptAmountPointer') ||
      !isReceiptAmountPointer(current) ||
      current.receiptMediaId !== pointer.receiptMediaId ||
      current.saleId !== pointer.saleId ||
      current.receiptVersion !== pointer.receiptVersion
    ) {
      return false;
    }
    const data = { ...state.data };
    delete data.receiptAmountPointer;
    state.data = data;
    return true;
  }

  async get(senderId: string): Promise<ConversationState | null> {
    return this.map.get(senderId) ?? null;
  }

  async clearPendingHumanRequest(
    senderId: string,
    requestId: string,
  ): Promise<boolean> {
    const state = this.map.get(senderId);
    const current = state?.data.pendingHumanRequest;
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      !isPendingHumanRequestId(requestId) ||
      !state ||
      !Object.hasOwn(state.data, 'pendingHumanRequest') ||
      !isPendingHumanRequest(current) ||
      current.requestId !== requestId
    ) {
      return false;
    }
    state.data = { ...state.data, pendingHumanRequest: null };
    return true;
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
    const data = { ...(patch.data ?? {}) };
    delete data.receiptAmountPointer;
    const safePatch = Object.hasOwn(patch, 'data') ? { ...patch, data } : patch;
    const merged = existing
      ? { ...existing, ...safePatch }
      : { senderId, ...safePatch };
    // Re-assert required fields after merge; the caller is responsible
    // for supplying lastMessageAt (the dispatcher / runner always do).
    if (typeof merged.lastMessageAt !== 'string') {
      throw new Error(
        `ConversationStore.update requires lastMessageAt for senderId: ${senderId}`,
      );
    }
    const finalState: ConversationState = {
      senderId: merged.senderId,
      lastMessageAt: merged.lastMessageAt,
      data: {
        ...(merged.data ?? {}),
        ...(existing && Object.hasOwn(existing.data, 'receiptAmountPointer')
          ? { receiptAmountPointer: existing.data.receiptAmountPointer }
          : {}),
      },
    };
    this.map.set(senderId, finalState);
    return finalState;
  }

  private isNewer(incoming: string, current: string): boolean {
    return (
      incoming.length > current.length ||
      (incoming.length === current.length && incoming > current)
    );
  }
}
