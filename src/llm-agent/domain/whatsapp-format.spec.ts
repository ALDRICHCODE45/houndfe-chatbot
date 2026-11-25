import {
  ITEM_DETAIL_INDENT,
  TITLE_EMOJI,
  bold,
  italic,
  itemDetail,
  itemLine,
  money,
  sectionTitle,
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
});
