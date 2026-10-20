import {
  MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION,
  normalizeMinimalCheckoutDraft,
  type MinimalCheckoutDraft,
  type MinimalCheckoutDraftNewAddressFields,
} from './minimal-checkout-draft';
import type { CheckoutContextAddress } from '../../chatbot-api/domain/dtos/checkout-context.dto';
const SENDER = '+5215512345678';
const CUSTOMER_ID = 'abcdef01-2345-4789-8abc-def012345678';
const UPPER_ID = 'ABCDEF01-2345-4789-8ABC-DEF012345678';
const NIL_ID = '00000000-0000-0000-0000-000000000000';
const MAX_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const VERSION = '2026-10-12T15:16:12.000Z';
const NON_CANONICAL = '2026-10-12T15:16:12Z';
const FIELD_KEYS =
  'label street exteriorNumber interiorNumber zipCode neighborhood municipality city state visualReferences carrierPhone'.split(
    ' ',
  );
const newFields = (): MinimalCheckoutDraftNewAddressFields =>
  Object.fromEntries(
    FIELD_KEYS.map((key) => [key, null]),
  ) as unknown as MinimalCheckoutDraftNewAddressFields;
const savedSnapshot = (): CheckoutContextAddress => ({
  ...newFields(),
  id: UPPER_ID,
  version: VERSION,
  street: '',
});
const withFields = (value: string): Record<string, unknown> =>
  Object.fromEntries(FIELD_KEYS.map((key) => [key, value]));
const newDraft = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schemaVersion: MINIMAL_CHECKOUT_DRAFT_SCHEMA_VERSION,
  senderId: SENDER,
  revision: 0,
  sourceCustomerId: null,
  customer: { firstName: null, lastName: null },
  address: { kind: 'new', fields: newFields() },
  ...overrides,
});
const newWithCid = (sourceCustomerId: string) => newDraft({ sourceCustomerId });
const newWithFields = (fields: Record<string, unknown>) =>
  newDraft({ address: { kind: 'new', fields } });
const savedDraft = (overrides: Record<string, unknown> = {}) =>
  newDraft({
    sourceCustomerId: CUSTOMER_ID,
    address: { kind: 'saved', snapshot: savedSnapshot() },
    ...overrides,
  });
const savedWithoutCid = () =>
  newDraft({ address: { kind: 'saved', snapshot: savedSnapshot() } });
const savedWith = (overrides: Record<string, unknown> = {}) =>
  savedDraft({
    address: { kind: 'saved', snapshot: { ...savedSnapshot(), ...overrides } },
  });
const ACCESSOR_OPTS = { enumerable: true, configurable: true };
const defineAccessor = (target: object, key: string, get: () => unknown) =>
  Object.defineProperty(target, key, { ...ACCESSOR_OPTS, get });
const normalize = (raw: unknown, sender: string = SENDER) =>
  normalizeMinimalCheckoutDraft(raw, sender);
const snapshotOf = (draft: MinimalCheckoutDraft | null) =>
  (draft?.address as { snapshot?: CheckoutContextAddress })?.snapshot;
describe('normalizeMinimalCheckoutDraft', () => {
  describe('accepted records', () => {
    it('detaches corrected fields and the exact base snapshot independently', () => {
      const raw = savedDraft({
        address: {
          kind: 'savedCorrected',
          snapshot: savedSnapshot(),
          fields: { ...newFields(), street: 'Centro', zipCode: '55635' },
        },
      });
      const parsed = normalize(raw);
      expect(parsed).toEqual(raw);
      expect(parsed).not.toBe(raw);
      const corrected = parsed?.address as unknown as {
        snapshot: CheckoutContextAddress;
        fields: MinimalCheckoutDraftNewAddressFields;
      };
      corrected.fields.zipCode = 'other';
      corrected.snapshot.street = 'other';
      expect(normalize(raw)).toEqual(raw);
      expect(normalize({ ...raw, sourceCustomerId: null })).toBeNull();
      for (const address of [
        { ...corrected, kind: 'savedCorrected', extra: true },
        {
          ...corrected,
          kind: 'savedCorrected',
          fields: { ...corrected.fields, id: UPPER_ID },
        },
        {
          ...corrected,
          kind: 'savedCorrected',
          snapshot: { ...savedSnapshot(), version: NON_CANONICAL },
        },
        {
          ...corrected,
          kind: 'savedCorrected',
          fields: { ...corrected.fields, zipCode: undefined },
        },
      ]) {
        expect(normalize({ ...raw, address })).toBeNull();
      }
    });
    it('accepts an incomplete new draft preserving null partial data', () => {
      expect(normalize(newDraft())).toEqual<MinimalCheckoutDraft>({
        schemaVersion: 1,
        senderId: SENDER,
        revision: 0,
        sourceCustomerId: null,
        customer: { firstName: null, lastName: null },
        address: { kind: 'new', fields: newFields() },
      });
    });
    it('accepts one-sided customer names and the max safe revision', () => {
      const draft = normalize(
        newDraft({
          revision: Number.MAX_SAFE_INTEGER,
          customer: { firstName: 'Ana', lastName: null },
        }),
      );
      expect(draft?.revision).toBe(Number.MAX_SAFE_INTEGER);
      expect(draft?.customer).toEqual({ firstName: 'Ana', lastName: null });
    });
    it('accepts a saved draft retaining the exact snapshot', () => {
      const draft = normalize(savedDraft());
      expect(draft?.sourceCustomerId).toBe(CUSTOMER_ID);
      expect(draft?.address).toEqual({
        kind: 'saved',
        snapshot: savedSnapshot(),
      });
    });
    it('preserves permitted empty strings across every saved snapshot field', () => {
      const empty = withFields('');
      expect(normalize(savedWith(empty))?.address).toEqual({
        kind: 'saved',
        snapshot: { ...savedSnapshot(), ...empty },
      });
    });
    it('preserves the canonical version verbatim', () =>
      expect(snapshotOf(normalize(savedDraft()))?.version).toBe(VERSION));
  });
  describe('identity, schema and revision', () => {
    it.each([
      ['upper', UPPER_ID],
      ['nil', NIL_ID],
      ['max', MAX_ID],
      ['lower v4', CUSTOMER_ID],
      ['v1', 'abcdef01-2345-1789-8abc-def012345678'],
      ['v8', 'abcdef01-2345-8789-8abc-def012345678'],
    ])('preserves a valid sourceCustomerId (%s) verbatim', (_label, id) =>
      expect(normalize(newWithCid(id))?.sourceCustomerId).toBe(id),
    );
    it.each([
      ['not-a-uuid', 'not-a-uuid'],
      ['empty string', ''],
      ['nil-with-suffix', '00000000-0000-0000-0000-000000000001'],
      ['v9', 'abcdef01-2345-9789-8abc-def012345678'],
      ['short', 'abcdef01-2345-4789-8abc-def01234567'],
      ['whitespace-padded', ` ${CUSTOMER_ID} `],
    ])(
      'rejects a non-null malformed sourceCustomerId (%s) on a new draft',
      (_label, id) => expect(normalize(newWithCid(id))).toBeNull(),
    );
    it.each([
      ['not-a-uuid', 'not-a-uuid'],
      ['empty string', ''],
      ['v9', 'abcdef01-2345-9789-8abc-def012345678'],
    ])(
      'rejects a non-null malformed sourceCustomerId (%s) on a saved draft',
      (_label, id) =>
        expect(normalize(savedDraft({ sourceCustomerId: id }))).toBeNull(),
    );
    it('requires a non-null sourceCustomerId for a saved address', () =>
      expect(normalize(savedWithoutCid())).toBeNull());
    it.each([
      ['foreign', '15519998888'],
      ['near-miss digit', '+5215512345679'],
      ['padded', ` ${SENDER}`],
      ['empty', ''],
    ])('rejects a %s senderId', (_label, senderId) =>
      expect(normalize(newDraft({ senderId }))).toBeNull(),
    );
    it.each([
      ['blank', '   '],
      ['empty', ''],
    ])('rejects a %s expected-sender context', (_label, context) =>
      expect(normalize(newDraft(), context)).toBeNull(),
    );
    it.each([
      ['negative', -1],
      ['fractional', 1.5],
      ['unsafe', Number.MAX_SAFE_INTEGER + 2],
      ['string', '0'],
    ])('rejects a %s revision', (_label, revision) =>
      expect(normalize(newDraft({ revision }))).toBeNull(),
    );
    it('rejects a wrong schemaVersion or type', () => {
      expect(normalize(newDraft({ schemaVersion: 2 }))).toBeNull();
      expect(normalize(newDraft({ schemaVersion: '1' }))).toBeNull();
    });
  });
  describe('strict structural guards', () => {
    it.each([
      ['null raw', null],
      ['undefined raw', undefined],
      ['array raw', []],
      ['number raw', 42],
    ])('rejects a %s', (_label, raw) => expect(normalize(raw)).toBeNull());
    it('rejects missing and extra top-level keys', () => {
      const missing = newDraft();
      delete missing.revision;
      expect(normalize(missing)).toBeNull();
      expect(normalize(newDraft({ extra: 1 }))).toBeNull();
    });
    it('rejects symbol keys and explicit undefined values', () => {
      const symbol = newDraft();
      (symbol as Record<PropertyKey, unknown>)[Symbol('x')] = 1;
      expect(normalize(symbol)).toBeNull();
      expect(normalize(newDraft({ sourceCustomerId: undefined }))).toBeNull();
    });
    it('rejects wrong-typed top-level fields', () => {
      expect(normalize(newDraft({ senderId: 5 }))).toBeNull();
      expect(normalize(newDraft({ revision: '0' }))).toBeNull();
      expect(normalize(newDraft({ sourceCustomerId: 5 }))).toBeNull();
      expect(normalize(newDraft({ customer: null }))).toBeNull();
      expect(normalize(newDraft({ address: null }))).toBeNull();
    });
    it('rejects malformed customer objects', () => {
      const cases = [
        { firstName: 1, lastName: null },
        { firstName: null },
        { firstName: null, lastName: null, extra: 1 },
        { firstName: undefined, lastName: null },
      ];
      for (const customer of cases)
        expect(normalize(newDraft({ customer }))).toBeNull();
    });
    it('rejects mutually-exclusive shape mixing', () => {
      const mixedNew = newDraft({
        address: {
          kind: 'new',
          fields: newFields(),
          snapshot: savedSnapshot(),
        },
      });
      const mixedSaved = savedDraft({
        address: {
          kind: 'saved',
          snapshot: savedSnapshot(),
          fields: newFields(),
        },
      });
      expect(normalize(mixedNew)).toBeNull();
      expect(normalize(mixedSaved)).toBeNull();
      expect(normalize(newDraft({ address: { kind: 'other' } }))).toBeNull();
      expect(
        normalize(newDraft({ address: { fields: newFields() } })),
      ).toBeNull();
    });
    it('rejects malformed new-address fields', () => {
      const cases = [
        { ...newFields(), street: 1 },
        { label: null },
        { ...newFields(), extra: null },
      ];
      for (const fields of cases)
        expect(normalize(newWithFields(fields))).toBeNull();
    });
    it('rejects malformed saved snapshots', () => {
      expect(normalize(savedWith({ id: 'nope' }))).toBeNull();
      expect(normalize(savedWith({ version: NON_CANONICAL }))).toBeNull();
      expect(normalize(savedWith({ street: null }))).toBeNull();
      expect(normalize(savedWith({ carrierPhone: 1 }))).toBeNull();
      expect(normalize(savedWith({ extra: null }))).toBeNull();
    });
    it('rejects a non-canonical or impossible instant', () =>
      expect(
        normalize(savedWith({ version: '2026-13-40T00:00:00.000Z' })),
      ).toBeNull());
  });
  describe('saved snapshot UUID parity', () => {
    it.each([
      ['upper', UPPER_ID],
      ['nil', NIL_ID],
      ['max', MAX_ID],
      ['v1', 'abcdef01-2345-1789-8abc-def012345678'],
      ['v8', 'abcdef01-2345-8789-8abc-def012345678'],
    ])('retains an accepted %s snapshot id verbatim', (_label, id) =>
      expect(snapshotOf(normalize(savedWith({ id })))?.id).toBe(id),
    );
  });
  describe('hostile accessors fail closed', () => {
    it('rejects an accessor-backed top-level field', () =>
      expect(
        normalize(defineAccessor(newDraft(), 'revision', () => 0)),
      ).toBeNull());
    it('rejects an accessor-backed senderId without yielding a foreign sender', () =>
      expect(
        normalize(defineAccessor(newDraft(), 'senderId', () => SENDER)),
      ).toBeNull());
    it('rejects accessor-backed nested fields and customer names', () => {
      const raw = newDraft();
      defineAccessor(
        (raw.address as { fields: Record<string, unknown> }).fields,
        'street',
        () => 'Calle 1',
      );
      expect(normalize(raw)).toBeNull();
      const other = newDraft();
      defineAccessor(other.customer as object, 'firstName', () => 'Ana');
      expect(normalize(other)).toBeNull();
    });
  });
  describe('detachment', () => {
    it('detaches returned customer and new-address fields from the input', () => {
      const input = newDraft({
        customer: { firstName: null, lastName: 'Doe' },
      });
      const draft = normalize(input);
      expect(draft).not.toBeNull();
      draft!.customer.firstName = 'Mutated';
      (
        input.address as { fields: MinimalCheckoutDraftNewAddressFields }
      ).fields.street = 'Changed';
      expect((input.customer as { firstName: unknown }).firstName).toBeNull();
      expect(
        (draft!.address as { fields: MinimalCheckoutDraftNewAddressFields })
          .fields.street,
      ).toBeNull();
      (input.customer as { lastName: unknown }).lastName = 'Changed';
      expect(draft!.customer.lastName).toBe('Doe');
    });
    it('detaches the returned saved snapshot from the input', () => {
      const input = savedDraft({ revision: 3 });
      const draft = normalize(input);
      expect(draft).not.toBeNull();
      const returned = snapshotOf(draft)!;
      const original = (input.address as { snapshot: CheckoutContextAddress })
        .snapshot;
      returned.street = 'Mutated';
      original.label = 'Changed';
      expect(original.street).toBe('');
      expect(returned.label).toBeNull();
    });
  });
});
