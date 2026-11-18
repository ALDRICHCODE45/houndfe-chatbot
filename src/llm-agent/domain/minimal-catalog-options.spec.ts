import type { CatalogItemResponse } from '../../chatbot-api/domain/dtos/catalog.dto';
import {
  CATALOG_ADD_QUESTION,
  CATALOG_CHOOSE_QUESTION,
  CATALOG_NARROWING_QUESTION,
  classifyCatalogItem,
  planCatalogOptions,
  renderCatalogOptions,
} from './minimal-catalog-options';
import { DEFAULT_CUSTOMER_STYLE, applyCustomerStyle } from './customer-style';

const pid = (n: number) =>
  `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const vid = (n: number) =>
  `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Stock = CatalogItemResponse['stock'];
const available: Stock = { status: 'available', quantity: 10 };
const agotado: Stock = { status: 'out_of_stock', quantity: 0 };

function item(
  n: number,
  over: Partial<CatalogItemResponse> & { name: string },
): CatalogItemResponse {
  return {
    productId: pid(n),
    brand: null,
    imageUrl: null,
    description: null,
    price: {
      priceCents: 10000,
      fromPriceCents: null,
      promoPriceCents: null,
      promotionEvaluationStatus: 'needs_human_review',
    },
    stock: available,
    packageInfo: { weightGrams: null, dimensions: null },
    variants: [],
    ...over,
  };
}

const usted = (text: string) =>
  applyCustomerStyle(text, DEFAULT_CUSTOMER_STYLE);
const tu = (text: string) =>
  applyCustomerStyle(text, { ...DEFAULT_CUSTOMER_STYLE, register: 'tu' });

// Production evidence (S13, 2026-11-17): "croquetas pedigree manejan?".
const dentastix = item(1, {
  name: 'Pedigree Dentastix Premios Dentales Perro Mediano 7 pzas',
  brand: 'Pedigree',
  description: 'Premios para la limpieza dental de su perro.',
  price: {
    priceCents: 8900,
    fromPriceCents: null,
    promoPriceCents: null,
    promotionEvaluationStatus: 'needs_human_review',
  },
});
const naturales = item(2, {
  name: '[PRUEBA] Croquetas Naturales sin Grano Salmón y Camote 2 kg',
  brand: 'Naturales',
  description: 'Croquetas para perros adultos de raza grande. Sin granos.',
  price: {
    priceCents: 45000,
    fromPriceCents: null,
    promoPriceCents: null,
    promotionEvaluationStatus: 'needs_human_review',
  },
});
const lata = item(3, {
  name: 'Pedigree Adulto Trozos de Res en Salsa Lata 375 g',
  brand: 'Pedigree',
  description: 'Alimento húmedo para perro adulto.',
  stock: agotado,
  price: {
    priceCents: 4900,
    fromPriceCents: null,
    promoPriceCents: null,
    promotionEvaluationStatus: 'needs_human_review',
  },
});

describe('classifyCatalogItem (S13b)', () => {
  const brands = [dentastix, naturales, lata];
  it('splits brand and type tokens and classifies each item', () => {
    expect(classifyCatalogItem('croquetas pedigree', dentastix, brands)).toBe(
      'brand_only',
    );
    expect(classifyCatalogItem('croquetas pedigree', naturales, brands)).toBe(
      'same_type',
    );
    expect(classifyCatalogItem('croquetas pedigree', lata, brands)).toBe(
      'brand_only',
    );
  });

  it('exact when every significant token is present (plural/accents folded) or backend match all', () => {
    const pedigreeCroquetas = item(4, {
      name: 'Croqueta Pedigree Adulto 4 kg',
      brand: 'Pedigree',
    });
    expect(
      classifyCatalogItem('croquetas pedigree', pedigreeCroquetas, [
        pedigreeCroquetas,
      ]),
    ).toBe('exact');
    expect(
      classifyCatalogItem(
        'croquetas pedigree',
        { ...dentastix, match: 'all' },
        brands,
      ),
    ).toBe('exact');
    expect(
      classifyCatalogItem('salmón', item(5, { name: 'Lata de salmon' }), []),
    ).toBe('exact');
  });

  it('a partial backend flag is never exact; no token at all is other', () => {
    const both = item(6, {
      name: 'Croquetas Pedigree',
      brand: 'Pedigree',
      match: 'partial',
    });
    expect(classifyCatalogItem('croquetas pedigree', both, [both])).not.toBe(
      'exact',
    );
    expect(
      classifyCatalogItem('croquetas pedigree', item(7, { name: 'Arena' }), []),
    ).toBe('other');
  });
});

describe('planCatalogOptions + renderCatalogOptions (S13)', () => {
  it('prod case: croquetas pedigree → other-brand croquetas first, Dentastix after, lata as agotado, exact closing', () => {
    const plan = planCatalogOptions('croquetas pedigree', [
      dentastix,
      naturales,
      lata,
    ]);
    expect(plan).not.toBeNull();
    const out = renderCatalogOptions([plan!], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.text).toBe(
      [
        'Croquetas Pedigree no tengo, pero tengo estas opciones:',
        '• *[PRUEBA] Croquetas Naturales sin Grano Salmón y Camote 2 kg* (de otra marca): Croquetas para perros adultos de raza grande. $450.00 MXN',
        '• *Pedigree Dentastix Premios Dentales Perro Mediano 7 pzas*: Premios para la limpieza dental de su perro. $89.00 MXN',
        'Además, tengo Pedigree Adulto Trozos de Res en Salsa Lata 375 g, pero está agotado.',
        '',
        '¿Cuál le gustaría llevar? Y si la que busca es Pedigree Adulto Trozos de Res en Salsa Lata 375 g, con gusto le averiguo cuándo nos vuelve a llegar.',
      ].join('\n'),
    );
    expect(
      out.text.startsWith(
        'Croquetas Pedigree no tengo, pero tengo estas opciones:',
      ),
    ).toBe(true);
    // Never promises Pedigree croquetas in the restock sentence.
    const closing = out.text.split('\n').at(-1)!;
    expect(closing.toLowerCase()).not.toContain('croquetas pedigree');
    expect(closing.toLowerCase()).not.toContain('croquetas de pedigree');
    expect(out.restockOffer).toEqual({
      productId: lata.productId,
      name: lata.name,
    });
    expect(out.shown.map((i) => i.productId)).toEqual([
      naturales.productId,
      dentastix.productId,
      lata.productId,
    ]);
  });

  it('exact matches open with «Encontré estas opciones:» and close with the plain question', () => {
    const a = item(10, {
      name: 'Nupec Cachorro Raza Pequeña 2 kg',
      brand: 'Nupec',
    });
    const b = item(11, {
      name: 'Nupec Cachorro Raza Grande 8 kg',
      brand: 'Nupec',
    });
    const plan = planCatalogOptions('nupec cachorro', [a, b])!;
    const out = renderCatalogOptions([plan], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.text).toBe(
      [
        'Encontré estas opciones:',
        '• *Nupec Cachorro Raza Pequeña 2 kg*: $100.00 MXN',
        '• *Nupec Cachorro Raza Grande 8 kg*: $100.00 MXN',
        '',
        CATALOG_CHOOSE_QUESTION,
      ].join('\n'),
    );
    expect(out.restockOffer).toBeNull();
  });

  it('exact before same-type before brand-only; a same-brand item is not labelled de otra marca', () => {
    const brandOnly = item(20, {
      name: 'Pedigree Dentastix',
      brand: 'Pedigree',
    });
    const sameType = item(21, { name: 'Croquetas Ganador', brand: 'Ganador' });
    const exact = item(22, {
      name: 'Croquetas Pedigree Cachorro',
      brand: 'Pedigree',
    });
    const plan = planCatalogOptions('croquetas pedigree', [
      brandOnly,
      sameType,
      exact,
    ])!;
    const out = renderCatalogOptions([plan], {
      restockAvailable: false,
      style: usted,
    });
    expect(out.shown.map((i) => i.productId)).toEqual([
      exact.productId,
      sameType.productId,
      brandOnly.productId,
    ]);
    expect(out.text.split('\n')[0]).toBe('Encontré estas opciones:');
    expect(out.text).toContain('*Croquetas Ganador* (de otra marca)');
    expect(out.text).not.toContain(
      '*Croquetas Pedigree Cachorro* (de otra marca)',
    );
  });

  it('no brand requested → no «(de otra marca)» label', () => {
    const a = item(30, { name: 'Croquetas Ganador', brand: 'Ganador' });
    const plan = planCatalogOptions('croquetas para cachorro', [
      a,
      item(31, { name: 'Croquetas Cachorro Nupec', brand: 'Nupec' }),
    ])!;
    expect(
      renderCatalogOptions([plan], { restockAvailable: true, style: usted })
        .text,
    ).not.toContain('de otra marca');
  });

  it('brand-only is omitted when 3 better options exist; >3 relevant → fixed narrowing question', () => {
    const items = [
      item(40, { name: 'Pedigree Dentastix', brand: 'Pedigree' }),
      item(41, { name: 'Croquetas Ganador', brand: 'Ganador' }),
      item(42, { name: 'Croquetas Nupec', brand: 'Nupec' }),
      item(43, { name: 'Croquetas Hills', brand: 'Hills' }),
    ];
    const plan = planCatalogOptions('croquetas pedigree', items)!;
    const out = renderCatalogOptions([plan], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.shown.map((i) => i.productId)).toEqual([
      pid(41),
      pid(42),
      pid(43),
    ]);
    expect(plan.moreResults).toBe(1);
    expect(out.text.endsWith(CATALOG_NARROWING_QUESTION)).toBe(true);
    expect(out.text).not.toContain(CATALOG_CHOOSE_QUESTION);
  });

  it('an agotado product never takes the place of an available one', () => {
    const items = [
      item(50, { name: 'Croquetas A', stock: agotado }),
      item(51, { name: 'Croquetas B' }),
      item(52, { name: 'Croquetas C' }),
      item(53, { name: 'Croquetas D' }),
    ];
    const plan = planCatalogOptions('croquetas', items)!;
    expect(
      renderCatalogOptions([plan], {
        restockAvailable: true,
        style: usted,
      }).shown.map((i) => i.productId),
    ).toEqual([pid(51), pid(52), pid(53)]);
  });

  it('only agotado + restock → «{nombre} está agotado. ¿Quiere que le pregunte al equipo cuándo vuelve a llegar?»', () => {
    const plan = planCatalogOptions('lata pedigree', [lata])!;
    const out = renderCatalogOptions([plan], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.text).toBe(
      'Pedigree Adulto Trozos de Res en Salsa Lata 375 g está agotado. ¿Quiere que le pregunte al equipo cuándo vuelve a llegar?',
    );
    expect(out.restockOffer).toEqual({
      productId: lata.productId,
      name: lata.name,
    });
  });

  it('only agotado alternative + restock opens with what was asked and names the exact product', () => {
    const plan = planCatalogOptions('croquetas pedigree', [lata])!;
    const out = renderCatalogOptions([plan], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.text).toBe(
      'Croquetas Pedigree no tengo.\n\nPedigree Adulto Trozos de Res en Salsa Lata 375 g está agotado. ¿Quiere que le pregunte al equipo cuándo vuelve a llegar?',
    );
  });

  it('restock not available → no restock promise, no offer', () => {
    const only = renderCatalogOptions(
      [planCatalogOptions('lata pedigree', [lata])!],
      { restockAvailable: false, style: usted },
    );
    expect(only.text).toBe(
      'Pedigree Adulto Trozos de Res en Salsa Lata 375 g está agotado.',
    );
    expect(only.restockOffer).toBeNull();
    const mixed = renderCatalogOptions(
      [planCatalogOptions('croquetas pedigree', [dentastix, naturales, lata])!],
      { restockAvailable: false, style: usted },
    );
    expect(mixed.text.endsWith(`\n\n${CATALOG_CHOOSE_QUESTION}`)).toBe(true);
    expect(mixed.text).not.toContain('averiguo');
    expect(mixed.text).toContain(
      'Además, tengo Pedigree Adulto Trozos de Res en Salsa Lata 375 g, pero está agotado.',
    );
    expect(mixed.restockOffer).toBeNull();
  });

  it('tú styling applies to the fixed copy only, never to product data', () => {
    const quirky = item(60, {
      name: 'Croquetas Revise Su carrito',
      description: 'Indique su talla.',
    });
    const gone = item(61, {
      name: 'Croquetas Pedigree Adulto 4 kg',
      stock: agotado,
    });
    const out = renderCatalogOptions(
      [planCatalogOptions('croquetas', [quirky, gone])!],
      { restockAvailable: true, style: tu },
    );
    expect(out.text).toContain(
      '*Croquetas Revise Su carrito*: Indique su talla.',
    );
    expect(out.text).toContain(
      '¿Cuál te gustaría llevar? Y si la que buscas es Croquetas Pedigree Adulto 4 kg, con gusto te averiguo cuándo nos vuelve a llegar.',
    );
    const onlyTu = renderCatalogOptions(
      [planCatalogOptions('lata pedigree', [lata])!],
      { restockAvailable: true, style: tu },
    );
    expect(onlyTu.text).toContain(
      '¿Quieres que le pregunte al equipo cuándo vuelve a llegar?',
    );
    const narrowTu = tu(CATALOG_NARROWING_QUESTION);
    expect(narrowTu).not.toBe(CATALOG_NARROWING_QUESTION);
    expect(narrowTu).toContain('buscas?');
  });

  it('variants: presentations with prices, agotado presentations marked; a fully agotado variant product names its presentations', () => {
    const mixed = item(70, {
      name: 'Croquetas Nupec Adulto',
      price: {
        priceCents: null,
        fromPriceCents: 20000,
        promoPriceCents: null,
        promotionEvaluationStatus: 'needs_human_review',
      },
      stock: agotado,
      variants: [
        {
          variantId: vid(1),
          name: '2 kg',
          option: null,
          value: null,
          priceCents: 20000,
          stock: available,
        },
        {
          variantId: vid(2),
          name: '8 kg',
          option: null,
          value: null,
          priceCents: 70000,
          stock: agotado,
        },
      ],
    });
    const gone = item(71, {
      name: 'Croquetas Ganador Cachorro',
      variants: [
        {
          variantId: vid(3),
          name: '4 kg',
          option: null,
          value: null,
          priceCents: 30000,
          stock: agotado,
        },
        {
          variantId: vid(4),
          name: '10 kg',
          option: null,
          value: null,
          priceCents: 60000,
          stock: agotado,
        },
      ],
    });
    const out = renderCatalogOptions(
      [planCatalogOptions('croquetas', [gone, mixed])!],
      { restockAvailable: true, style: usted },
    );
    expect(out.text).toBe(
      [
        'Encontré estas opciones:',
        '• *Croquetas Nupec Adulto*: 2 kg $200.00 MXN, 8 kg $700.00 MXN (agotada)',
        'Además, tengo Croquetas Ganador Cachorro (4 kg y 10 kg), pero está agotado.',
        '',
        // Multi-presentation agotado has no single restock subject: no promise.
        CATALOG_CHOOSE_QUESTION,
      ].join('\n'),
    );
    expect(out.restockOffer).toBeNull();
    const single = item(72, {
      name: 'Croquetas Hills',
      variants: [
        {
          variantId: vid(5),
          name: '3 kg',
          option: null,
          value: null,
          priceCents: 50000,
          stock: agotado,
        },
      ],
    });
    expect(
      renderCatalogOptions([planCatalogOptions('croquetas hills', [single])!], {
        restockAvailable: true,
        style: usted,
      }).restockOffer,
    ).toEqual({
      productId: pid(72),
      variantId: vid(5),
      name: 'Croquetas Hills',
    });
  });

  it('one available option with a cart closes with the cart offer (a bare "sí" adds it), and then "sí" does not accept the restock', () => {
    const single = renderCatalogOptions(
      [planCatalogOptions('croquetas pedigree', [naturales, lata])!],
      { restockAvailable: true, style: usted, cartAvailable: true },
    );
    expect(single.text.split('\n').at(-1)).toBe(
      `${CATALOG_ADD_QUESTION} Y si la que busca es ${lata.name}, con gusto le averiguo cuándo nos vuelve a llegar.`,
    );
    expect(single.restockOffer).not.toBeNull();
    expect(single.restockAcceptsYes).toBe(false);
    expect(tu(CATALOG_ADD_QUESTION)).toBe('¿Te lo agrego al carrito?');
    const noCart = renderCatalogOptions(
      [planCatalogOptions('croquetas pedigree', [naturales, lata])!],
      { restockAvailable: true, style: usted },
    );
    expect(noCart.text).toContain(CATALOG_CHOOSE_QUESTION);
    expect(noCart.restockAcceptsYes).toBe(true);
    const several = renderCatalogOptions(
      [planCatalogOptions('croquetas pedigree', [dentastix, naturales, lata])!],
      { restockAvailable: true, style: usted, cartAvailable: true },
    );
    expect(several.text).toContain(CATALOG_CHOOSE_QUESTION);
    expect(several.restockAcceptsYes).toBe(true);
  });

  it('a product with many presentations lists 6 and counts the rest', () => {
    const many = item(85, {
      name: 'Croquetas Nupec',
      variants: Array.from({ length: 10 }, (_, i) => ({
        variantId: vid(100 + i),
        name: `P${i + 1}`,
        option: null,
        value: null,
        priceCents: 100,
        stock: available,
      })),
    });
    const text = renderCatalogOptions(
      [planCatalogOptions('croquetas', [many])!],
      { restockAvailable: false, style: usted },
    ).text;
    expect(text).toContain('P6 $1.00 MXN y 4 presentaciones más');
    expect(text).not.toContain('P7');
  });

  it('no classifiable item, no token, or no item → null (the model answers as before)', () => {
    expect(planCatalogOptions('croquetas pedigree', [])).toBeNull();
    expect(
      planCatalogOptions('croquetas pedigree', [item(80, { name: 'Arena' })]),
    ).toBeNull();
    expect(
      planCatalogOptions('quiero de', [item(81, { name: 'Arena' })]),
    ).toBeNull();
  });

  it('several searches in one turn: one section each, products deduped, one closing', () => {
    const arena = item(90, {
      name: 'Arena para gato Cat Litter',
      brand: 'Cat Litter',
    });
    const out = renderCatalogOptions(
      [
        planCatalogOptions('croquetas pedigree', [dentastix, naturales, lata])!,
        planCatalogOptions('arena gato', [arena, naturales])!,
      ],
      { restockAvailable: true, style: usted },
    );
    expect(out.shown.map((i) => i.productId)).toEqual([
      naturales.productId,
      dentastix.productId,
      lata.productId,
      arena.productId,
    ]);
    expect(out.text.match(/¿Cuál le gustaría llevar\?/g)).toHaveLength(1);
    expect(out.text).toContain(
      'Encontré estas opciones:\n• *Arena para gato Cat Litter*',
    );
  });
});

describe('S10/S13 contradiction class (life stage, species)', () => {
  const nupec = item(200, {
    name: 'Nupec Cachorro Razas Medianas y Grandes',
    brand: 'Nupec',
    description:
      'Alimento seco premium para cachorros de razas medianas y grandes.',
  });
  const adultos = item(201, {
    name: '[PRUEBA] Croquetas Naturales sin Grano Salmón y Camote para Perros Adultos de Raza Grande',
    brand: 'Naturales',
    description: 'Croquetas para perros adultos de raza grande.',
  });

  it('prod case: "croquetas para cachorro" offers only Nupec; the adult croquetas are not mentioned', () => {
    expect(
      classifyCatalogItem('croquetas para cachorro', adultos, [nupec, adultos]),
    ).toBe('contradicts');
    const plan = planCatalogOptions('croquetas para cachorro', [
      adultos,
      nupec,
    ])!;
    const out = renderCatalogOptions([plan], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.shown.map((i) => i.productId)).toEqual([nupec.productId]);
    expect(out.text).toContain('*Nupec Cachorro Razas Medianas y Grandes*');
    expect(out.text).not.toContain('Naturales');
    expect(out.text).not.toContain('Adultos');
    expect(plan.moreResults).toBe(0);
  });

  it('contradicting items never count toward the 3 nor trigger the narrowing question', () => {
    const adult = (n: number) =>
      item(210 + n, { name: `Croquetas Adulto ${n}`, description: null });
    const plan = planCatalogOptions('croquetas cachorro', [
      adult(1),
      adult(2),
      adult(3),
      nupec,
      adult(4),
    ])!;
    expect(plan.options.map((o) => o.item.productId)).toEqual([
      nupec.productId,
    ]);
    expect(plan.moreResults).toBe(0);
    expect(
      renderCatalogOptions([plan], { restockAvailable: true, style: usted })
        .text,
    ).not.toContain(CATALOG_NARROWING_QUESTION);
  });

  it('only contradicting items → «{lo pedido} no tengo por ahora. ¿Quiere que le pregunte al equipo…?» and none of them listed (no false match)', () => {
    const plan = planCatalogOptions('croquetas para cachorro', [adultos]);
    expect(plan).not.toBeNull();
    const out = renderCatalogOptions([plan!], {
      restockAvailable: true,
      style: usted,
    });
    expect(out.text).toBe(
      'Croquetas para cachorro no tengo por ahora. ¿Quiere que le pregunte al equipo si lo pueden conseguir, o le busco otra cosa?',
    );
    expect(out.shown).toEqual([]);
    expect(out.restockOffer).toBeNull();
  });

  it('"alimento para gato" excludes a dog product; accents, case and plural folded', () => {
    const dog = item(220, {
      name: 'Alimento Húmedo PERROS Res',
      description: 'Para perro adulto.',
    });
    const cat = item(221, { name: 'Alimento para Gato Salmón' });
    expect(classifyCatalogItem('alimento para gato', dog, [dog, cat])).toBe(
      'contradicts',
    );
    expect(classifyCatalogItem('Alimento para GATOS', dog, [dog, cat])).toBe(
      'contradicts',
    );
    expect(
      planCatalogOptions('alimento para gato', [dog, cat])!.options.map(
        (o) => o.item.productId,
      ),
    ).toEqual([cat.productId]);
  });

  it('other terms of each group: puppy/junior/kitten/gatito vs adult/senior/7+, canino/dog vs felino/cat', () => {
    const senior = item(230, { name: 'Croquetas Senior 7+ Pollo' });
    const sevenPlus = item(231, { name: 'Croquetas Pollo 7+' });
    expect(classifyCatalogItem('croquetas puppy', senior, [senior])).toBe(
      'contradicts',
    );
    expect(classifyCatalogItem('croquetas junior', sevenPlus, [])).toBe(
      'contradicts',
    );
    expect(
      classifyCatalogItem(
        'croquetas adulto',
        item(232, { name: 'Croquetas Kitten Pollo' }),
        [],
      ),
    ).toBe('contradicts');
    expect(
      classifyCatalogItem(
        'croquetas senior',
        item(233, { name: 'Croquetas Gatitos' }),
        [],
      ),
    ).toBe('contradicts');
    expect(
      classifyCatalogItem(
        'arena felino',
        item(234, { name: 'Arena Canina Dog' }),
        [],
      ),
    ).toBe('contradicts');
    expect(
      classifyCatalogItem(
        'collar canino',
        item(235, { name: 'Collar para Cat' }),
        [],
      ),
    ).toBe('contradicts');
  });

  it('an item mentioning both terms of a group is NOT a contradiction', () => {
    const both = item(240, { name: 'Shampoo para perro y gato' });
    expect(classifyCatalogItem('shampoo gato', both, [both])).not.toBe(
      'contradicts',
    );
    const stages = item(241, {
      name: 'Croquetas Pollo',
      description: 'Para cachorros y adultos.',
    });
    expect(classifyCatalogItem('croquetas cachorro', stages, [])).not.toBe(
      'contradicts',
    );
  });

  it('no stage or species term in the query → no exclusion', () => {
    expect(classifyCatalogItem('croquetas', adultos, [adultos])).not.toBe(
      'contradicts',
    );
    expect(
      planCatalogOptions('croquetas', [adultos, nupec])!.options,
    ).toHaveLength(1);
    expect(
      planCatalogOptions('croquetas naturales', [adultos])!.options,
    ).toHaveLength(1);
  });
});
