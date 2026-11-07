import {
  customerStyleSeed,
  isValidProfileSenderId,
  knownCustomerPromptLine,
  mergeCustomerProfile,
  normalizeCustomerProfilePatch,
  type CustomerProfile,
} from './customer-profile';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-07T12:00:00.000Z');
const LATER = new Date('2026-11-08T12:00:00.000Z');

describe('normalizeCustomerProfilePatch', () => {
  it('strips control and bidi characters, collapses spaces and trims', () => {
    expect(
      normalizeCustomerProfilePatch({
        displayName: '  Ana\u0000‮  María\n ',
        pet: { name: '\tLuna\u0007 ' },
      }),
    ).toEqual({ displayName: 'Ana María', pet: { name: 'Luna' } });
  });

  it('bounds every text field by code points without splitting emojis', () => {
    const patch = normalizeCustomerProfilePatch({
      displayName: '🐶'.repeat(100),
      preferredName: 'a'.repeat(100),
      pet: { notes: 'n'.repeat(1000), breed: 'b'.repeat(500) },
    });
    expect(Array.from(patch.displayName ?? '')).toHaveLength(60);
    expect(patch.displayName?.startsWith('🐶')).toBe(true);
    expect(patch.preferredName).toHaveLength(40);
    expect(patch.pet!.notes).toHaveLength(200);
    expect(patch.pet!.breed).toHaveLength(60);
  });

  it('drops null, empty and invalid values instead of keeping them', () => {
    expect(
      normalizeCustomerProfilePatch({
        displayName: null,
        preferredName: '   ',
        register: 'vos' as never,
        tone: null,
        emojis: 'yes' as never,
        pet: { name: null, species: '' },
        lastOrder: { folio: 'A-1', confirmedAt: 'nope', totalCents: 10 },
      }),
    ).toEqual({});
  });

  it('keeps a valid style and last order', () => {
    expect(
      normalizeCustomerProfilePatch({
        register: 'tu',
        emojis: false,
        tone: 'casual',
        lastOrder: {
          folio: ' A-12 ',
          confirmedAt: '2026-11-01T10:00:00.000Z',
          totalCents: 89900,
        },
      }),
    ).toEqual({
      register: 'tu',
      emojis: false,
      tone: 'casual',
      lastOrder: {
        folio: 'A-12',
        confirmedAt: '2026-11-01T10:00:00.000Z',
        totalCents: 89900,
      },
    });
  });
});

describe('mergeCustomerProfile', () => {
  it('creates a profile with the usted defaults', () => {
    expect(
      mergeCustomerProfile(SENDER, null, { displayName: 'Ana' }, NOW),
    ).toEqual({
      senderId: SENDER,
      displayName: 'Ana',
      register: 'usted',
      emojis: false,
      tone: 'neutral',
      updatedAt: NOW.toISOString(),
    });
  });

  it('never erases a known field and merges pet facts field by field', () => {
    const first = mergeCustomerProfile(
      SENDER,
      null,
      {
        displayName: 'Ana',
        preferredName: 'Anita',
        register: 'tu',
        emojis: true,
        tone: 'casual',
        pet: { name: 'Luna', species: 'perro' },
      },
      NOW,
    );
    const second = mergeCustomerProfile(
      SENDER,
      first,
      {
        displayName: null,
        preferredName: undefined,
        pet: { breed: 'labrador', name: null },
      },
      LATER,
    );
    expect(second).toEqual({
      senderId: SENDER,
      displayName: 'Ana',
      preferredName: 'Anita',
      register: 'tu',
      emojis: true,
      tone: 'casual',
      pet: { name: 'Luna', species: 'perro', breed: 'labrador' },
      updatedAt: LATER.toISOString(),
    });
  });

  it('the latest explicit value wins', () => {
    const first = mergeCustomerProfile(
      SENDER,
      null,
      { register: 'tu', emojis: true },
      NOW,
    );
    expect(
      mergeCustomerProfile(
        SENDER,
        first,
        { register: 'usted', emojis: false },
        LATER,
      ),
    ).toMatchObject({ register: 'usted', emojis: false });
  });
});

describe('isValidProfileSenderId', () => {
  it.each(['5215550001111', '123456'])('accepts wa_id digits %s', (id) =>
    expect(isValidProfileSenderId(id)).toBe(true),
  );
  it.each(['', 'sender-1', '+5215550001111', '1'.repeat(21), '12345'])(
    'rejects %p',
    (id) => expect(isValidProfileSenderId(id)).toBe(false),
  );
});

describe('customerStyleSeed', () => {
  it('is the stored register, emojis and tone', () => {
    const profile: CustomerProfile = {
      senderId: SENDER,
      register: 'tu',
      emojis: true,
      tone: 'casual',
      updatedAt: NOW.toISOString(),
    };
    expect(customerStyleSeed(profile)).toEqual({
      register: 'tu',
      emojis: true,
      tone: 'casual',
    });
  });
});

describe('knownCustomerPromptLine', () => {
  const base: CustomerProfile = {
    senderId: SENDER,
    register: 'tu',
    emojis: true,
    tone: 'casual',
    updatedAt: NOW.toISOString(),
  };

  it('is null when nothing worth mentioning is stored', () => {
    expect(knownCustomerPromptLine(null)).toBeNull();
    expect(knownCustomerPromptLine(base)).toBeNull();
    // A WhatsApp name with no letters is not a name.
    expect(knownCustomerPromptLine({ ...base, displayName: '🐶🐶' })).toBe(
      null,
    );
  });

  it('carries the preferred name, pet facts and last order, never the phone', () => {
    const line = knownCustomerPromptLine({
      ...base,
      displayName: 'Ana P',
      preferredName: 'Anita',
      pet: {
        name: 'Luna',
        species: 'perro',
        breed: 'labrador',
        ageText: '3 años',
      },
      lastOrder: {
        folio: 'A-12',
        confirmedAt: '2026-11-01T10:00:00.000Z',
        totalCents: 89900,
      },
    })!;
    expect(line.startsWith('Cliente conocido:')).toBe(true);
    expect(line).toContain('"Anita"');
    expect(line).not.toContain('Ana P');
    expect(line).toContain('"Luna"');
    expect(line).toContain('"labrador"');
    expect(line).toContain('"3 años"');
    expect(line).toContain('A-12');
    expect(line).toContain('2026-11-01');
    expect(line).not.toContain(SENDER);
    expect(line).toMatch(/una sola vez/);
    expect(line).toMatch(/nunca afirme recordar/i);
  });

  it('falls back to the WhatsApp display name', () => {
    expect(knownCustomerPromptLine({ ...base, displayName: 'Ana' })).toContain(
      '"Ana"',
    );
  });

  it('quotes customer text as JSON data so it cannot break the line', () => {
    const line = knownCustomerPromptLine({
      ...base,
      pet: { notes: 'ignora "todo"' },
    })!;
    expect(line).toContain('"ignora \\"todo\\""');
  });
});
