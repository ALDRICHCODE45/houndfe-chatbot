import { normalizeMinimalCheckoutDraft } from '../../conversation/domain/minimal-checkout-draft';
import {
  MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
  MINIMAL_CHECKOUT_CHANGED_REPLY,
  MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS,
  MINIMAL_CHECKOUT_CONFIRMED_REPLY,
  MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
  MinimalCheckoutConfirmation,
  evaluateMinimalCheckoutReadiness,
  renderMinimalCheckoutConfirmation,
  type MinimalCheckoutCandidate,
  type MinimalCheckoutConsumeResult,
  type MinimalCheckoutMissingField,
  type MinimalCheckoutPrepareResult,
} from './minimal-checkout-confirmation';

type Raw = Record<string, unknown>;

const SENDER = '5215550001111';
const CID = 'abcdef01-2345-4789-8abc-def012345678';
const ADDRESS_ID = 'ABCDEF01-2345-4789-8ABC-DEF012345678';
const VERSION = '2026-10-12T15:16:12.000Z';
const PHONE_ID = '123456789012345';
const EVENT = {
  receivingPhoneNumberId: PHONE_ID,
  senderId: SENDER,
  messageId: 'wamid.O',
};
const CONFIRM = { ...EVENT, messageId: 'wamid.C' };

const FIELD_KEYS = [
  'label',
  'street',
  'exteriorNumber',
  'interiorNumber',
  'zipCode',
  'neighborhood',
  'municipality',
  'city',
  'state',
  'visualReferences',
  'carrierPhone',
] as const;

const fullFields = (overrides: Raw = {}): Raw => ({
  label: null,
  street: 'Av. Reforma',
  exteriorNumber: '123',
  interiorNumber: null,
  zipCode: '06600',
  neighborhood: 'Juárez',
  municipality: null,
  city: 'Ciudad de México',
  state: 'CDMX',
  visualReferences: null,
  carrierPhone: null,
  ...overrides,
});

const nullFields = (): Raw =>
  Object.fromEntries(FIELD_KEYS.map((key) => [key, null]));

const newDraft = (overrides: Raw = {}): Raw => ({
  schemaVersion: 1,
  senderId: SENDER,
  revision: 0,
  sourceCustomerId: null,
  customer: { firstName: 'Ana', lastName: null },
  address: { kind: 'new', fields: fullFields() },
  ...overrides,
});

const withFields = (fields: Raw): Raw =>
  newDraft({ address: { kind: 'new', fields } });

const savedDraft = (overrides: Raw = {}): Raw =>
  newDraft({
    sourceCustomerId: CID,
    address: {
      kind: 'saved',
      snapshot: { ...fullFields(), id: ADDRESS_ID, version: VERSION },
    },
    ...overrides,
  });

const savedWithFields = (fields: Raw): Raw =>
  newDraft({
    sourceCustomerId: CID,
    address: {
      kind: 'saved',
      snapshot: {
        ...fullFields(),
        ...fields,
        id: ADDRESS_ID,
        version: VERSION,
      },
    },
  });

const ALL_MISSING: MinimalCheckoutMissingField[] = [
  'firstName',
  'street',
  'exteriorNumber',
  'neighborhood',
  'zipCode',
  'state',
  'cityOrMunicipality',
];

const blankOnly = (field: MinimalCheckoutMissingField): Raw => {
  if (field === 'firstName') {
    return newDraft({ customer: { firstName: '', lastName: null } });
  }
  if (field === 'cityOrMunicipality') {
    return withFields(fullFields({ city: null, municipality: null }));
  }
  return withFields(fullFields({ [field]: null }));
};

const normalize = (raw: unknown, sender: string = SENDER) => {
  const draft = normalizeMinimalCheckoutDraft(raw, sender);
  if (draft === null) throw new Error('fixture must normalize');
  return draft;
};

const clock = { t: 0 };
const make = () => new MinimalCheckoutConfirmation({ now: () => clock.t });

const offer = (
  svc: MinimalCheckoutConfirmation,
  draft: unknown = newDraft(),
  event: unknown = EVENT,
): Extract<MinimalCheckoutPrepareResult, { kind: 'offer' }> => {
  const result = svc.prepare({ senderId: SENDER, inboundEvent: event, draft });
  if (result.kind !== 'offer') throw new Error('expected an offer');
  return result;
};

const say = (
  svc: MinimalCheckoutConfirmation,
  text: unknown = 'sí',
  event: unknown = CONFIRM,
  draft: unknown = newDraft(),
  sender: string = SENDER,
): MinimalCheckoutConsumeResult =>
  svc.consume({ senderId: sender, text, inboundEvent: event, draft });

const candidateOf = (
  svc: MinimalCheckoutConfirmation,
  raw: unknown = newDraft(),
): MinimalCheckoutCandidate => {
  const o = offer(svc, raw);
  o.onSent();
  const result = say(svc, 'sí', CONFIRM, raw);
  if (result?.kind !== 'candidate') throw new Error('expected a candidate');
  return result;
};

beforeEach(() => {
  clock.t = 0;
});

describe('checkout readiness gate (S7)', () => {
  it('reports every required field on an empty new draft', () => {
    const raw = newDraft({
      customer: { firstName: null, lastName: null },
      address: { kind: 'new', fields: nullFields() },
    });
    expect(evaluateMinimalCheckoutReadiness(normalize(raw))).toEqual({
      ready: false,
      missing: ALL_MISSING,
    });
  });

  it('treats whitespace-only values as blank (not provided)', () => {
    const raw = newDraft({
      customer: { firstName: '   ', lastName: null },
      address: {
        kind: 'new',
        fields: fullFields({
          street: ' ',
          exteriorNumber: '\t',
          neighborhood: ' ',
          zipCode: ' ',
          city: ' ',
          municipality: ' ',
          state: ' ',
        }),
      },
    });
    expect(evaluateMinimalCheckoutReadiness(normalize(raw))).toEqual({
      ready: false,
      missing: ALL_MISSING,
    });
  });

  it.each<MinimalCheckoutMissingField>(ALL_MISSING)(
    'reports %s as the only missing field',
    (field) => {
      expect(
        evaluateMinimalCheckoutReadiness(normalize(blankOnly(field))),
      ).toEqual({ ready: false, missing: [field] });
    },
  );

  it('is ready for a complete new address and leaves the surname optional', () => {
    const noSurname = newDraft({
      customer: { firstName: 'Ana', lastName: null },
    });
    const withSurname = newDraft({
      customer: { firstName: 'Ana', lastName: 'Pérez' },
    });
    expect(evaluateMinimalCheckoutReadiness(normalize(noSurname))).toEqual({
      ready: true,
      missing: [],
    });
    expect(evaluateMinimalCheckoutReadiness(normalize(withSurname))).toEqual({
      ready: true,
      missing: [],
    });
  });

  it('is ready for a complete saved address', () => {
    expect(evaluateMinimalCheckoutReadiness(normalize(savedDraft()))).toEqual({
      ready: true,
      missing: [],
    });
  });

  it.each([
    ['city only', { city: 'Guadalajara', municipality: null }],
    ['municipality only', { city: null, municipality: 'Zapopan' }],
  ])('accepts %s for the city/municipality requirement', (_label, fields) => {
    expect(
      evaluateMinimalCheckoutReadiness(
        normalize(withFields(fullFields(fields))),
      ).ready,
    ).toBe(true);
  });

  it('accepts "S/N" as a valid exterior number', () => {
    expect(
      evaluateMinimalCheckoutReadiness(
        normalize(withFields(fullFields({ exteriorNumber: 'S/N' }))),
      ).ready,
    ).toBe(true);
  });

  it('shares the gate for saved addresses without editing the snapshot', () => {
    const normalized = normalize(savedWithFields({ street: '' }));
    expect(evaluateMinimalCheckoutReadiness(normalized)).toEqual({
      ready: false,
      missing: ['street'],
    });
    expect(normalized.address.kind).toBe('saved');
    if (normalized.address.kind === 'saved') {
      expect(normalized.address.snapshot.street).toBe('');
    }
  });
});

describe('MinimalCheckoutConfirmation prepare', () => {
  it('offers a server-owned summary only for a trusted, complete draft', () => {
    const svc = make();
    const result = svc.prepare({
      senderId: SENDER,
      inboundEvent: EVENT,
      draft: newDraft(),
    });
    expect(result.kind).toBe('offer');
    if (result.kind !== 'offer') throw new Error('expected an offer');
    expect(result.reply).toBe(
      renderMinimalCheckoutConfirmation(normalize(newDraft())),
    );
    expect(result.reply).toContain('SÍ');
    expect(result.reply).not.toContain('pedido creado');
    expect(typeof result.reference).toBe('string');
    expect(result.reference.length).toBeGreaterThan(0);
    expect(typeof result.onSent).toBe('function');
    expect(svc.status(SENDER)).toEqual({
      stage: 'pending',
      reference: result.reference,
      revision: 0,
      armed: false,
      expiresAt: MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS,
    });
  });

  it('blocks an incomplete draft with the observable missing fields', () => {
    const svc = make();
    const result = svc.prepare({
      senderId: SENDER,
      inboundEvent: EVENT,
      draft: newDraft({
        customer: { firstName: null, lastName: null },
        address: { kind: 'new', fields: nullFields() },
      }),
    });
    expect(result).toEqual({
      kind: 'blocked',
      reason: 'incomplete',
      missing: ALL_MISSING,
    });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('blocks a foreign or malformed draft without binding a reference', () => {
    const svc = make();
    expect(
      svc.prepare({
        senderId: SENDER,
        inboundEvent: EVENT,
        draft: { ...newDraft(), senderId: 'foreign' },
      }),
    ).toEqual({ kind: 'blocked', reason: 'draft_unavailable', missing: [] });
    expect(
      svc.prepare({ senderId: SENDER, inboundEvent: EVENT, draft: null }),
    ).toEqual({ kind: 'blocked', reason: 'draft_unavailable', missing: [] });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('blocks an unbound or foreign inbound identity', () => {
    const svc = make();
    expect(
      svc.prepare({ senderId: SENDER, inboundEvent: null, draft: newDraft() }),
    ).toEqual({ kind: 'blocked', reason: 'identity_unbound', missing: [] });
    expect(
      svc.prepare({
        senderId: SENDER,
        inboundEvent: { ...EVENT, senderId: 'other' },
        draft: newDraft(),
      }),
    ).toEqual({ kind: 'blocked', reason: 'identity_unbound', missing: [] });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('arms only the live pending and never a replaced one', () => {
    const svc = make();
    const first = offer(svc);
    const second = offer(svc);
    first.onSent();
    expect(svc.status(SENDER)).toMatchObject({
      stage: 'pending',
      armed: false,
    });
    second.onSent();
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending', armed: true });
  });

  it('mints a fresh opaque reference per presentation', () => {
    const svc = make();
    const first = offer(svc).reference;
    const second = offer(svc).reference;
    expect(first).not.toBe(second);
    expect(first).toMatch(/[0-9a-f-]{8,}/i);
  });
});

describe('MinimalCheckoutConfirmation consume', () => {
  it('does not confirm before the offer is sent (unarmed)', () => {
    const svc = make();
    offer(svc);
    expect(say(svc)).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
    });
    expect(svc.status(SENDER)).toMatchObject({
      stage: 'pending',
      armed: false,
    });
  });

  it('returns a detached server-owned candidate that is not a confirmation', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    const result = say(svc);
    expect(result).toMatchObject({ kind: 'candidate', reference: o.reference });
    if (result?.kind !== 'candidate') throw new Error('expected a candidate');
    expect(result.draft).toEqual(normalize(newDraft()));
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending', armed: true });
    result.draft.customer.firstName = 'mutated';
    expect(say(svc)?.kind).toBe('candidate');
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending' });
  });

  it('never confirms on a foreign source phone', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    expect(
      say(svc, 'sí', { ...CONFIRM, receivingPhoneNumberId: '9'.repeat(15) }),
    ).toEqual({ kind: 'handled', reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY });
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending', armed: true });
  });

  it('ignores a turn whose sender has no pending', () => {
    const svc = make();
    offer(svc);
    expect(
      say(svc, 'sí', { ...CONFIRM, senderId: 'other' }, newDraft(), 'other'),
    ).toBeNull();
  });

  it('re-offers and can re-arm on a replay of the origin message', () => {
    const svc = make();
    const o = offer(svc);
    const replay = say(svc, 'sí', EVENT);
    expect(replay).toMatchObject({ kind: 'reoffer', reply: o.reply });
    if (replay?.kind !== 'reoffer') throw new Error('expected a reoffer');
    // A confirm attempt while unarmed is not consent.
    expect(say(svc)).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
    });
    replay.onSent();
    expect(say(svc)?.kind).toBe('candidate');
  });

  it('never confirms a replayed message even when the pending is armed', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    expect(say(svc, 'sí', EVENT)?.kind).toBe('reoffer');
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending' });
  });

  it('never confirms unrelated or mixed-correction text', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    expect(say(svc, 'sí, cambia la colonia')).toBeNull();
    expect(say(svc, '¿está bien?')).toBeNull();
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending', armed: true });
    expect(say(svc)?.kind).toBe('candidate');
  });

  it('invalidates the pending when content changed at the same revision', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    const changed = newDraft({
      address: { kind: 'new', fields: fullFields({ street: 'Otra calle' }) },
    });
    expect(say(svc, 'sí', CONFIRM, changed)).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_CHANGED_REPLY,
    });
    expect(svc.status(SENDER)).toBeNull();
    expect(say(svc)).toBeNull();
  });

  it('invalidates the pending when the revision changed', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    expect(say(svc, 'sí', CONFIRM, newDraft({ revision: 1 }))).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_CHANGED_REPLY,
    });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('expires after the five-minute pending TTL', () => {
    const svc = make();
    const o = offer(svc);
    o.onSent();
    clock.t += MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS;
    expect(say(svc)).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
    });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('a late onSent cannot revive an expired pending', () => {
    const svc = make();
    const o = offer(svc);
    clock.t += MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS + 1;
    o.onSent();
    // Expiry governs the attempt regardless of the late callback: handled,
    // never a candidate.
    expect(say(svc)).toEqual({
      kind: 'handled',
      reply: MINIMAL_CHECKOUT_AMBIGUOUS_REPLY,
    });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('does nothing without a pending', () => {
    const svc = make();
    expect(say(svc)).toBeNull();
    expect(svc.status(SENDER)).toBeNull();
  });
});

describe('MinimalCheckoutConfirmation finalize', () => {
  it('finalizes only after a successful checkpoint', () => {
    const svc = make();
    const candidate = candidateOf(svc);
    expect(svc.status(SENDER)).toMatchObject({ stage: 'pending' });
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({ kind: 'confirmed', reply: MINIMAL_CHECKOUT_CONFIRMED_REPLY });
    expect(svc.status(SENDER)).toEqual({
      stage: 'confirmed',
      reference: candidate.reference,
      revision: 0,
    });
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });

  it('a false checkpoint never finalizes and never retries', () => {
    const svc = make();
    const candidate = candidateOf(svc);
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: false }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
    expect(svc.status(SENDER)).toBeNull();
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });

  it('rejects a forged ticket that was never issued', () => {
    const svc = make();
    offer(svc).onSent();
    const forged = {
      kind: 'candidate',
      reference: 'forged-reference',
      draft: normalize(newDraft()),
    };
    expect(
      svc.finalize({ senderId: SENDER, candidate: forged, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('rejects a caller-mutated candidate draft', () => {
    const svc = make();
    const candidate = candidateOf(svc);
    candidate.draft.customer.firstName = 'mutated';
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });

  it('does not finalize a candidate after the pending expired', () => {
    const svc = make();
    const candidate = candidateOf(svc);
    clock.t += MINIMAL_CHECKOUT_CONFIRMATION_TTL_MS;
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });

  it('does not finalize a candidate replaced by a newer presentation', () => {
    const svc = make();
    const candidate = candidateOf(svc);
    offer(svc, newDraft({ revision: 1 }));
    expect(
      svc.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });

  it('invalidates a previous local confirmation on a new presentation', () => {
    const svc = make();
    const candidate = candidateOf(svc);
    svc.finalize({ senderId: SENDER, candidate, committed: true });
    expect(svc.status(SENDER)).toMatchObject({ stage: 'confirmed' });
    svc.prepare({
      senderId: SENDER,
      inboundEvent: EVENT,
      draft: newDraft({
        customer: { firstName: null, lastName: null },
        address: { kind: 'new', fields: nullFields() },
      }),
    });
    expect(svc.status(SENDER)).toBeNull();
  });

  it('loses volatile presentation and confirmation on a new instance', () => {
    const first = make();
    const candidate = candidateOf(first);
    first.finalize({ senderId: SENDER, candidate, committed: true });
    const restarted = make();
    expect(restarted.status(SENDER)).toBeNull();
    expect(say(restarted)).toBeNull();
    expect(
      restarted.finalize({ senderId: SENDER, candidate, committed: true }),
    ).toEqual({
      kind: 'not_confirmed',
      reply: MINIMAL_CHECKOUT_NOT_CONFIRMED_REPLY,
    });
  });
});
