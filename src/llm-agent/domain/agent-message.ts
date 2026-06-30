/**
 * Pure re-export of the canonical `AgentMessage` union.
 *
 * The single source of truth lives in `conversation/domain/conversation-store.ts`.
 * Do NOT re-declare the union here — re-exporting keeps the two layers in lockstep
 * and prevents drift between the persistence and LLM-agent domains.
 */
export type { AgentMessage } from '../../conversation/domain/conversation-store';