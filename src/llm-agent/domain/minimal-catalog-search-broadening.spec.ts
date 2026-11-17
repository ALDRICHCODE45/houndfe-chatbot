import {
  MAX_BROADEN_CALLS,
  broadenedQueries,
  searchWithBroadening,
} from './minimal-catalog-search-broadening';

const item = (productId: string) => ({ productId });

describe('broadenedQueries', () => {
  it('drops generic words and keeps the brand word of "croquetas pedigree"', () => {
    expect(broadenedQueries('croquetas pedigree')).toEqual(['pedigree']);
  });

  it('keeps species words as significant ("alimento para gato")', () => {
    expect(broadenedQueries('alimento para gato')).toEqual(['gato']);
    expect(broadenedQueries('comida para perro')).toEqual(['perro']);
  });

  it('is accent/case insensitive for generic words and ignores filler requests', () => {
    expect(broadenedQueries('¿Tienen ALIMENTO para Perro?')).toEqual(['perro']);
    expect(broadenedQueries('quiero comida')).toEqual([]);
  });

  it('tries all significant words together first, then longest word first, at most 3', () => {
    expect(broadenedQueries('croquetas pedigree adulto raza grande')).toEqual([
      'pedigree adulto raza grande',
      'pedigree',
      'adulto',
    ]);
    expect(
      broadenedQueries('croquetas pedigree adulto raza grande'),
    ).toHaveLength(MAX_BROADEN_CALLS);
  });

  it('ignores pure numbers and unit tokens and dedupes repeated words', () => {
    expect(broadenedQueries('ibuprofeno de 400 mg')).toEqual(['ibuprofeno']);
    expect(broadenedQueries('pedigree pedigree croquetas')).toEqual([
      'pedigree',
    ]);
  });

  it('never proposes the original query again and skips single-word queries', () => {
    expect(broadenedQueries('pedigree')).toEqual([]);
    expect(broadenedQueries('croquetas')).toEqual([]);
    expect(broadenedQueries('pedigree adulto')).toEqual(['pedigree', 'adulto']);
  });
});

describe('searchWithBroadening', () => {
  it('does not retry when the first search returns results', async () => {
    const search = jest.fn().mockResolvedValue([item('a')]);
    const out = await searchWithBroadening(search, 'croquetas pedigree');
    expect(search).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ items: [item('a')], broadened: null });
  });

  it('does not retry a single-word query with 0 results', async () => {
    const search = jest.fn().mockResolvedValue([]);
    const out = await searchWithBroadening(search, 'pedigree');
    expect(search).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ items: [], broadened: null });
  });

  it('retries with the significant word and reports the broadened words', async () => {
    const search = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item('a'), item('b')]);
    const out = await searchWithBroadening(search, 'croquetas pedigree');
    expect(search.mock.calls.map((c: [string]) => c[0])).toEqual([
      'croquetas pedigree',
      'pedigree',
    ]);
    expect(out).toEqual({
      items: [item('a'), item('b')],
      broadened: {
        originalQuery: 'croquetas pedigree',
        attempted: ['pedigree'],
        matchedQuery: 'pedigree',
      },
    });
  });

  it('stops at the first retry with results and stays within 3 extra calls', async () => {
    const empty = jest.fn().mockResolvedValue([]);
    const none = await searchWithBroadening(
      empty,
      'croquetas pedigree adulto raza grande',
    );
    expect(empty).toHaveBeenCalledTimes(1 + MAX_BROADEN_CALLS);
    expect(none.items).toEqual([]);
    expect(none.broadened).toEqual({
      originalQuery: 'croquetas pedigree adulto raza grande',
      attempted: ['pedigree adulto raza grande', 'pedigree', 'adulto'],
      matchedQuery: null,
    });

    const second = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item('a')]);
    const out = await searchWithBroadening(
      second,
      'croquetas pedigree adulto raza grande',
    );
    expect(second).toHaveBeenCalledTimes(3);
    expect(out.broadened?.matchedQuery).toBe('pedigree');
  });

  it('propagates a retry error like the original error', async () => {
    const search = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('boom'));
    await expect(
      searchWithBroadening(search, 'croquetas pedigree'),
    ).rejects.toThrow('boom');
  });

  it('dedupes by productId keeping first-seen order when merging', async () => {
    const search = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([item('a'), item('a'), item('b')]);
    const out = await searchWithBroadening(search, 'croquetas pedigree');
    expect(out.items).toEqual([item('a'), item('b')]);
  });
});
