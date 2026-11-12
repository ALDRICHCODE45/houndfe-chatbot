import { Logger } from '@nestjs/common';
import { MirrorDeliveryGate } from './mirror-delivery-gate';

describe('MirrorDeliveryGate', () => {
  let now = 1_000_000;
  const gate = () =>
    new MirrorDeliveryGate({ clock: () => now, random: () => 0 });
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('alerts once per key per window at error level, later occurrences are debug', () => {
    const g = gate();
    g.alert('stop', 'credential rejected');
    g.alert('stop', 'credential rejected');
    g.alert('other', 'something else');
    expect(Logger.prototype.error).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.debug).toHaveBeenCalledTimes(1);
    now += 15 * 60_000 + 1;
    g.alert('stop', 'credential rejected');
    expect(Logger.prototype.error).toHaveBeenCalledTimes(3);
  });

  it('blocks conversation writes for the stop backoff and reports the remainder', () => {
    const g = gate();
    expect(g.blockedForMs()).toBe(0);
    expect(g.blockConversationWrites()).toBe(15 * 60_000);
    now += 60_000;
    expect(g.blockedForMs()).toBe(14 * 60_000);
    now += 14 * 60_000;
    expect(g.blockedForMs()).toBe(0);
  });

  it('adds up to 60 s of jitter to the stop backoff so conversations do not wake together', () => {
    const g = new MirrorDeliveryGate({ clock: () => now, random: () => 1 });
    expect(g.stopDelayMs()).toBe(15 * 60_000 + 60_000);
  });
});
