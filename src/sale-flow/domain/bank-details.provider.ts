import type { BankDetails } from './sale-flow-instructions';

/**
 * DI injection token for the swappable bank-details source.
 *
 * The runtime default (`NullBankDetailsProvider`) returns `null` — the
 * prompt then encodes the human-handoff phrase and refuses to invent any
 * bank detail. A future slice can replace the binding without touching
 * any tool, the model, or the prompt literal.
 */
export const BANK_DETAILS_PROVIDER = Symbol('BANK_DETAILS_PROVIDER');

/**
 * Port for the bank-details source. `null` means "no source available";
 * the prompt composition path treats that as the human-handoff case.
 */
export interface BankDetailsProvider {
  get(): Promise<BankDetails | null>;
}

export type { BankDetails };
