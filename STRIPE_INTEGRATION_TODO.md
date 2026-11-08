# Stripe integration TODO

Scenario A applies. The only Checkout Session creation call is in [server/billing.mjs](server/billing.mjs). Only its parameter object was changed. This file is the single source of truth for remaining setup steps from this change.

## Values to Replace

No `sample_only` fields are missing or contain placeholders. No files contain Checkout placeholders requiring replacement.

| Field | Preserved value | Status |
|-------|-----------------|--------|
| mode | `subscription` | Correct for Basic and Plus monthly subscriptions. |
| success_url | `${publicUrl()}/purchase.html` | Uses the existing configured `PUBLIC_URL`. |
| cancel_url | `${publicUrl()}/purchase.html?cancelled=1` | Uses the existing configured `PUBLIC_URL`. |
| line_items[0].price | `prices[plan.id]` | Uses existing `STRIPE_BASIC_PRICE_ID` or `STRIPE_PLUS_PRICE_ID`, both configured with real test Price IDs. |
| line_items[0].quantity | `1` | Preserved. |

## Configured Parameters

Files containing these parameters:

- [server/billing.mjs](server/billing.mjs)

| Parameter | Value |
|-----------|-------|
| ui_mode | `hosted_page` |
| billing_address_collection | `auto` |
| phone_number_collection.enabled | `false` |
| automatic_tax.enabled | `false` |
| allow_promotion_codes | `false` |
| payment_method_collection | `always`, with the existing subscription mode |
| submit_type | `auto` |
| integration_identifier | `hosted_web_0002` |
| origin_context | `web` |

Booleans are serialized as form strings by the existing REST transport. Parameters absent from the field intents were removed: `customer`, `payment_method_types`, `client_reference_id`, `metadata`, `subscription_data`, `consent_collection`, and `custom_text`. The existing idempotency key is unchanged.

## Setup and next steps

### Resolve deployment blockers

1. Resolve the conflict between the configured parameter allowlist and existing ownership validation before enabling checkout. `checkoutCompleted()` requires the stored customer, `client_reference_id`, and `metadata.clickit_checkout`; subscription validation also requires `subscription_data.metadata.clickit_installation`. These fields were removed as requested. Without `customer`, subscription Checkout creates a new customer instead of using the stored billing account customer. Current webhook fulfillment and reconciliation cannot associate these purchases correctly. A follow-up must either authorize restoring those parameters or adapt the ownership mapping and tests. No surrounding billing code or tests were changed in this task.
2. Verify API compatibility before deployment. This project uses direct REST requests, with no installed Stripe SDK, so `ui_mode` uses the requested unknown-version fallback `hosted_page`. Per the supplied version rule, SDKs below 21.0.0 use `hosted`; SDKs 21.0.0 and above use `hosted_page`. The existing transport pins API version `2024-06-20`, which was preserved. Confirm that this API contract accepts `hosted_page`, `integration_identifier`, and `origin_context`; resolve any required API migration separately, including invoice and subscription compatibility. The [current Checkout Session reference](https://docs.stripe.com/api/checkout/sessions/create) documents the modern parameters but does not establish compatibility with this project's older pin.
3. Reconcile existing product/setup documentation with these configured settings. Checkout now always disables Automatic Tax, regardless of `STRIPE_AUTOMATIC_TAX`, and no longer requests explicit terms consent or displays the custom renewal text. Review the existing tax and terms setup before rollout.

### Environment and dependencies

- Existing server framework: Cloudflare Worker with D1. No dependencies, routes, middleware, environment loaders, or webhook handlers were added.
- Keep `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as server-only Worker secrets. For local Wrangler development, use the same names in the ignored `.dev.vars` file. Do not put secrets in browser variables or commit them. No `.env` file was added or changed; no publishable key is needed by the existing hosted redirect integration.
- Existing non-secret values are in [server/wrangler.jsonc](server/wrangler.jsonc): `PUBLIC_URL`, `STRIPE_BASIC_PRICE_ID`, `STRIPE_PLUS_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_LIVE_MODE`, and `CHECKOUT_ENABLED`. Keep keys, prices, portal configuration, webhook secret, and mode in the same Stripe environment. Existing resources are test resources; use separate live resources for launch.
- Keep `CHECKOUT_ENABLED=false` in the public deployment until ownership mapping, API compatibility, and end-to-end testing pass. Use a separate test deployment for checkout validation.
- Apply existing D1 migrations before deployment and configure the existing `/v1/stripe/webhook` endpoint. The event list and broader subscription test matrix are in [docs/SUBSCRIPTIONS.md](docs/SUBSCRIPTIONS.md); the blockers and configured values above take precedence for this change.

### Project structure and behavior

The only new file is `STRIPE_INTEGRATION_TODO.md`. The existing parameter object in `server/billing.mjs` was updated.

The existing `POST /v1/checkout` endpoint validates the installation and selected plan, then creates a subscription Checkout Session using the configured monthly price. It returns the Stripe-hosted URL to the extension. The extension opens Checkout, and Stripe returns the buyer to `purchase.html`. Paid invoice webhooks are intended to grant credits once; redirects never grant credits. That fulfillment path remains blocked by the ownership conflict described above.

### Validation and testing

- `npm run check:worker`: passed. This was a deployment dry run; nothing was deployed.
- `npm run test:server`: 28 tests, 15 passed and 13 failed. Two failures assert that `allow_promotion_codes` is absent, whereas the requested value is now explicitly `false`. The other 11 fail with `Checkout owner does not match.` after removal of the ownership parameters. Fix the ownership contract before updating assertions to match the new configuration.
- No real Stripe Session creation or payment was attempted during this task. Local mocks do not verify API-version compatibility.
- After resolving the blockers, test in Stripe test mode or a sandbox using `4242 4242 4242 4242` for success, `4000 0000 0000 9995` for insufficient funds, and `4000 0025 0000 3155` for authentication. Use a future expiration date and any valid three-digit CVC. Use only test card details. See [Stripe testing documentation](https://docs.stripe.com/testing).
- Verify both plans, cancellation/return URLs, failed and authenticated payments, signed webhooks, duplicate delivery, invoice-based credit grants, refunds, and subscription renewals. Confirm customer/subscription identifiers map to the right installation and that D1 order and invoice records are updated once.
- For future product changes, use actual monthly Price IDs with the amounts and shared product required by the existing catalog validation. Complete Stripe onboarding and the existing test matrix before configuring live resources and enabling checkout.

### Resources

- [Stripe support](https://support.stripe.com)
- [Stripe MCP documentation](https://docs.stripe.com/mcp)
- [Checkout Session API](https://docs.stripe.com/api/checkout/sessions/create)
- [Stripe testing](https://docs.stripe.com/testing)
