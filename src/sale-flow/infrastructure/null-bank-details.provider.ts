import { Injectable } from '@nestjs/common';
import type { BankDetailsProvider } from '../domain/bank-details.provider';

/**
 * v1 default implementation of `BankDetailsProvider`.
 *
 * Returns `null` until the backend answers Q1 (a real bank-details source
 * — table, endpoint, env). The prompt composition layer treats `null`
 * as the human-handoff case (SALE_FLOW_INSTRUCTIONS carries the
 * "en un momento un agente te comparte los datos de pago" phrase).
 *
 * Future swap: replace this binding in `SaleFlowModule` with an
 * env-backed or chatbot-api-backed implementation. No tool, agent, or
 * prompt change required.
 */
@Injectable()
export class NullBankDetailsProvider implements BankDetailsProvider {
  get(): Promise<null> {
    return Promise.resolve(null);
  }
}
