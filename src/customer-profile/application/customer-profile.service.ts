import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CustomerStyle } from '../../llm-agent/domain/customer-style';
import {
  CUSTOMER_PROFILE_STORE,
  customerStyleSeed,
  normalizeCustomerProfilePatch,
  profilePatchIsNoop,
  type CustomerLastOrder,
  type CustomerProfile,
  type CustomerProfilePatch,
  type CustomerProfileStore,
} from '../domain/customer-profile';

export const CUSTOMER_PROFILE_CLOCK = Symbol('CUSTOMER_PROFILE_CLOCK');

/** Bounded process cache: plenty for one store's active customers. */
const CACHE_MAX = 2000;

/**
 * S1 customer memory for the conversation and the background notices.
 * Every method is best effort and never throws: a profile failure must never
 * block a reply or a notice (they fall back to the usted defaults).
 *
 * The agent loads a profile once per session (`load`) and reads it
 * synchronously afterwards (`cached`); writes update the cache. Background
 * senders read the store directly (`styleFor`). After "olvida mis datos"
 * (`forget`) the sender is not written again until the process restarts.
 */
@Injectable()
export class CustomerProfileService {
  private readonly logger = new Logger(CustomerProfileService.name);
  private readonly cache = new Map<string, CustomerProfile | null>();
  private readonly forgotten = new Set<string>();
  private readonly now: () => Date;

  constructor(
    @Inject(CUSTOMER_PROFILE_STORE)
    private readonly store: CustomerProfileStore,
    @Optional() @Inject(CUSTOMER_PROFILE_CLOCK) clock?: () => Date,
  ) {
    this.now = clock ?? (() => new Date());
  }

  isLoaded(senderId: string): boolean {
    return this.cache.has(senderId);
  }

  /** The cached profile; `null` when unknown or not loaded. */
  cached(senderId: string): CustomerProfile | null {
    return this.cache.get(senderId) ?? null;
  }

  /** Reads the store into the cache; a failed read is not cached. */
  async load(senderId: string): Promise<CustomerProfile | null> {
    try {
      const profile = this.forgotten.has(senderId)
        ? null
        : await this.store.read(senderId);
      this.remember(senderId, profile);
      return profile;
    } catch (error) {
      this.warn('read', error);
      return this.cached(senderId);
    }
  }

  /** Merge-only write; skipped when it would change nothing. */
  async record(senderId: string, patch: CustomerProfilePatch): Promise<void> {
    if (this.forgotten.has(senderId)) return;
    const next = normalizeCustomerProfilePatch(patch);
    if (
      this.isLoaded(senderId) &&
      profilePatchIsNoop(this.cached(senderId), next)
    )
      return;
    try {
      const saved = await this.store.upsert(senderId, next, this.now());
      if (saved !== null) this.remember(senderId, saved);
    } catch (error) {
      this.warn('write', error);
    }
  }

  /**
   * A placed order: the last-order pointer, plus the checkout first name as
   * the preferred name only when the customer gave none before.
   */
  async recordOrder(
    senderId: string,
    order: CustomerLastOrder,
    firstName?: string | null,
  ): Promise<void> {
    if (this.forgotten.has(senderId)) return;
    const known = this.isLoaded(senderId)
      ? this.cached(senderId)
      : await this.load(senderId);
    await this.record(senderId, {
      lastOrder: order,
      ...(known?.preferredName === undefined && firstName
        ? { preferredName: firstName }
        : {}),
    });
  }

  /** Deletes the profile; later writes in this process are skipped. */
  async forget(senderId: string): Promise<boolean> {
    this.forgotten.add(senderId);
    this.remember(senderId, null);
    try {
      await this.store.delete(senderId);
      return true;
    } catch (error) {
      this.warn('delete', error);
      return false;
    }
  }

  /** Stored style for a background notice; `null` → keep the usted copy. */
  async styleFor(senderId: string): Promise<CustomerStyle | null> {
    if (this.forgotten.has(senderId)) return null;
    try {
      const profile = await this.store.read(senderId);
      return profile === null ? null : customerStyleSeed(profile);
    } catch (error) {
      this.warn('style read', error);
      return null;
    }
  }

  private remember(senderId: string, profile: CustomerProfile | null): void {
    this.cache.delete(senderId);
    this.cache.set(senderId, profile);
    if (this.cache.size > CACHE_MAX) {
      for (const oldest of this.cache.keys()) {
        this.cache.delete(oldest);
        break;
      }
    }
  }

  private warn(operation: string, error: unknown): void {
    this.logger.warn(
      `customer profile ${operation} failed: ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}
