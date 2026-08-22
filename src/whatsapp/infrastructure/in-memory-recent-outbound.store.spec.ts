import { InMemoryRecentOutboundStore } from './in-memory-recent-outbound.store';

describe('InMemoryRecentOutboundStore (echo filter)', () => {
  let store: InMemoryRecentOutboundStore;

  beforeEach(() => {
    jest.useFakeTimers();
    store = new InMemoryRecentOutboundStore(60_000, 3);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('remembers a sent message id', () => {
    store.remember('wamid.sent');
    expect(store.isKnown('wamid.sent')).toBe(true);
  });

  it('reports unknown ids as NOT echoes', () => {
    expect(store.isKnown('wamid.unknown')).toBe(false);
  });

  it('expires entries after the TTL', () => {
    store.remember('wamid.old');
    jest.advanceTimersByTime(61_000);
    expect(store.isKnown('wamid.old')).toBe(false);
  });

  it('keeps entries within the TTL window', () => {
    store.remember('wamid.fresh');
    jest.advanceTimersByTime(59_000);
    expect(store.isKnown('wamid.fresh')).toBe(true);
  });

  it('evicts the oldest entry when the cap is exceeded', () => {
    store.remember('wamid.1');
    jest.advanceTimersByTime(1_000);
    store.remember('wamid.2');
    jest.advanceTimersByTime(1_000);
    store.remember('wamid.3');
    jest.advanceTimersByTime(1_000);
    store.remember('wamid.4'); // cap=3 → evicts wamid.1

    expect(store.isKnown('wamid.1')).toBe(false);
    expect(store.isKnown('wamid.2')).toBe(true);
    expect(store.isKnown('wamid.3')).toBe(true);
    expect(store.isKnown('wamid.4')).toBe(true);
  });
});
