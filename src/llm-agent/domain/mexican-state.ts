/** Byte-exact backend MEXICAN_STATES (minimal-new-customer-checkout L2). */
export const MEXICAN_STATES = [
  'Aguascalientes',
  'Baja California',
  'Baja California Sur',
  'Campeche',
  'Chiapas',
  'Chihuahua',
  'Ciudad de México',
  'Coahuila',
  'Colima',
  'Durango',
  'Estado de México',
  'Guanajuato',
  'Guerrero',
  'Hidalgo',
  'Jalisco',
  'Michoacán',
  'Morelos',
  'Nayarit',
  'Nuevo León',
  'Oaxaca',
  'Puebla',
  'Querétaro',
  'Quintana Roo',
  'San Luis Potosí',
  'Sinaloa',
  'Sonora',
  'Tabasco',
  'Tamaulipas',
  'Tlaxcala',
  'Veracruz',
  'Yucatán',
  'Zacatecas',
] as const;
export type MexicanState = (typeof MEXICAN_STATES)[number];

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
const states = new Map<string, MexicanState>(
  MEXICAN_STATES.map((state) => [normalize(state), state]),
);
for (const [alias, state] of [
  ['CDMX', 'Ciudad de México'],
  ['DF', 'Ciudad de México'],
  ['Distrito Federal', 'Ciudad de México'],
  ['Edomex', 'Estado de México'],
  ['Edo. Mex.', 'Estado de México'],
  ['Coahuila de Zaragoza', 'Coahuila'],
  ['Veracruz de Ignacio de la Llave', 'Veracruz'],
  ['Michoacán de Ocampo', 'Michoacán'],
] as const)
  states.set(normalize(alias), state);

/** Exact normalized names/explicit aliases only; never partial or fuzzy. */
export function toMexicanState(text: string | null): MexicanState | null {
  return typeof text === 'string'
    ? (states.get(normalize(text)) ?? null)
    : null;
}
