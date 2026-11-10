import {
  HANDOFF_HOLD_RETRY_MS,
  checkHandoffSendHold,
} from './handoff-send-hold';

/** S7: proactive senders hold a customer send while the epoch is HUMAN. */
describe('checkHandoffSendHold (S7)', () => {
  it('BOT mode: the send goes ahead', async () => {
    await expect(
      checkHandoffSendHold(
        { isHumanMode: () => Promise.resolve(false) },
        '5215550001111',
      ),
    ).resolves.toEqual({ hold: false });
  });

  it('HUMAN mode: the send is held', async () => {
    await expect(
      checkHandoffSendHold(
        { isHumanMode: () => Promise.resolve(true) },
        '5215550001111',
      ),
    ).resolves.toEqual({ hold: true, reason: 'HUMAN' });
  });

  it('fails closed: an unreadable mode holds the send', async () => {
    await expect(
      checkHandoffSendHold(
        { isHumanMode: () => Promise.reject(new Error('db down')) },
        '5215550001111',
      ),
    ).resolves.toEqual({
      hold: true,
      reason: 'MODE_UNREADABLE',
      error: 'db down',
    });
  });

  it('without a wired reader (hand-built harnesses) the send goes ahead', async () => {
    await expect(
      checkHandoffSendHold(undefined, '5215550001111'),
    ).resolves.toEqual({ hold: false });
  });

  it('retries a held send after a minute', () => {
    expect(HANDOFF_HOLD_RETRY_MS).toBe(60_000);
  });
});
