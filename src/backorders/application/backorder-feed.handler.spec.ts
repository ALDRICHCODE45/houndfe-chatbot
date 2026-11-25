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
          '¡Buenas noticias, Rosa! Ya llegó su pedido *BO-000012*.\n\n' +
          `• ${NAME}\n` +
          '   2 × $1,099.00 = *$2,198.00*\n' +
          '   _Bajó de precio, antes $1,149.00_\n\n' +
          'Se lo apartamos hasta *el 21 de noviembre a las 9:00 a. m.*\n\n' +
          '¿Lo confirmamos?',
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
          '¡Buenas noticias, Rosa! Ya llegó su pedido *BO-000012*.\n\n' +
          `• ${NAME} (18 kg)\n` +
          '   2 × $1,149.00 = *$2,298.00*\n\n' +
          'Se lo apartamos hasta *el 21 de noviembre a las 9:00 a. m.*\n\n' +
          '¿Lo confirmamos?',
      });
      expect((planned as { text: string }).text).not.toMatch(/bajó/i);
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
          '¡Buenas noticias, Rosa! Ya llegó tu pedido *BO-000012*.\n\n' +
          '• Su pedido Premium\n' +
          '   2 × $1,099.00 = *$2,198.00*\n' +
          '   _Bajó de precio, antes $1,149.00_\n\n' +
          'Te lo apartamos hasta *el 21 de noviembre a las 9:00 a. m.*\n\n' +
          '¿Lo confirmamos?',
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
        text: 'Le recuerdo que su pedido *BO-000012* sigue apartado hasta *el 21 de noviembre a las 9:00 a. m.*\n\n¿Lo confirmamos?',
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
        text: 'Te recuerdo que tu pedido *BO-000012* sigue apartado hasta *el 21 de noviembre a las 9:00 a. m.*\n\n¿Lo confirmamos?',
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
        text: `Se venció el apartado de su pedido *BO-000012* (${NAME}).`,
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
        text: `Se venció el apartado de su pedido *BO-000012* (${NAME}).\n\n¿Quiere que se lo vuelva a agendar?`,
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
        text: `Se venció el apartado de tu pedido *BO-000012* (${NAME}).\n\n¿Quieres que te lo vuelva a agendar?`,
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
          `Una disculpa, Rosa: el lote que le apartamos de ${NAME} caducó y no tenemos otro vigente.\n\n` +
          'Su pedido *BO-000012* sigue en primer lugar; le aviso en cuanto llegue (aprox. 27 de noviembre).',
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
          `Una disculpa, Rosa: el lote que te apartamos de ${NAME} caducó y no tenemos otro vigente.\n\n` +
          'Tu pedido *BO-000012* sigue en primer lugar; te aviso en cuanto llegue (aprox. 27 de noviembre).',
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
        text: 'El equipo canceló su pedido *BO-000012*: Producto descontinuado.',
      });
    });

    it('no reason: the plain notice; the reason is never restyled or double-dotted', async () => {
      const { plan } = setup({
        customerStyle: () =>
          Promise.resolve({ register: 'tu', tone: 'casual', emojis: false }),
      });
      await expect(plan(cancelled({ reason: '  ' }))).resolves.toMatchObject({
        text: 'El equipo canceló tu pedido *BO-000012*.',
      });
      await expect(
        plan(cancelled({ reason: 'Se lo avisamos a su correo.' })),
      ).resolves.toMatchObject({
        text: 'El equipo canceló tu pedido *BO-000012*: Se lo avisamos a su correo.',
      });
    });
  });

  describe('eta_updated / eta_unavailable (backend T4, S7)', () => {
    const etaUpdated = (raw: Record<string, unknown> = {}) =>
      item('backorder.eta_updated', {
        estimatedAt: '2026-11-27T15:00:00.000Z',
        restockDays: 7,
        ...raw,
      });
    const etaUnavailable = (raw: Record<string, unknown> = {}) =>
      item('backorder.eta_unavailable', raw);
    const WAIT_BUTTONS = [
      { id: `backorder_wait:${ID}`, title: 'Seguir esperando' },
      { id: `backorder_cancel:pick:${ID}`, title: 'Ya no lo quiero' },
    ];

    it('eta_updated inside the window: the new date, still selling, with [Seguir esperando] [Ya no lo quiero]', async () => {
      const { plan, ports } = setup();
      await expect(plan(etaUpdated())).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_ETA_PENDING',
        senderId: SENDER,
        text:
          'Rosa, le actualizo su pedido *BO-000012*:\n' +
          `• 2 × ${NAME}\n` +
          'El equipo nos confirmó que llega aprox. el *27 de noviembre*.\n\n' +
          'Se lo aparto en cuanto llegue y le aviso; sigue sin pagar nada hasta entonces. ' +
          'Con gusto se lo tengo listo.\n\n¿Seguimos con su pedido?',
        buttons: WAIT_BUTTONS,
        shortBody: '¿Seguimos con su pedido?',
      });
      expect(ports.isWindowOpen).toHaveBeenCalledWith(SENDER);
    });

    it('is not a staff alert type (no staffAlert flag) and names the variant', async () => {
      const { plan } = setup();
      const planned = await plan(
        item(
          'backorder.eta_updated',
          { estimatedAt: '2026-11-27T15:00:00.000Z' },
          {},
          { variantName: '18 kg' },
        ),
      );
      expect(planned).not.toHaveProperty('staffAlert');
      expect(planned).toMatchObject({
        text: expect.stringContaining(`2 × ${NAME} (18 kg)`) as unknown,
      });
    });

    it('the date is the Mexico City one (UTC late evening stays the day before)', async () => {
      const { plan } = setup();
      await expect(
        plan(etaUpdated({ estimatedAt: '2026-11-28T03:00:00.000Z' })),
      ).resolves.toMatchObject({
        text: expect.stringContaining('aprox. el *27 de noviembre*') as unknown,
      });
    });

    it.each([
      ['already past', '2026-11-19T15:00:00.000Z'],
      ['unreadable', 'mañana'],
      ['missing', null],
    ])(
      'eta_updated with an estimate %s: no date is invented, the team is confirming it',
      async (_label, estimatedAt) => {
        const { plan } = setup();
        const planned = await plan(etaUpdated({ estimatedAt }));
        expect(planned).toMatchObject({
          action: 'send',
          decision: 'BACKORDER_ETA_PENDING',
          text:
            'Rosa, le actualizo su pedido *BO-000012*:\n' +
            `• 2 × ${NAME}\n` +
            'El equipo está confirmando la nueva fecha de llegada.\n\n' +
            'Se lo aparto en cuanto llegue y le aviso; sigue sin pagar nada hasta entonces. ' +
            'Con gusto se lo tengo listo.\n\n¿Seguimos con su pedido?',
          buttons: WAIT_BUTTONS,
        });
        expect((planned as { text: string }).text).not.toMatch(/aprox\. el/);
      },
    );

    it('without a first name the greeting has no name', async () => {
      const { plan } = setup();
      await expect(
        plan(
          item('backorder.eta_updated', {}, {}, { customerFirstName: null }),
        ),
      ).resolves.toMatchObject({
        text: expect.stringMatching(
          /^Le actualizo su pedido \*BO-000012\*:\n/,
        ) as unknown,
      });
    });

    it('eta_unavailable inside the window: honest, still selling, same two buttons', async () => {
      const { plan } = setup();
      const planned = await plan(etaUnavailable());
      expect(planned).toEqual({
        action: 'send',
        decision: 'BACKORDER_ETA_PENDING',
        senderId: SENDER,
        text:
          `Rosa, el proveedor todavía no nos confirma fecha para ${NAME} (pedido *BO-000012*).\n\n` +
          'Su lugar sigue apartado: en cuanto llegue se lo separo y le aviso.\n\n¿Seguimos con su pedido?',
        buttons: WAIT_BUTTONS,
        shortBody: '¿Seguimos con su pedido?',
      });
      expect(planned).not.toHaveProperty('staffAlert');
    });

    it('eta_unavailable without a first name', async () => {
      const { plan } = setup();
      await expect(
        plan(
          item(
            'backorder.eta_unavailable',
            {},
            {},
            { customerFirstName: null },
          ),
        ),
      ).resolves.toMatchObject({
        text: expect.stringMatching(
          /^El proveedor todavía no nos confirma fecha/,
        ) as unknown,
      });
    });

    it('tú customers get the tú copy; names and products are never restyled', async () => {
      const { plan } = setup({
        customerStyle: () => Promise.resolve({ register: 'tu' } as never),
      });
      const updated = await plan(etaUpdated({}));
      expect(updated).toMatchObject({
        text: expect.stringContaining(
          'te actualizo tu pedido *BO-000012*',
        ) as unknown,
      });
      expect((updated as { text: string }).text).toContain(
        'Te lo aparto en cuanto llegue y te aviso',
      );
      expect((updated as { text: string }).text).toContain(
        '¿Seguimos con tu pedido?',
      );
      const none = await plan(etaUnavailable());
      expect((none as { text: string }).text).toContain(
        'Tu lugar sigue apartado: en cuanto llegue te lo separo y te aviso',
      );
    });

    it('the wait and cancel ids are the ones the customer reply parser knows', () => {
      expect(parseInteractiveReplyId(`backorder_wait:${ID}`)).toEqual({
        kind: 'backorder_wait',
        reference: ID,
      });
      expect(parseInteractiveReplyId(`backorder_cancel:pick:${ID}`)).toEqual({
        kind: 'backorder_cancel',
        action: 'pick',
        reference: ID,
      });
    });

    it('a payload that cannot be worded is STALE BACKORDER_PAYLOAD_INVALID', async () => {
      const { plan } = setup();
      await expect(
        plan(item('backorder.eta_updated', {}, {}, { folio: null })),
      ).resolves.toEqual({
        action: 'stale',
        decision: 'BACKORDER_PAYLOAD_INVALID',
      });
      await expect(
        plan(item('backorder.eta_updated', {}, {}, { quantity: null })),
      ).resolves.toEqual({
        action: 'stale',
        decision: 'BACKORDER_PAYLOAD_INVALID',
      });
      await expect(
        plan(item('backorder.eta_unavailable', {}, {}, { productName: null })),
      ).resolves.toEqual({
        action: 'stale',
        decision: 'BACKORDER_PAYLOAD_INVALID',
      });
    });

    it('outside the window without templates: STALE WINDOW_CLOSED (never a staff alert)', async () => {
      const { plan } = setup({ isWindowOpen: () => Promise.resolve(false) });
      for (const feedItem of [etaUpdated(), etaUnavailable()])
        await expect(plan(feedItem)).resolves.toEqual({
          action: 'stale',
          decision: 'WINDOW_CLOSED',
        });
    });

    it('outside the window with the flag not exactly true: STALE', async () => {
      for (const templatesEnabled of [undefined, false, 'true' as never]) {
        const { plan } = setup({
          isWindowOpen: () => Promise.resolve(false),
          templatesEnabled,
        });
        await expect(plan(etaUpdated())).resolves.toMatchObject({
          action: 'stale',
        });
      }
    });

    describe('templates on, window closed', () => {
      const on = {
        isWindowOpen: () => Promise.resolve(false),
        templatesEnabled: true,
      };

      it('eta_updated → pedido_reposicion_fecha with the date', async () => {
        const { plan } = setup(on);
        const planned = await plan(etaUpdated());
        expect(planned).toMatchObject({
          action: 'send',
          decision: 'BACKORDER_ETA_PENDING',
          senderId: SENDER,
          template: {
            templateName: 'pedido_reposicion_fecha',
            languageCode: 'es_MX',
            bodyParameters: [
              'Rosa',
              'BO-000012',
              `2 × ${NAME}`,
              'aprox. el 27 de noviembre',
            ],
            refusedDecision: 'TEMPLATE_NOT_APPROVED',
          },
        });
        expect(planned).not.toHaveProperty('staffAlert');
        expect(planned).not.toHaveProperty('buttons');
      });

      it('eta_updated with a past date: «por confirmar con el equipo»', async () => {
        const { plan } = setup(on);
        await expect(
          plan(etaUpdated({ estimatedAt: '2026-11-19T15:00:00.000Z' })),
        ).resolves.toMatchObject({
          template: {
            bodyParameters: [
              'Rosa',
              'BO-000012',
              `2 × ${NAME}`,
              'por confirmar con el equipo',
            ],
          },
        });
      });

      it('eta_unavailable → pedido_reposicion_sin_fecha; no first name → «cliente»', async () => {
        const { plan } = setup(on);
        await expect(plan(etaUnavailable())).resolves.toMatchObject({
          decision: 'BACKORDER_ETA_PENDING',
          template: {
            templateName: 'pedido_reposicion_sin_fecha',
            bodyParameters: ['Rosa', NAME, 'BO-000012'],
          },
        });
        await expect(
          plan(
            item(
              'backorder.eta_unavailable',
              {},
              {},
              { customerFirstName: null },
            ),
          ),
        ).resolves.toMatchObject({
          template: { bodyParameters: ['cliente', NAME, 'BO-000012'] },
        });
      });

      it('names are configurable', async () => {
        const { plan } = setup({
          ...on,
          templateNames: { etaUpdated: 'mi_fecha', etaUnavailable: 'mi_sin' },
        });
        await expect(plan(etaUpdated())).resolves.toMatchObject({
          template: { templateName: 'mi_fecha' },
        });
        await expect(plan(etaUnavailable())).resolves.toMatchObject({
          template: { templateName: 'mi_sin' },
        });
      });
    });

    it('an unknown future backorder type is STALE UNKNOWN_TYPE', async () => {
      const { plan } = setup();
      await expect(plan(item('backorder.future'))).resolves.toEqual({
        action: 'stale',
        decision: 'UNKNOWN_TYPE',
      });
    });
  });

  describe('backend T4 payload shape (sourceDecisionId + phone)', () => {
    it('reservation_expired with sourceDecisionId shows the reschedule offer and buttons', async () => {
      const { plan } = setup();
      await expect(
        plan(
          item(
            'backorder.reservation_expired',
            {
              expiredAt: '2026-11-21T15:00:00.000Z',
              sourceDecisionId: DECISION,
              phoneCountryCode: '52',
              phone: '5512349901',
            },
            {},
          ),
        ),
      ).resolves.toEqual({
        action: 'send',
        decision: 'BACKORDER_EXPIRED_NOTICE',
        senderId: SENDER,
        text:
          `Se venció el apartado de su pedido *BO-000012* (${NAME}).\n\n` +
          '¿Quiere que se lo vuelva a agendar?',
        buttons: [
          { id: `backorder_reschedule:${ID}`, title: 'Sí, agéndalo' },
          {
            id: `backorder_reschedule_decline:${ID}`,
            title: 'No, gracias',
          },
        ],
        shortBody: '¿Quiere que se lo vuelva a agendar?',
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

  describe('customer conversation from the payload phone (S13, backend T4b)', () => {
    const reservedTo = (raw: Record<string, unknown>) =>
      reserved(raw, { conversationRef: null });

    it('conversationRef null + phone: sends to the sender derived from the payload phone', async () => {
      const resolveConversation = jest.fn(() => Promise.resolve(null));
      const { plan, ports } = setup({ resolveConversation });
      await expect(
        plan(reservedTo({ phoneCountryCode: '52', phone: '5512349901' })),
      ).resolves.toMatchObject({
        action: 'send',
        decision: 'BACKORDER_RESERVED_NOTICE',
        senderId: SENDER,
        staffAlert: true,
      });
      expect(ports.isWindowOpen).toHaveBeenCalledWith(SENDER);
      expect(resolveConversation).not.toHaveBeenCalled();
    });

    it('prefers the form of the number whose window is open (modern 52 + 10)', async () => {
      const isWindowOpen = jest.fn((id: string) =>
        Promise.resolve(id === '525512349901'),
      );
      const { plan } = setup({ isWindowOpen });
      await expect(
        plan(reservedTo({ phoneCountryCode: '52', phone: '5512349901' })),
      ).resolves.toMatchObject({ senderId: '525512349901' });
    });

    it('both forms closed: the notice goes to the modern id as a template (flag on)', async () => {
      const { plan } = setup({
        isWindowOpen: () => Promise.resolve(false),
        templatesEnabled: true,
      });
      await expect(
        plan(reservedTo({ phoneCountryCode: '52', phone: '5512349901' })),
      ).resolves.toMatchObject({
        senderId: '525512349901',
        template: { templateName: 'pedido_reposicion_llego' },
      });
    });

    it('eta and other notices use the phone as well; a +52 country code is accepted', async () => {
      const { plan } = setup();
      for (const type of [
        'backorder.eta_updated',
        'backorder.eta_unavailable',
        'backorder.reservation_lost',
        'backorder.cancelled_by_staff',
      ])
        await expect(
          plan(
            item(
              type,
              { phoneCountryCode: '+52', phone: '5512349901' },
              { conversationRef: null },
            ),
          ),
        ).resolves.toMatchObject({ action: 'send', senderId: SENDER });
    });

    it.each([
      ['null phone', { phoneCountryCode: null, phone: null }],
      ['absent members', {}],
      [
        'a foreign country code',
        { phoneCountryCode: '1', phone: '5512349901' },
      ],
      ['a short phone', { phoneCountryCode: '52', phone: '551234990' }],
      ['a phone with letters', { phoneCountryCode: '52', phone: '55123499AB' }],
      [
        'a phone with a leading zero',
        { phoneCountryCode: '52', phone: '0512349901' },
      ],
      [
        'a full-width digit phone',
        { phoneCountryCode: '52', phone: '５５１２３４９９０１' },
      ],
      [
        'a phone that already carries the country code',
        { phoneCountryCode: '52', phone: '525512349901' },
      ],
      ['non-text members', { phoneCountryCode: 52, phone: 5512349901 }],
    ])(
      "%s keeps today's behaviour (reserved → NO_CONVERSATION rejected, others STALE)",
      async (_label, raw) => {
        const { plan, ports } = setup();
        await expect(plan(reservedTo(raw))).resolves.toEqual({
          action: 'rejected',
          decision: 'NO_CONVERSATION',
          reason: 'NO_CONVERSATION',
        });
        await expect(
          plan(
            item(
              'backorder.reservation_reminder',
              { reservedUntil: RESERVED_UNTIL, ...raw },
              { conversationRef: null },
            ),
          ),
        ).resolves.toMatchObject({ action: 'rejected' });
        for (const type of [
          'backorder.eta_updated',
          'backorder.eta_unavailable',
          'backorder.reservation_expired',
        ])
          await expect(
            plan(item(type, raw, { conversationRef: null })),
          ).resolves.toEqual({ action: 'stale', decision: 'NO_CONVERSATION' });
        expect(ports.isWindowOpen).not.toHaveBeenCalled();
      },
    );

    it('an unparseable phone still falls back to the resolver', async () => {
      const resolveConversation = jest.fn(() => Promise.resolve(REF));
      const { plan } = setup({ resolveConversation });
      await expect(
        plan(reservedTo({ phoneCountryCode: '1', phone: '5512349901' })),
      ).resolves.toMatchObject({ senderId: SENDER });
      expect(resolveConversation).toHaveBeenCalledWith(ID);
    });

    it('a conversationRef on the item wins: the payload phone is not used', async () => {
      const { plan } = setup();
      await expect(
        plan(
          reserved(
            { phoneCountryCode: '52', phone: '5599999999' },
            { conversationRef: 'wa:5215512349901' },
          ),
        ),
      ).resolves.toMatchObject({ senderId: SENDER });
    });

    it('a malformed (non-null) conversationRef never falls back to the phone', async () => {
      const { plan } = setup();
      await expect(
        plan(
          reserved(
            { phoneCountryCode: '52', phone: '5512349901' },
            { conversationRef: 'garbage' },
          ),
        ),
      ).resolves.toMatchObject({
        action: 'rejected',
        decision: 'NO_CONVERSATION',
      });
    });

    it('a failing window read is transient (the plan throws), never "closed"', async () => {
      const { plan } = setup({
        isWindowOpen: () => Promise.reject(new Error('db down')),
      });
      await expect(
        plan(reservedTo({ phoneCountryCode: '52', phone: '5512349901' })),
      ).rejects.toThrow('db down');
    });

    it('the logs never carry the phone', async () => {
      const log = jest.spyOn(Logger.prototype, 'log');
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const { plan } = setup({ isWindowOpen: () => Promise.resolve(false) });
      await plan(reservedTo({ phoneCountryCode: '52', phone: '5512349901' }));
      await plan(reservedTo({ phoneCountryCode: '52', phone: '55123' }));
      const lines = [...log.mock.calls, ...warn.mock.calls].flat().join(' ');
      expect(lines).not.toContain('5512349901');
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
