/**
 * S3 approved customer texts for scheduled conversations (usted), as pure
 * builders over the already-formatted pieces (see `slot-time.ts`). The tú
 * variants are NOT here: the bot styles these through `styleFixedCopy` /
 * `applyCustomerStyle`, whose phrase-level pairs (`TU_PHRASES` in
 * `llm-agent/domain/customer-style.ts`) rewrite only the usted wording and
 * never the interpolated day/time pieces.
 *
 * The only deviation from the literal template is grammatical: "a las
 * {hora}" becomes "a la 1:00 p. m." for one o'clock (`atTime`).
 */
import { atTime, type SlotLabel } from './slot-time';

const MAX_OFFERED = 3;

const at = (slot: SlotLabel): string => `${slot.day} ${atTime(slot.time)}`;

/** "a. m." already ends in a period: never write "a. m.." */
const stop = (text: string): string => (text.endsWith('.') ? text : `${text}.`);

function numbered(slots: readonly SlotLabel[]): string {
  if (slots.length < 1 || slots.length > MAX_OFFERED) {
    throw new RangeError(
      `Expected 1-${MAX_OFFERED} slots, got ${slots.length}`,
    );
  }
  return slots.map((slot, index) => `${index + 1}. ${at(slot)}`).join('\n');
}

/** `openWhen` is `{cuándo}` ("hoy a las 4:00 p. m."). */
export function offerText(
  openWhen: string,
  slots: readonly SlotLabel[],
): string {
  return (
    `Ahorita nuestro equipo no está disponible (abrimos ${openWhen}). ` +
    '¿Quiere que una persona le atienda en alguno de estos horarios?\n' +
    `${numbered(slots)}\n` +
    'Responda con el número.'
  );
}

/**
 * The offer when the customer CHANGES an existing appointment: the branch may
 * well be open, so the out-of-hours wording of `offerText` does not apply.
 */
export function rescheduleOfferText(slots: readonly SlotLabel[]): string {
  return (
    'Estos son los horarios disponibles para su cita:\n' +
    `${numbered(slots)}\n` +
    'Responda con el número.'
  );
}

export function notUnderstoodText(): string {
  return 'No entendí qué horario prefiere. Responda con el número de la opción.';
}

export function bookedText(slot: SlotLabel): string {
  return (
    `Listo, quedó agendado para ${stop(at(slot))} ` +
    'A esa hora una persona del equipo le escribe por aquí.'
  );
}

export function bookedOutOfWindowText(slot: SlotLabel): string {
  return (
    `Listo, quedó agendado para ${stop(at(slot))} ` +
    'A esa hora le escribimos; cuando le llegue el mensaje, respóndanos para continuar.'
  );
}

export function slotTakenText(slots: readonly SlotLabel[]): string {
  return (
    'Ese horario se acaba de ocupar. Estos siguen disponibles:\n' +
    numbered(slots)
  );
}

/** `openWhen` is `{cuándo}`. */
export function noSlotsText(openWhen: string): string {
  return (
    'Por ahora no tenemos horarios disponibles en los próximos días. ' +
    `Ya dejé su solicitud y le escriben en cuanto abramos (${openWhen}).`
  );
}

export function alreadyBookedText(slot: SlotLabel): string {
  return `Ya tiene una cita para ${stop(at(slot))} ¿Quiere cambiarla?`;
}

export function rescheduledText(slot: SlotLabel): string {
  return `Listo, cambié su cita para ${stop(at(slot))}`;
}

export function cancelledText(): string {
  return 'Listo, cancelé su cita. Si necesita algo más, aquí sigo para ayudarle.';
}

export function whatTimeText(slot: SlotLabel): string {
  return (
    `Su cita es ${stop(at(slot))} ` +
    'Una persona del equipo le escribe por aquí a esa hora.'
  );
}

/** `time` is `{hora}` ("9:30 a. m."). */
export function reminderText(time: string): string {
  return `Le recuerdo que ${atTime(time)} una persona del equipo le atiende por aquí.`;
}

export function staffChangedText(slot: SlotLabel): string {
  return `El equipo cambió su cita para ${stop(at(slot))}`;
}
