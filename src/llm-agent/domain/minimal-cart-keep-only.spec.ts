import { hasKeepOnlyCartEvidence } from './minimal-cart-keep-only';

describe('keep-only current-turn evidence [S2]', () => {
  it.each([
    'Solo deja las croquetas en mi carrito por favor, quita todo lo demas',
    'Quiero que en mi carrito solo contenga las croquetas.',
    'olo deja las croquetas en mi carrito por favor, quita todo lo demas',
    ...[
      'lo demas',
      'todo lo demas',
      'los demas',
      'las demas',
      'el resto',
      'lo otro',
      'todo lo otro',
    ].map((object) => `quita ${object}`),
    ...['solo', 'solamente', 'únicamente', 'nada más'].map(
      (marker) => `${marker} deja las croquetas`,
    ),
    ...[
      'deja',
      'dejame',
      'dejar',
      'deje',
      'contenga',
      'tenga',
      'mantén',
      'conserva',
      'conservar',
    ].map((verb) => `solo ${verb} las croquetas`),
    'Solo quiero las croquetas en mi carrito',
    'QUITA TODO LO DEMÁS',
  ])('accepts %s', (text) => {
    expect(hasKeepOnlyCartEvidence(text)).toBe(true);
  });

  it.each([
    'no quites nada',
    'no dejes solo las croquetas',
    'solo quiero saber el precio',
    'agrega croquetas',
    'solo deja 2 croquetas',
    'quita el ibuprofeno',
    'no quita todo lo demas',
    'nunca solo deja las croquetas',
    'sin quitar lo demas',
    'solo no deja las croquetas',
    'solo deja una croqueta',
    'solo deja otra unidad',
    'solo deja 500mg de croquetas',
    'consola dejame croquetas',
    'solo dejaremos las croquetas',
    'quita lo demasiado',
    'vacía el carrito',
    '',
  ])('rejects %s', (text) => {
    expect(hasKeepOnlyCartEvidence(text)).toBe(false);
  });
});
