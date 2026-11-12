/**
 * S7 (D13): fixed reply when a customer sends a voice note and nobody is
 * attending (the conversation is not in HUMAN mode). Written in usted like
 * the rest of the fixed copy; `applyCustomerStyle` turns it into tú through
 * the curated pairs ("¿Me puede" and "su mensaje"). The audio itself is still
 * mirrored for staff.
 */
export const AUDIO_UNSUPPORTED_REPLY =
  'Por ahora no puedo escuchar audios. ¿Me puede escribir su mensaje, por favor?';
