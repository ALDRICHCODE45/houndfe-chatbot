/**
 * Message formatting F3c (S2, S4): the shared, pure WhatsApp formatting
 * helpers the receipt notices use (bold folio and labels, «$1,250.00»).
 * Re-exported here so the notice worker keeps no reference to the LLM
 * agent module (same pattern as `customer-profile/domain/notice-style`):
 * the helpers are deterministic string functions, never an LLM path.
 */
export { bold, money } from '../../llm-agent/domain/whatsapp-format';
