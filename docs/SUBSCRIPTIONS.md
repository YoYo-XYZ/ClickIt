# Subscription operations

Basic is US$4.99/month for 500 credits. Plus is US$9.99/month for 1,200 credits. Prices exclude applicable tax. Billing follows Stripe's monthly subscription periods, including short-month behavior; it is not a fixed 30-day timer. Monthly credits expire at period end. The 10-credit trial requires no card. Existing trial and legacy purchased credits keep their original terms.

## Configuration and deployment

Public checkout stays disabled in the checked-in configuration. This implementation does not activate live payments or change the deployed service. Before enabling it:

The checked-in recurring price IDs and portal configuration are now real **test-mode** resources created and exercised during implementation. Keep them separate from future live resources.

1. Back up D1. Apply migrations through `0003_subscriptions.sql` before deploying the Worker; these preserve existing orders, balances, and requests. Deploy the updated Worker, then apply `0004_remove_unused_billing_state.sql` to remove unused checkout URL, expiry, and schedule ID columns. This Worker supports the schema both before and after `0004`; older Workers that write the removed columns require restoring those columns before rollback. A rollback must also retain the expiry-aware reservation query and SQL trigger; do not deploy an old Worker that reports expired credits as spendable.
2. In Stripe test mode create one product, `ClickIt`, with two active, exclusive-tax, licensed monthly USD prices. Basic has unit amount `499`; Plus has `999`; interval count is one. Do not enable coupons, promotion codes, adjustable quantity, annual prices, or Stripe subscription trials.
3. Set `STRIPE_BASIC_PRICE_ID` and `STRIPE_PLUS_PRICE_ID` to those prices. Keep `STRIPE_PRICE_ID` for historical one-time purchase/refund fulfillment; do not reuse it for subscriptions. Keep `STRIPE_LIVE_MODE=false` while validating. The server verifies both prices and their shared product before checkout.
4. Create a dedicated customer portal configuration. Enable payment-method updates, invoice history, and subscription cancellation **at period end**. Disable subscription updates, quantity changes, pause, promotions, and retention coupons. Set the support address, terms URL, and return URL. Put its ID in `STRIPE_PORTAL_CONFIGURATION_ID`. Tier changes happen in the extension, not the portal. The extension also provides cancellation and reversal, releasing any pending downgrade schedule first.
5. Configure test `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as Worker secrets. Pin the webhook endpoint and API requests to **2024-06-20**. Register `/v1/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`, and `charge.refunded`.
6. Keep hosted Vision disabled. Use a separate test deployment with checkout enabled for validation; do not turn on public checkout to test. Finish Stripe business onboarding, Terms of Service URL, support details, and the appropriate tax setup. Checkout currently disables Automatic Tax explicitly.
7. After test evidence passes, configure separate live prices, portal configuration, and secrets together with `STRIPE_LIVE_MODE=true`. Verify the live webhook API version and published extension origin before deliberately enabling checkout. Subscription migration must not silently enable purchases.

## Subscription and credit behavior

Paid invoices are the source of monthly grants. Checkout and portal return pages never activate access. Basic-to-Plus upgrades use a five-minute quote and the same proration timestamp when confirmed, immediate invoicing, and `payment_behavior=pending_if_incomplete`. The payment must succeed before the extra 700 credits are granted. The billing date and already consumed credits stay unchanged. A pending upgrade shows a payment-recovery action. An authentication-required payment can be completed using the invoice in billing management.

Downgrades use a subscription schedule: retain Plus until period end, switch to Basic at renewal, then release the schedule and continue monthly. Keep current plan removes that schedule. Cancel renewal removes the schedule and sets cancellation at period end. Undo cancellation retains the current tier. Cancellation, reversal, and billing management remain available with new checkout disabled.

Subscriptions never replenish on a timer alone. Unpaid renewal invoices grant nothing. Successful payment later grants the allowance for that invoice's original period; it does not extend expiry. Wrong suggestions consume credits; failed/invalid suggestions do not. Monthly credits are spent first. In-flight requests can settle their original reservation for up to two minutes across period end; they never charge the next period.

An invoice grants once, and a subscription period can grant at most 500 or 1,200 credits. Replayed, reordered, and delayed events cannot reset usage or restore expired credits. Billing writes are serialized per installation with renewable database leases. Checkout retries reuse an existing session; changing tier expires the old open session first. A completed checkout for an ended subscription does not prevent resubscribing.

The scheduled Worker reconciles ten billing accounts per run, oldest reconciled first. It retrieves authoritative subscription state and paginates paid invoices, processing monthly invoices before upgrade prorations. It also repairs billing operations accepted by Stripe when the browser lost the response, so restoring an access key does not block cancellation. A reopened popup offers Retry syncing billing change with the original operation ID. `billing_accounts.reconcile_error` flags failures without logging payment or quiz content. Missing Stripe fee details remain null and are retried during reconciliation. The popup shows the sync error without making existing credits unusable.

## API contract

All endpoints use the existing installation bearer credential and exact-origin policy. Client amounts, allowances, Stripe IDs, or customer IDs are never accepted as billing authority.

- `POST /v1/checkout`: `{checkoutId, planId}` where `planId` is `basic` or `plus`; returns a Stripe Checkout `{url}`. Existing live subscriptions must use management instead.
- `GET /v1/balance`: returns `credits`, `reserved`, `checkoutEnabled`, `visionEnabled`, `monthlyCredits`, `otherCredits`, `billingManagementAvailable`, `billingSyncError`, and nullable `subscription`. Subscription fields include `planId`, `status`, paid `allowance`, period timestamps in milliseconds, `cancelAtPeriodEnd`, `scheduledPlan`, `pendingUpgrade`, and `paymentActionRequired`.
- `POST /v1/subscription/preview`: `{planId:"plus"}`; returns an installation-bound `quoteId`, amount due in USD cents, additional credits, proration timestamp, period end in Stripe seconds, and `expiresAt` in milliseconds. No charge occurs.
- `POST /v1/subscription/change`: `{changeId,action,quoteId?}`; actions are `upgrade`, `downgrade`, `keep_plan`, `cancel`, or `resume`. Upgrade requires the preview's quote. Returns the refreshed balance and `changed:true`. Reuse the operation ID after a lost response.
- `POST /v1/billing-portal`: `{}`; returns an owner-bound `https://billing.stripe.com` session URL. Works while checkout is disabled.

Unknown plans, expired quotes, conflicting operations, and missing configuration fail without granting credits. Existing extensions must be updated to select a plan; old one-time purchase requests are rejected rather than silently starting recurring billing.

## Validation before live billing

Run `npm test`, `npm run check:worker`, and `npm run package:extension -- --api-url https://YOUR-TEST-WORKER.workers.dev`. Local tests use a simulated Stripe API; they do not establish successful communication with Stripe or complete a real Checkout session.

Use Stripe test cards and test clocks on the separate test deployment. Test clocks must be attached when the test customer is created. The application creates a customer on first checkout; for clock testing, use a dedicated test installation, create a clock-backed customer in Stripe with its installation metadata, and associate that customer with the test installation's `billing_accounts` row **before** first checkout. Do not replace a production customer's mapping. Wait until clock advancement is ready and webhook delivery completes before checking balances.

Record the test deployment, Stripe API version, test customer/clock, invoice and event IDs, expected/observed credit balances, and outcome, without secrets or card details. Complete this matrix:

- Both initial tiers with Stripe's successful test card; abandon checkout and close the return page. Verify only paid invoices grant credits, exactly once.
- Declined and 3DS-required initial payments and renewals. Update the payment method or authenticate, then verify successful recovery grants once and uses the original period end.
- Advance through renewal, including a month-end subscription. Verify no rollover and the exact Stripe billing boundaries.
- Consume 300 Basic credits, preview and pay an upgrade, then verify 900 monthly credits remain with the same renewal date. Repeat after a failed/SCA-required upgrade; verify Basic remains until payment succeeds.
- Schedule and remove downgrades; advance to a downgrade renewal and verify 500 credits. Cancel, reverse cancellation, cancel again, and advance past expiry. Then resubscribe.
- Replay old invoice and subscription webhooks, deliver an upgrade event before the initial invoice event, and disable webhook delivery for a renewal before running scheduled reconciliation.
- Issue support-only full and partial refunds, including before initial delivery, and verify only the corresponding invoice's credits are revoked. Test concurrent answer reservations at expiry and checkout/change retries after lost responses.
- Restore the key into a second installation and verify shared usage and management. Verify another installation cannot use its quotes, operations, or billing customer.

Live rollout remains blocked until this external matrix is recorded and Stripe onboarding is complete. No external Stripe test-clock run is claimed by the local automated tests.

For repeatable API and clock checks, run `npm run test:subscriptions:stripe` with `CLICKIT_STRIPE_SECRET_FILE` set to the private file returned by the secret prompt. The script refuses live keys, uses the actual pinned Stripe API with a local Worker/database test harness, deletes its clock-backed test customer afterward, and writes non-secret results to `.clickit-private/stripe-subscriptions-test.json`. It reuses the report's test price and portal IDs on later runs. Set `CLICKIT_ALLOW_CHECKOUT_BLOCKED=1` only when deliberately accepting a skipped Checkout check; the report still records the blocker and a partial rollout status.

### Verification recorded on November 8, 2026

- All 72 local tests passed, including the extension, public pages, server, and Cloudflare D1 migration/concurrency checks. Worker dry-run compilation and extension packaging passed.
- The separate Stripe API/test-clock run passed paid Basic billing, duplicate invoice processing, a declined upgrade, a 3DS-required upgrade, recovery with a replacement payment method, and the 300-used-credit upgrade leaving 900 credits. The actual upgrade charge matched its preview.
- The same run passed downgrade renewal and expiry, a declined renewal followed by successful payment recovery, partial refund revocation, billing portal creation, cancellation reversal, and cancellation at period end.
- Checkout creation was blocked by the missing account Terms of Service URL. The user chose to leave that check blocked. `CHECKOUT_ENABLED=false` and `STRIPE_LIVE_MODE=false` remain unchanged. No production deployment or live payment occurred.
- The external harness invokes signed test notifications locally and reads authoritative objects from Stripe. Public webhook delivery, interactive Checkout completion, and interactive 3DS challenge completion still need validation on the deployment. Recovery in the automated run used a replacement successful test payment method.

## Support and measurement

Subscription payments have no voluntary refunds. Handle duplicate/incorrect billing and mandatory rights privately. Stripe refunds proportionally revoke the matching invoice's credits, rounded up. They do not change unrelated grants or automatically cancel a subscription; if the remedy requires cancellation, cancel it explicitly in Stripe. Legacy packs retain their original refund policy.

Use `server/metrics.sql` for active subscribers by tier, nominal MRR, renewals, failed payments, cancellation state, refunds, fees, and inference costs. Nominal MRR uses active recurring prices and excludes tax and unpaid/past-due subscriptions; actual revenue and refunds are reported separately. Fees can be in THB while invoices are in USD; convert using actual settlement records before reporting contribution. At the configured maximum request cost, a fully used allowance can cost more than its subscription revenue, so check observed inference usage and the pilot spending ceiling before widening launch.
