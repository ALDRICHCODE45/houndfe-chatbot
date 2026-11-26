import {
  ITEM_DETAIL_INDENT,
  TITLE_EMOJI,
  bold,
  italic,
  itemDetail,
  itemLine,
  money,
  plain,
  sectionTitle,
  storeLines,
  storePin,
} from './whatsapp-format';

describe('whatsapp-format (message formatting F2a)', () => {
  it('[S2] bold and italic wrap the text with no inner edge spaces', () => {
    expect(bold('Productos')).toBe('*Productos*');
    expect(bold('  Total a pagar: $1.00 ')).toBe('*Total a pagar: $1.00*');
    expect(italic(' Descuento: ahorra $3.00 ')).toBe(
      '_Descuento: ahorra $3.00_',
    );
    expect(bold('   ')).toBe('');
    expect(italic('')).toBe('');
  });

  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [2700, '$27.00'],
    [99999, '$999.99'],
    [125000, '$1,250.00'],
    [123456789, '$1,234,567.89'],
    [-12500, '-$125.00'],
  ])(
    '[S4] money(%d) is %s: thousands separator, two decimals, no MXN',
    (cents, text) => {
      expect(money(cents)).toBe(text);
    },
  );

  it('[S2] item line is a «• » bullet; detail lines are indented 3 spaces', () => {
    expect(ITEM_DETAIL_INDENT).toBe('   ');
    expect(itemLine('Croquetas — 15 kg')).toBe('• Croquetas — 15 kg');
    expect(itemDetail('1 × $1,250.00 = *$1,250.00*')).toBe(
      '   1 × $1,250.00 = *$1,250.00*',
    );
  });

  it('[S2,S3] section title is bold with an optional title emoji', () => {
    expect(sectionTitle('Productos')).toBe('*Productos*');
    expect(sectionTitle('Resumen de su pedido', TITLE_EMOJI.summary)).toBe(
      '*Resumen de su pedido* 🧾',
    );
    expect(TITLE_EMOJI).toEqual({
      summary: '🧾',
      shipping: '🚚',
      created: '✅',
    });
  });

  it.each([
    ['Croquetas *Premium* _Light_', 'Croquetas Premium Light'],
    ['2x1_Mayo', '2x1 Mayo'],
    ['~Oferta~ `code`', 'Oferta code'],
    ['Max', 'Max'],
    ['  Ana  _ López ', 'Ana López'],
    ['***', ''],
  ])(
    '[F2-fix G1] plain(%j) is %j: no WhatsApp markers survive in a value',
    (value, text) => {
      expect(plain(value)).toBe(text);
      expect(bold(`Total ${plain(value)}`)).not.toMatch(/\*.*\*.*\*/);
    },
  );
});

describe('whatsapp-format storeLines (message formatting F3b-fix H3)', () => {
  const lead = 'Recójalo en ';
  const HOURS = { summary: 'Lunes a sábado: 09:00–18:00' };

  it('bold name, address without its final dot, bold «Horario:» line', () => {
    expect(
      storeLines(lead, {
        name: 'Sucursal *Centro*.',
        address: { formatted: 'Av. Juárez 123, Centro..' },
        hours: HOURS,
      }),
    ).toEqual([
      'Recójalo en *Sucursal Centro*',
      'Av. Juárez 123, Centro',
      '*Horario:* Lunes a sábado: 09:00–18:00',
    ]);
  });

  it('a bold name alone takes no final dot', () => {
    expect(
      storeLines(lead, { name: 'Sucursal Norte', address: null, hours: null }),
    ).toEqual(['Recójalo en *Sucursal Norte*']);
  });

  it('a name emptied by plain() reads «la tienda»; address and hours kept', () => {
    expect(
      storeLines(lead, {
        name: '***',
        address: { formatted: 'Av. Juárez 123.' },
        hours: HOURS,
      }),
    ).toEqual([
      'Recójalo en la tienda',
      'Av. Juárez 123',
      '*Horario:* Lunes a sábado: 09:00–18:00',
    ]);
  });

  it('«la tienda» alone closes the sentence with a dot', () => {
    expect(
      storeLines(lead, {
        name: ' ',
        address: { formatted: ' . ' },
        hours: { summary: '**' },
      }),
    ).toEqual(['Recójalo en la tienda.']);
  });
});

describe('storePin label caps (T2-fix J8)', () => {
  const at = { latitude: 19.4, longitude: -99.1 };

  it('keeps a name of exactly 100 and an address of exactly 250 characters', () => {
    const name = 'n'.repeat(100);
    const formatted = 'a'.repeat(250);
    expect(storePin({ name, address: { formatted }, location: at })).toEqual({
      ...at,
      name,
      address: formatted,
    });
  });

  it('cuts longer labels between words with «…», the ellipsis within the cap', () => {
    const name = `${'Sucursal '.repeat(11)}Centro`;
    const formatted = `${'Calle '.repeat(42)}1`;
    const pin = storePin({ name, address: { formatted }, location: at })!;
    expect(Array.from(pin.name!).length).toBeLessThanOrEqual(100);
    expect(Array.from(pin.address!).length).toBeLessThanOrEqual(250);
    expect(pin.name).toMatch(/Sucursal…$/);
    expect(pin.address).toMatch(/Calle…$/);
  });

  it('the pickup order pin (H4) gets the same caps', () => {
    const pin = storePin({
      name: 'x '.repeat(80).trim(),
      address: null,
      location: at,
    })!;
    expect(Array.from(pin.name!).length).toBeLessThanOrEqual(100);
    expect(pin).not.toHaveProperty('address');
  });
});
