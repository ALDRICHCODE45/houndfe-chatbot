import {
  MAX_CATALOG_OPTIONS,
  limitCatalogOptions,
} from './minimal-catalog-relevance';

type Flag = 'all' | 'partial';
const item = (id: number, match?: Flag) => ({
  productId: `p${id}`,
  ...(match === undefined ? {} : { match }),
});
const ids = (items: Array<{ productId: string }>) =>
  items.map((i) => i.productId);

describe('limitCatalogOptions (S10b, S10d)', () => {
  it('caps at 3 options in backend order and counts the hidden ones', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i));
    const out = limitCatalogOptions(items);
    expect(MAX_CATALOG_OPTIONS).toBe(3);
    expect(ids(out.offered)).toEqual(['p0', 'p1', 'p2']);
    expect(out.moreResults).toBe(7);
    expect(out.flagged).toBe(false);
  });

  it.each([0, 1, 2, 3])('leaves %i results unchanged', (n) => {
    const items = Array.from({ length: n }, (_, i) => item(i));
    const out = limitCatalogOptions(items);
    expect(ids(out.offered)).toEqual(ids(items));
    expect(out.moreResults).toBe(0);
  });

  it('orders partial matches after full matches and keeps them out of the 3 matches', () => {
    const items = [
      item(0, 'partial'),
      item(1, 'all'),
      item(2, 'partial'),
      item(3, 'all'),
      item(4, 'all'),
      item(5, 'all'),
      item(6, 'all'),
    ];
    const out = limitCatalogOptions(items);
    // 3 full matches + at most ONE partial, shown as the alternative.
    expect(ids(out.offered)).toEqual(['p1', 'p3', 'p4', 'p0']);
    expect(out.offered.filter((i) => i.match === 'partial')).toHaveLength(1);
    expect(out.moreResults).toBe(2);
    expect(out.flagged).toBe(true);
    expect(out.noFullMatch).toBe(false);
  });

  it('offers at most one partial alternative next to fewer than 3 full matches', () => {
    const out = limitCatalogOptions([
      item(0, 'partial'),
      item(1, 'all'),
      item(2, 'partial'),
    ]);
    expect(ids(out.offered)).toEqual(['p1', 'p0']);
    expect(out.moreResults).toBe(0);
  });

  it('treats unknown-flag (absent) items like full matches among flagged ones', () => {
    const out = limitCatalogOptions([item(0, 'partial'), item(1), item(2)]);
    expect(ids(out.offered)).toEqual(['p1', 'p2', 'p0']);
  });

  it('when every item is partial, offers the closest 3 as alternatives', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(i, 'partial'));
    const out = limitCatalogOptions(items);
    expect(ids(out.offered)).toEqual(['p0', 'p1', 'p2']);
    expect(out.noFullMatch).toBe(true);
    expect(out.moreResults).toBe(2);
  });

  it('without any flag the order is untouched and no flag is reported', () => {
    const out = limitCatalogOptions([item(2), item(1), item(0)]);
    expect(ids(out.offered)).toEqual(['p2', 'p1', 'p0']);
    expect(out.flagged).toBe(false);
    expect(out.noFullMatch).toBe(false);
  });
});
