import { InMemoryLlmSpendStore } from './in-memory-llm-spend.store';
import { runLlmSpendStoreContract } from './llm-spend-store.contract';

runLlmSpendStoreContract(
  'InMemoryLlmSpendStore',
  () => new InMemoryLlmSpendStore(),
);
