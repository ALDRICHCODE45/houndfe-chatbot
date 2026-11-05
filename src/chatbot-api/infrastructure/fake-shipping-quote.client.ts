import type { ChatbotApiClient } from '../domain/chatbot-api.client';
import type {
  CreateShippingQuoteInput,
  ShippingQuoteResponse,
} from '../domain/dtos/shipping-quote.dto';

/** In-memory `createShippingQuote` for unit tests: queued results, recorded calls. */
export class FakeShippingQuoteClient implements Pick<
  ChatbotApiClient,
  'createShippingQuote'
> {
  readonly calls: CreateShippingQuoteInput[] = [];
  private readonly queue: Array<ShippingQuoteResponse | Error> = [];

  enqueue(result: ShippingQuoteResponse | Error): this {
    this.queue.push(result);
    return this;
  }

  createShippingQuote(
    input: CreateShippingQuoteInput,
  ): Promise<ShippingQuoteResponse> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('no shipping quote queued'));
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}
