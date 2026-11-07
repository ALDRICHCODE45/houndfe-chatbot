import type { CustomerProfileStore } from '../domain/customer-profile';
import { InMemoryCustomerProfileStore } from '../infrastructure/in-memory-customer-profile.store';
import { CustomerProfileService } from './customer-profile.service';

const SENDER = '5215550001111';
const NOW = new Date('2026-11-07T12:00:00.000Z');
const clock = () => NOW;

const failing = (): CustomerProfileStore => ({
  read: () => Promise.reject(new Error('db down')),
  upsert: () => Promise.reject(new Error('db down')),
  delete: () => Promise.reject(new Error('db down')),
});

describe('CustomerProfileService', () => {
  it('loads once into the cache and exposes it synchronously', async () => {
    const store = new InMemoryCustomerProfileStore();
    await store.upsert(SENDER, { register: 'tu' }, NOW);
    const read = jest.spyOn(store, 'read');
    const service = new CustomerProfileService(store, clock);
    expect(service.isLoaded(SENDER)).toBe(false);
    expect(service.cached(SENDER)).toBeNull();
    await service.load(SENDER);
    expect(service.isLoaded(SENDER)).toBe(true);
    expect(service.cached(SENDER)).toMatchObject({ register: 'tu' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('records merge-only and skips writes that change nothing', async () => {
    const store = new InMemoryCustomerProfileStore();
    const upsert = jest.spyOn(store, 'upsert');
    const service = new CustomerProfileService(store, clock);
    await service.load(SENDER);
    await service.record(SENDER, { displayName: 'Ana', register: 'tu' });
    await service.record(SENDER, { displayName: 'Ana', register: 'tu' });
    await service.record(SENDER, { pet: { name: 'Luna' } });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(service.cached(SENDER)).toMatchObject({
      displayName: 'Ana',
      register: 'tu',
      pet: { name: 'Luna' },
    });
  });

  it('never throws when the store fails', async () => {
    const service = new CustomerProfileService(failing(), clock);
    await expect(service.load(SENDER)).resolves.toBeNull();
    expect(service.isLoaded(SENDER)).toBe(false);
    await expect(
      service.record(SENDER, { displayName: 'Ana' }),
    ).resolves.toBeUndefined();
    await expect(service.styleFor(SENDER)).resolves.toBeNull();
    await expect(service.forget(SENDER)).resolves.toBe(false);
  });

  it('styleFor reads the stored style, null when there is no profile', async () => {
    const store = new InMemoryCustomerProfileStore();
    const service = new CustomerProfileService(store, clock);
    await expect(service.styleFor(SENDER)).resolves.toBeNull();
    await store.upsert(SENDER, { register: 'tu', emojis: true }, NOW);
    await expect(service.styleFor(SENDER)).resolves.toEqual({
      register: 'tu',
      emojis: true,
      tone: 'neutral',
    });
  });

  it('forget deletes the profile and stops later writes in this process', async () => {
    const store = new InMemoryCustomerProfileStore();
    const service = new CustomerProfileService(store, clock);
    await service.record(SENDER, { displayName: 'Ana' });
    await expect(service.forget(SENDER)).resolves.toBe(true);
    await expect(store.read(SENDER)).resolves.toBeNull();
    expect(service.cached(SENDER)).toBeNull();
    await service.record(SENDER, { register: 'tu' });
    await service.recordOrder(
      SENDER,
      { folio: 'A-1', confirmedAt: NOW.toISOString(), totalCents: 100 },
      'Ana',
    );
    await expect(store.read(SENDER)).resolves.toBeNull();
    await expect(service.styleFor(SENDER)).resolves.toBeNull();
  });

  it('recordOrder sets the last order and the checkout name only when no name is known', async () => {
    const store = new InMemoryCustomerProfileStore();
    const service = new CustomerProfileService(store, clock);
    const order = {
      folio: 'A-12',
      confirmedAt: '2026-11-07T11:00:00.000Z',
      totalCents: 89900,
    };
    await service.recordOrder(SENDER, order, 'Mariana');
    await expect(store.read(SENDER)).resolves.toMatchObject({
      preferredName: 'Mariana',
      lastOrder: order,
    });
    await service.record(SENDER, { preferredName: 'Mari' });
    await service.recordOrder(SENDER, { ...order, folio: 'A-13' }, 'Mariana');
    await expect(store.read(SENDER)).resolves.toMatchObject({
      preferredName: 'Mari',
      lastOrder: { folio: 'A-13' },
    });
  });
});
