import { Logger } from '@nestjs/common';
import type { BackorderFeedItem } from '../../chatbot-api/domain/dtos/human-requests.dto';
import type { DeliveryRow } from '../../human-requests/domain/human-request-feed';
import { parseInteractiveReplyId } from '../../llm-agent/domain/customer-reply';
import {
  BACKORDER_TEMPLATE_DEFAULTS,
  BackorderFeedNoticeService,
  type BackorderFeedNoticePorts,
} from './backorder-feed.handler';

/**
 * Restock backorder T5a (S4, S6, S9, S12, S13, S15): the real
 * `BackorderFeedHandler`. It plans one notice per `backorder.*` feed item;
 * the delivery service executes it (docs/minimal-backorder.md, "Notices").
 */

const ID = '0d3c0000-1111-4222-8333-444455556666';
const DECISION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const REF = 'wa:5215512349901';
const SENDER = '5215512349901';
const NOW = new Date('2026-11-20T16:00:00.000Z');
// 2026-11-21T15:00Z is 9:00 a. m. in Mexico City (UTC-6, no DST).
const RESERVED_UNTIL = '2026-11-21T15:00:00.000Z';
const NAME = 'Croquetas Adulto Raza Grande 18 kg';

const PAYLOAD = {
  backorderId: ID,
  folio: 'BO-000012',
  productName: NAME,
  variantName: null,
  quantity: 2,
  branchName: 'Centro',
  customerFirstName: 'Rosa',
  version: 3,
};

const item = (
  type: string,
  raw: Record<string, unknown> = {},
  patch: Partial<BackorderFeedItem> = {},
  common: Partial<BackorderFeedItem['payload']> = {},
): BackorderFeedItem => ({
  type: type as BackorderFeedItem['type'],
  cursor: '000000004311',
  deliveryId: 'd1',
  requestId: null,
  conversationRef: REF,
  notBefore: null,
  expiresAt: null,
  payload: { ...PAYLOAD, ...common, raw: { ...PAYLOAD, ...common, ...raw } },
  ...patch,
});

const reserved = (
  raw: Record<string, unknown> = {},
  patch: Partial<BackorderFeedItem> = {},
  common: Partial<BackorderFeedItem['payload']> = {},
) =>
  item(
    'backorder.reserved',
    {
      referencePriceCents: 114900,
      currentPriceCents: 109900,
      finalPriceCents: 109900,
      reservedUntil: RESERVED_UNTIL,
      reminderAt: '2026-11-21T12:00:00.000Z',
      ...raw,
    },
    patch,
    common,
  );
const reminder = (raw: Record<string, unknown> = {}) =>
  item('backorder.reservation_reminder', {
    reservedUntil: RESERVED_UNTIL,
    ...raw,
  });
const expired = (raw: Record<string, unknown> = {}) =>
  item('backorder.reservation_expired', {
    expiredAt: '2026-11-21T15:00:00.000Z',
    ...raw,
  });
const lost = (raw: Record<string, unknown> = {}) =>
  item('backorder.reservation_lost', {
    reason: 'LOT_EXPIRED',
    queuePosition: 1,
    estimatedAt: '2026-11-27T15:00:00.000Z',
    ...raw,
  });
const cancelled = (raw: Record<string, unknown> = {}) =>
  item('backorder.cancelled_by_staff', { reason: null, ...raw });

const CONFIRM_BUTTONS = [
  { id: `backorder_confirm:${ID}`, title: 'Confirmar pedido' },
  { id: `backorder_cancel:pick:${ID}`, title: 'Ya no lo quiero' },
];

describe('BackorderFeedNoticeService (restock backorder T5a)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const setup = (overrides: Partial<BackorderFeedNoticePorts> = {}) => {
    const ports: BackorderFeedNoticePorts = {
      isWindowOpen: jest.fn(() => Promise.resolve(true)),
      clock: () => NOW,
      ...overrides,
    };
    const service = new BackorderFeedNoticeService(ports);
    const plan = (feedItem: BackorderFeedItem) =>
      service.plan({ deliveryId: 'd1' } as DeliveryRow, feedItem);
    return { ports, service, plan };
  };

  describe('backorder.reserved (S6, S4)', () => {
    it('inside the window: the arrival summary with Confirm / No-longer buttons', async () => {
      const { plan, ports } = setup();
      await expect(plan(reserved())).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_RESERVED_NOTICE',
        senderId: SENDER,
        text:
          `¡Buenas noticias, Rosa! Ya llegó su pedido BO-000012: 2 × ${NAME}. ` +
          'Se lo apartamos a $1099.00 MXN c/u (bajó de precio, antes $1149.00 MXN) ' +
          'hasta el 21 de noviembre a las 9:00 a. m. ¿Lo confirmamos?',
        buttons: CONFIRM_BUTTONS,
        shortBody: '¿Lo confirmamos?',
        staffAlert: true,
      });
      expect(ports.isWindowOpen).toHaveBeenCalledWith(SENDER);
    });

    it('the same price (no drop) does not mention a lower price; a variant is named', async () => {
      const { plan } = setup();
      const planned = await plan(
        reserved(
          { finalPriceCents: 114900, currentPriceCents: 114900 },
          {},
          { variantName: '18 kg' },
        ),
      );
      expect(planned).toMatchObject({
        action: 'send',
        text:
          `¡Buenas noticias, Rosa! Ya llegó su pedido BO-000012: 2 × ${NAME} (18 kg). ` +
          'Se lo apartamos a $1149.00 MXN c/u hasta el 21 de noviembre a las 9:00 a. m. ¿Lo confirmamos?',
      });
      expect((planned as { text: string }).text).not.toMatch(/bajó/);
    });

    it('without a first name the greeting has no name', async () => {
      const { plan } = setup();
      await expect(
        plan(reserved({}, {}, { customerFirstName: null })),
      ).resolves.toMatchObject({
        text: expect.stringMatching(
          /^¡Buenas noticias! Ya llegó su pedido /,
        ) as unknown,
      });
    });

    it('tú customers get the tú copy; names and products are never restyled', async () => {
      const { plan } = setup({
        customerStyle: () =>
          Promise.resolve({ register: 'tu', tone: 'casual', emojis: false }),
      });
      const planned = await plan(
        reserved({}, {}, { productName: 'Su pedido Premium' }),
      );
      expect(planned).toMatchObject({
        action: 'send',
        text:
          '¡Buenas noticias, Rosa! Ya llegó tu pedido BO-000012: 2 × Su pedido Premium. ' +
          'Te lo apartamos a $1099.00 MXN c/u (bajó de precio, antes $1149.00 MXN) ' +
          'hasta el 21 de noviembre a las 9:00 a. m. ¿Lo confirmamos?',
        buttons: CONFIRM_BUTTONS,
      });
    });

    it('the Confirm and Ya-no ids are the ones the customer reply parser knows', () => {
      expect(parseInteractiveReplyId(CONFIRM_BUTTONS[1].id)).toEqual({
        kind: 'backorder_cancel',
        action: 'pick',
        reference: ID,
      });
    });

    it('a deadline that already passed is not announced (STALE)', async () => {
      const { plan } = setup({ clock: () => new Date('2026-11-21T16:00:00Z') });
      await expect(plan(reserved())).resolves.toEqual({
        action: 'stale',
        decision: 'BACKORDER_OVERTAKEN',
      });
    });

    it.each([
      ['no folio', {}, { folio: null }],
      ['no quantity', {}, { quantity: null }],
      ['no product', {}, { productName: null }],
      ['no final price', { finalPriceCents: undefined }, {}],
      ['a bad deadline', { reservedUntil: 'tomorrow' }, {}],
    ])(
      'an unreadable payload (%s) is rejected so staff calls the customer',
      async (_name, raw, common) => {
        const { plan } = setup();
        await expect(plan(reserved(raw, {}, common as never))).resolves.toEqual(
          {
            action: 'rejected',
            decision: 'BACKORDER_PAYLOAD_INVALID',
            reason: 'PAYLOAD_INVALID',
          },
        );
      },
    );
  });

  describe('backorder.reservation_reminder (S4)', () => {
    it('inside the window: the reminder with the same buttons', async () => {
      const { plan } = setup();
      await expect(plan(reminder())).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_REMINDER_NOTICE',
        senderId: SENDER,
        text: 'Le recuerdo que su pedido BO-000012 sigue apartado hasta el 21 de noviembre a las 9:00 a. m. ¿Lo confirmamos?',
        buttons: CONFIRM_BUTTONS,
        shortBody: '¿Lo confirmamos?',
        staffAlert: true,
      });
    });

    it('tú copy', async () => {
      const { plan } = setup({
        customerStyle: () =>
          Promise.resolve({ register: 'tu', tone: 'casual', emojis: false }),
      });
      await expect(plan(reminder())).resolves.toMatchObject({
        text: 'Te recuerdo que tu pedido BO-000012 sigue apartado hasta el 21 de noviembre a las 9:00 a. m. ¿Lo confirmamos?',
      });
    });
  });

  describe('backorder.reservation_expired (S4)', () => {
    it('without sourceDecisionId: the notice only, no buttons, no reschedule offer', async () => {
      const { plan } = setup();
      await expect(plan(expired())).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_EXPIRED_NOTICE',
        senderId: SENDER,
        text: `Se venció el apartado de su pedido BO-000012 (${NAME}).`,
      });
    });

    it('with sourceDecisionId: asks to reschedule with [Sí, agéndalo] [No, gracias]', async () => {
      const { plan } = setup();
      await expect(
        plan(expired({ sourceDecisionId: DECISION })),
      ).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_EXPIRED_NOTICE',
        senderId: SENDER,
        text: `Se venció el apartado de su pedido BO-000012 (${NAME}). ¿Quiere que se lo vuelva a agendar?`,
        buttons: [
          { id: `backorder_reschedule:${ID}`, title: 'Sí, agéndalo' },
          { id: `backorder_reschedule_decline:${ID}`, title: 'No, gracias' },
        ],
        shortBody: '¿Quiere que se lo vuelva a agendar?',
      });
    });

    it('an empty or non-text sourceDecisionId counts as absent', async () => {
      const { plan } = setup();
      for (const sourceDecisionId of ['', '  ', null, 7])
        await expect(
          plan(expired({ sourceDecisionId })),
        ).resolves.not.toHaveProperty('buttons');
    });

    it('tú copy of the offer', async () => {
      const { plan } = setup({
        customerStyle: () =>
          Promise.resolve({ register: 'tu', tone: 'casual', emojis: false }),
      });
      await expect(
        plan(expired({ sourceDecisionId: DECISION })),
      ).resolves.toMatchObject({
        text: `Se venció el apartado de tu pedido BO-000012 (${NAME}). ¿Quieres que te lo vuelva a agendar?`,
      });
    });
  });

  describe('backorder.reservation_lost (S12)', () => {
    it('apologises and promises the notice, with the estimate date', async () => {
      const { plan } = setup();
      await expect(plan(lost())).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_LOST_NOTICE',
        senderId: SENDER,
        text:
          `Una disculpa, Rosa: el lote que le apartamos de ${NAME} caducó y no tenemos otro vigente. ` +
          'Su pedido BO-000012 sigue en primer lugar; le aviso en cuanto llegue (aprox. 27 de noviembre).',
      });
    });

    it('no estimate or one already past: no date is promised', async () => {
      const { plan } = setup();
      for (const estimatedAt of [undefined, null, '2026-11-01T00:00:00.000Z'])
        await expect(plan(lost({ estimatedAt }))).resolves.toMatchObject({
          text: expect.stringMatching(
            /sigue en primer lugar; le aviso en cuanto llegue\.$/,
          ) as unknown,
        });
    });

    it('tú copy', async () => {
      const { plan } = setup({
        customerStyle: () =>
          Promise.resolve({ register: 'tu', tone: 'casual', emojis: false }),
      });
      await expect(plan(lost())).resolves.toMatchObject({
        text:
          `Una disculpa, Rosa: el lote que te apartamos de ${NAME} caducó y no tenemos otro vigente. ` +
          'Tu pedido BO-000012 sigue en primer lugar; te aviso en cuanto llegue (aprox. 27 de noviembre).',
      });
    });
  });

  describe('backorder.cancelled_by_staff', () => {
    it('names the folio and the reason', async () => {
      const { plan } = setup();
      await expect(
        plan(cancelled({ reason: 'Producto descontinuado' })),
      ).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_CANCELLED_NOTICE',
        senderId: SENDER,
        text: 'El equipo canceló su pedido BO-000012: Producto descontinuado.',
      });
    });

    it('no reason: the plain notice; the reason is never restyled or double-dotted', async () => {
      const { plan } = setup({
        customerStyle: () =>
          Promise.resolve({ register: 'tu', tone: 'casual', emojis: false }),
      });
      await expect(plan(cancelled({ reason: '  ' }))).resolves.toMatchObject({
        text: 'El equipo canceló tu pedido BO-000012.',
      });
      await expect(
        plan(cancelled({ reason: 'Se lo avisamos a su correo.' })),
      ).resolves.toMatchObject({
        text: 'El equipo canceló tu pedido BO-000012: Se lo avisamos a su correo.',
      });
    });
  });

  describe('eta_* (backend T4, handled by T6 S7)', () => {
    it.each(['backorder.eta_updated', 'backorder.eta_unavailable'])(
      '%s stays STALE with an explicit decision and no lookups',
      async (type) => {
        const { plan, ports } = setup();
        await expect(plan(item(type, { restockDays: 5 }))).resolves.toEqual({
          action: 'stale',
          decision: 'BACKORDER_ETA_PENDING',
        });
        expect(ports.isWindowOpen).not.toHaveBeenCalled();
      },
    );

    it('an unknown future backorder type is STALE UNKNOWN_TYPE', async () => {
      const { plan } = setup();
      await expect(plan(item('backorder.future'))).resolves.toEqual({
        action: 'stale',
        decision: 'UNKNOWN_TYPE',
      });
    });
  });

  describe('customer conversation (conversationRef null)', () => {
    it('is resolved by the resolver when it names one', async () => {
      const resolveConversation = jest.fn(() => Promise.resolve(REF));
      const { plan } = setup({ resolveConversation });
      await expect(
        plan(reserved({}, { conversationRef: null })),
      ).resolves.toMatchObject({ action: 'send', senderId: SENDER });
      expect(resolveConversation).toHaveBeenCalledWith(ID);
    });

    it('unresolved: never messages anyone; reserved / reminder alert staff, the rest are STALE', async () => {
      const { plan, ports } = setup();
      await expect(
        plan(reserved({}, { conversationRef: null })),
      ).resolves.toEqual({
        action: 'rejected',
        decision: 'NO_CONVERSATION',
        reason: 'NO_CONVERSATION',
      });
      await expect(
        plan({ ...reminder(), conversationRef: null }),
      ).resolves.toMatchObject({ action: 'rejected' });
      for (const feedItem of [expired(), lost(), cancelled()])
        await expect(
          plan({ ...feedItem, conversationRef: null }),
        ).resolves.toEqual({ action: 'stale', decision: 'NO_CONVERSATION' });
      expect(ports.isWindowOpen).not.toHaveBeenCalled();
    });

    it('a resolver answering null or a malformed ref is unresolved', async () => {
      for (const answer of [null, 'not-a-ref'])
        await expect(
          setup({
            resolveConversation: () => Promise.resolve(answer),
          }).plan(reserved({}, { conversationRef: null })),
        ).resolves.toMatchObject({ action: 'rejected' });
    });

    it('a malformed conversationRef on the item is unresolved too', async () => {
      const { plan } = setup();
      await expect(
        plan(reserved({}, { conversationRef: 'garbage' })),
      ).resolves.toMatchObject({ action: 'rejected' });
    });

    it('a failing resolver is transient: the plan throws so the page is read again', async () => {
      const { plan } = setup({
        resolveConversation: () => Promise.reject(new Error('backend down')),
      });
      await expect(
        plan(reserved({}, { conversationRef: null })),
      ).rejects.toThrow('backend down');
    });

    it('the logs never carry the phone', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const { plan } = setup();
      await plan(reserved({}, { conversationRef: null }));
      const lines = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
      expect(lines).not.toContain('5215512349901');
    });
  });

  describe('outside the 24 h window (S9)', () => {
    const closed = { isWindowOpen: () => Promise.resolve(false) };

    it('templates off: reserved / reminder are rejected TEMPLATE_NOT_APPROVED (staff calls)', async () => {
      const { plan } = setup(closed);
      for (const feedItem of [reserved(), reminder()])
        await expect(plan(feedItem)).resolves.toEqual({
          action: 'rejected',
          decision: 'TEMPLATE_NOT_APPROVED',
          reason: 'TEMPLATE_NOT_APPROVED',
        });
    });

    it('templates off: expired, lost and cancelled are STALE WINDOW_CLOSED', async () => {
      const { plan } = setup(closed);
      for (const feedItem of [expired(), lost(), cancelled()])
        await expect(plan(feedItem)).resolves.toEqual({
          action: 'stale',
          decision: 'WINDOW_CLOSED',
        });
    });

    it('the flag must be exactly true', async () => {
      for (const templatesEnabled of [undefined, false, 'true' as never]) {
        const { plan } = setup({ ...closed, templatesEnabled });
        await expect(plan(reserved())).resolves.toMatchObject({
          action: 'rejected',
        });
      }
    });

    describe('templates on', () => {
      const on = { ...closed, templatesEnabled: true };

      it('reserved goes out as pedido_reposicion_llego', async () => {
        const { plan } = setup(on);
        const planned = await plan(reserved());
        expect(planned).toMatchObject({
          action: 'send',
          decision: 'BACKORDER_RESERVED_NOTICE',
          senderId: SENDER,
          staffAlert: true,
          template: {
            templateName: 'pedido_reposicion_llego',
            languageCode: 'es_MX',
            refusedDecision: 'TEMPLATE_NOT_APPROVED',
            bodyParameters: [
              'Rosa',
              'BO-000012',
              `2 × ${NAME}`,
              '$1099.00 MXN (bajó de precio)',
              'el 21 de noviembre a las 9:00 a. m.',
            ],
          },
        });
        expect(planned).not.toHaveProperty('buttons');
      });

      it('reserved at an unchanged price states the price only; no first name → «cliente»', async () => {
        const { plan } = setup(on);
        await expect(
          plan(
            reserved(
              { finalPriceCents: 114900 },
              {},
              { customerFirstName: null },
            ),
          ),
        ).resolves.toMatchObject({
          template: {
            bodyParameters: expect.arrayContaining([
              'cliente',
              '$1149.00 MXN',
            ]) as unknown,
          },
        });
      });

      it('reminder → pedido_reposicion_recordatorio', async () => {
        const { plan } = setup(on);
        await expect(plan(reminder())).resolves.toMatchObject({
          decision: 'BACKORDER_REMINDER_NOTICE',
          staffAlert: true,
          template: {
            templateName: 'pedido_reposicion_recordatorio',
            bodyParameters: [
              'BO-000012',
              'el 21 de noviembre a las 9:00 a. m.',
            ],
          },
        });
      });

      it('expired → pedido_reposicion_vencido (also when a reschedule is possible: templates carry no buttons)', async () => {
        const { plan } = setup(on);
        for (const raw of [{}, { sourceDecisionId: DECISION }]) {
          const planned = await plan(expired(raw));
          expect(planned).toMatchObject({
            decision: 'BACKORDER_EXPIRED_NOTICE',
            template: {
              templateName: 'pedido_reposicion_vencido',
              bodyParameters: ['BO-000012', NAME],
              refusedDecision: 'TEMPLATE_NOT_APPROVED',
            },
          });
          expect(planned).not.toHaveProperty('staffAlert');
          expect(planned).not.toHaveProperty('buttons');
        }
      });

      it('lost → pedido_reposicion_lote, with a date or the «fecha por confirmar» fallback', async () => {
        const { plan } = setup(on);
        await expect(plan(lost())).resolves.toMatchObject({
          decision: 'BACKORDER_LOST_NOTICE',
          template: {
            templateName: 'pedido_reposicion_lote',
            bodyParameters: [
              'Rosa',
              NAME,
              'BO-000012',
              'aprox. 27 de noviembre',
            ],
          },
        });
        await expect(plan(lost({ estimatedAt: null }))).resolves.toMatchObject({
          template: {
            bodyParameters: expect.arrayContaining([
              'fecha por confirmar',
            ]) as unknown,
          },
        });
      });

      it('cancelled_by_staff has no template: STALE WINDOW_CLOSED', async () => {
        const { plan } = setup(on);
        await expect(plan(cancelled())).resolves.toEqual({
          action: 'stale',
          decision: 'WINDOW_CLOSED',
        });
      });

      it('names are configurable; values are one-line and trimmed', async () => {
        const { plan } = setup({
          ...on,
          templateNames: { reserved: 'mi_llego', lost: 'mi_lote' },
        });
        await expect(
          plan(reserved({}, {}, { productName: ' Croquetas\n  18 kg ' })),
        ).resolves.toMatchObject({
          template: {
            templateName: 'mi_llego',
            bodyParameters: expect.arrayContaining([
              '2 × Croquetas 18 kg',
            ]) as unknown,
          },
        });
        await expect(plan(lost())).resolves.toMatchObject({
          template: { templateName: 'mi_lote' },
        });
        await expect(plan(reminder())).resolves.toMatchObject({
          template: { templateName: BACKORDER_TEMPLATE_DEFAULTS.reminder },
        });
      });
    });
  });

  it('a window read that fails is transient: the plan throws (never "closed")', async () => {
    const { plan } = setup({
      isWindowOpen: () => Promise.reject(new Error('db down')),
    });
    await expect(plan(reserved())).rejects.toThrow('db down');
  });

  it('a style read that fails keeps the usted copy', async () => {
    const { plan } = setup({
      customerStyle: () => Promise.reject(new Error('profile down')),
    });
    await expect(plan(reminder())).resolves.toMatchObject({
      text: expect.stringMatching(/^Le recuerdo que su pedido/) as unknown,
    });
  });
});
