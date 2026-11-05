# Payment links (backlog)

Status: deferred. The first end-to-end version accepts **bank transfer only**
(owner decision, 2026-11-05). Card payment links are a later, separate feature.

## Where it lives

A payment link is a payment on a sale, so the provider integration belongs in
`houndfe-backend`. The chatbot only sends the link it receives from the backend
and reacts to the backend's payment outcome.

## Options researched (2026-11-05, web research, not contract-verified)

| Option | API to create a link per order | Payment confirmation | Difficulty |
|---|---|---|---|
| EVO Payments México ("EVO Click" is the manual portal) | Yes, through the EVO payment engine on Mastercard Gateway: `INITIATE_CHECKOUT` with `checkoutMode: "PAYMENT_LINK"` | Webhooks with `X-Notification-Secret`, documented as not guaranteed: poll Retrieve Transaction | Medium-high: needs an EVO affiliation contract plus the e-commerce annex, no Node SDK, fees not verified |
| Mercado Pago Checkout Pro | Yes: `POST /checkout/preferences` returns the payment URL | Webhooks, sandbox available | Easy |
| Stripe Payment Links (Mexico) | Yes | Webhooks | Easy |
| Conekta | Yes: `POST /checkouts` | Webhooks | Easy-medium |
| Clip, Openpay | Yes (redirect checkout / payment button) | Webhooks | Medium |

Recommendation: unless EVO is required by the business's bank or fees, Mercado
Pago is the fastest path.

## Open questions before starting

- Does the current EVO contract include API (e-commerce engine) access?
- EVO fees versus Mercado Pago fees for the expected ticket size.

## Sources

- https://evopayments.mx/evoLandings/evo-click/
- https://evopaymentsmexico.gateway.mastercard.com/api/documentation/integrationGuidelines/supportedFeatures/pickAdditionalFunctionality/paymentLinks.html?locale=es_MX
- https://evopaymentsmexico.gateway.mastercard.com/api/documentation/integrationGuidelines/supportedFeatures/pickAdditionalFunctionality/webhookNotifications.html?locale=es_MX
- https://evopayments.mx/motor-pagos-mastercard/
- https://www.mercadopago.com.mx/developers/en/reference/online-payments/checkout-pro/preferences/create-preference/post
- https://docs.stripe.com/api/payment-link
- https://developers.conekta.com/docs/generar-link-de-pago-v%C3%ADa-api
