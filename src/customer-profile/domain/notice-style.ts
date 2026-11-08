/**
 * S1 background notices: the pure, deterministic customer-style rules for
 * fixed copy (curated usted → tú phrase pairs and the emoji cap). Re-exported
 * here so the notice senders depend on the customer-profile boundary, never
 * on the LLM agent module (no LLM path in a notice).
 */
export {
  applyCustomerStyle,
  type CustomerStyle,
} from '../../llm-agent/domain/customer-style';
