# Deploying and launching ClickIt

The implementation is ready for configuration and validation. It is not a live paid service. No real quiz benchmark, store review, payment-provider approval, or customer recruitment has been completed by the automated tests.

## What ships

- Chrome extension with 10 trial credits, US$4.99 / 500-credit top-ups, balances, consent, backup/restore, and the existing advanced API-key mode.
- Cloudflare Worker, D1 migration, Stripe Checkout and signed webhook fulfillment.
- Public landing page, a real sample quiz, privacy notice, refund terms, and purchase-return page.
- Support contact: thammatorn.j@gmail.com. Private purchase recovery uses email, never public GitHub issues.

All four service flags default to false. The source extension has no hosted URL and works with your own API key in Advanced settings. Release packaging inserts only the selected HTTPS service origin into its host permissions. API and Stripe secret keys stay on the server.

## 1. Create the free Cloudflare deployment

You do not need a domain. Cloudflare's free workers.dev hostname can serve both the API and public pages.

From the repository root, install and sign in:

```powershell
npm ci
npx playwright install chromium
npx wrangler login
npx wrangler d1 create clickit --config server/wrangler.jsonc
```

Copy the returned database ID into `d1_databases[0].database_id` in `server/wrangler.jsonc`. This ID is not a secret. Keep the database name `clickit`.

```powershell
npx wrangler d1 migrations apply clickit --remote --config server/wrangler.jsonc
npx wrangler deploy --config server/wrangler.jsonc
```

Copy the returned HTTPS workers.dev origin into `vars.PUBLIC_URL`. Keep `SUPPORT_URL` as `mailto:thammatorn.j@gmail.com`. Leave trial, inference, Vision, and checkout disabled for this first deployment.

Add secrets through Wrangler's interactive input. Do not paste secret values into commands, tracked files, chat, screenshots, or logs:

```powershell
npx wrangler secret put TYPESAFE_API_KEY --config server/wrangler.jsonc
npx wrangler secret put IP_HASH_SECRET --config server/wrangler.jsonc
```

Use a randomly generated secret of at least 32 bytes for `IP_HASH_SECRET`. It hashes registration IP addresses for abuse control. Rotation changes the rate-limit identity for existing network addresses.

## 2. Package and connect the extension

Replace the example origin with the actual deployment origin:

```powershell
npm run package:extension -- --api-url https://clickit.YOUR-SUBDOMAIN.workers.dev
```

On Windows, this creates `dist/clickit-extension.zip` and `dist/extension/`. The ZIP contains files at its root, suitable for Chrome Web Store upload. The unpacked directory can be used for development. The source extension and source manifest are unchanged by packaging.

Load `dist/extension` in `chrome://extensions`, copy its extension ID, and set `EXTENSION_ORIGINS` to `chrome-extension://YOUR_EXTENSION_ID`. For multiple development and published installations, use comma-separated exact origins, without spaces or wildcards. The published extension ID is authoritative; update the allowed origin after the initial store upload assigns it.

Deploy again with `TRIAL_ENABLED` and `INFERENCE_ENABLED` set to `true`, `VISION_ENABLED=false`, and `CHECKOUT_ENABLED=false` for the free pilot. The public trial is limited to 100 installations total and three registrations per keyed IP hash in 24 hours. The same network may include several legitimate users.

The first invocation of a request atomically reserves a credit. The extension acknowledges delivery only after the page accepts the selection or highlight. Failed acknowledgments are saved locally and retried. Reserved credits expire after two minutes and are recovered on the next API call or the scheduled five-minute cleanup. An interrupted client can receive a suggestion without ultimately being charged; anonymous clients cannot be made tamper-proof. The pilot spending ceiling bounds that exposure.

Back up the installation access key in Settings. Do not clear extension storage during a paid pilot without making a backup. The server stores only a hash, so it cannot display the old key later.

## 3. Configure Stripe in test mode

Use the existing Thailand Stripe account. Verify the legal business profile, account eligibility, settlement details, tax registrations, and intended customer countries before accepting live payments. Stripe Checkout is not assumed to be a merchant of record here.

In Stripe:

1. Create a product called `ClickIt 500 credits` with a one-time USD price of `4.99`. Do not use a recurring price, adjustable quantity, promotion codes, or a customer-chosen amount.
2. Set `STRIPE_PRICE_ID` to that test price ID. Set `STRIPE_LIVE_MODE=false`.
3. Enter the public `/terms.html` and `/privacy.html` URLs in Stripe's public business details. Set support email to thammatorn.j@gmail.com and enable customer receipts. Checkout requires acceptance of the terms.
4. Create a webhook endpoint at `https://YOUR-WORKER/v1/stripe/webhook`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `charge.refunded`.
5. Store the test secret key and webhook signing secret:

```powershell
npx wrangler secret put STRIPE_SECRET_KEY --config server/wrangler.jsonc
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config server/wrangler.jsonc
```

For test checkout only, enable `CHECKOUT_ENABLED=true` in a separate test deployment/database or during a closed test window. The flag controls visibility and the server endpoint. Disable it again after testing. Never mix test-mode credits with the live paid database: use a separate D1 database for payment tests, or remove only verified test installations before public launch. Do not reset the public budget or credit ledger to erase test activity after real users have joined.

Checkout accepts cards only for the initial release. It creates the fixed line item server-side, binds it to the authenticated installation, and uses a signed webhook plus authoritative Stripe lookups to grant credits once. Closing the return page cannot prevent fulfillment. Tax can increase the total above $4.99; the subtotal remains $4.99. Set `STRIPE_AUTOMATIC_TAX=true` only after configuring the corresponding Stripe Tax registrations and settings. With it false, do not interpret that as a determination that no tax is owed.

Test successful payment, abandoned checkout, a closed return page, duplicate webhook deliveries, wrong or unpaid products, a full refund, a partial refund, and a refund delivered before fulfillment. Partial refunds proportionally revoke the matching purchase's entitlement, rounded up, without taking credits from unrelated purchases. Refunds never resurrect credits when a held request is released.

Stripe fee details can be unavailable when the initial webhook arrives. Such orders retain a null fee, not zero. Reconcile missing fees against Stripe before reporting contribution. Fees may be denominated in THB while revenue is in USD; use actual settlement conversions rather than adding different currencies.

## 4. Validate real quiz sessions

Automated tests use mocked provider answers and do not establish model accuracy or Kahoot compatibility. The TypeSafe image/Box interface is experimental. Keep hosted Vision disabled until its own observations pass.

Recruit five consenting adult testers. Use casual quizzes you control or have permission to assist with. Collect at least 100 real observations overall, with coverage of every mode/layout you intend to advertise. On Kahoot, test participant pages with question and answer text visible. A page with only colored shapes is unsupported.

Record only pseudonyms and measurements in a local JSON array. Each observation has this shape; the numbers below illustrate the format and are not evidence:

```json
{
  "tester": "adult-01",
  "mode": "text",
  "correct": true,
  "safe": true,
  "totalMs": 1200,
  "realSession": true
}
```

Include failures and timeouts. `safe` means the action selected/highlighted the intended answer region without submitting or navigating. `correct` means the suggestion matched the independently known answer. A failure to return a valid suggestion is not a correct answer. `totalMs` covers the request through page selection/highlight, not just API inference. Do not store quiz content, screenshots, names, or emails in this file.

```powershell
npm run report:validation -- .clickit-private/validation.json
```

Release thresholds: at least five testers and 100 observations overall; each offered mode must achieve at least 95% safe targeting, 85% answer accuracy, and a p95 time below 5,000 ms. The report separates modes. A failing or untested Vision mode stays disabled. If Text fails for the target casual quiz experience, continue the free pilot instead of enabling purchases.

## 5. Submit to the Chrome Web Store

`docs/STORE.md` contains listing copy, permission explanations, disclosure notes, and screenshot instructions. Build the extension with the real hosted origin before submitting. Supply the real privacy URL. Review the exact privacy disclosures against the final deployed behavior.

Use `dist/clickit-extension.zip` with icons and packaged config. The initial listing should say the pilot is pending/open as appropriate and should disclose the future optional $4.99 / 500-credit purchase. Do not advertise hosted Vision until validated. Store approval timing is external to the one-week implementation schedule.

After approval, put the real store listing URL into `STORE_URL` in Wrangler config and redeploy. The public install link remains hidden when no valid store URL is set.

Before enabling live purchases, verify:

- Store approval, matching extension origin, and working install/update flow.
- Real benchmark thresholds passed for all advertised modes.
- Stripe product/account eligibility, support details, refunds, and appropriate tax configuration checked for the initial countries.
- Live price ID, live secret key, live webhook secret, and `STRIPE_LIVE_MODE=true` configured together.
- First-pack seven-day refund offer, private recovery contact, and service-closure refund process are published.
- One controlled live payment and refund verified, with the user's authorization for the actual charge.

Enable `CHECKOUT_ENABLED=true` only when those checks are complete. No automatic release gate claims to verify external approval or legal eligibility.

## 6. Operate within the spending limit

The database starts with a US$10 global inference ceiling. Each request initially budgets the pinned model's 64,000-token maximum at $0.042/M, or $0.002688. When the response provides a valid `usage.input_tokens` value, cost is reconciled to actual input usage. Missing usage and network failures retain the conservative estimate. Token prices and context limits must be rechecked before switching models or updating this bound. Long-context input is not enabled.

The application refuses new inference before a reservation would exceed the ceiling. This protects ClickIt's own inference path; it does not limit unrelated usage of the same provider key. Use a dedicated key and the provider's own spending controls as well. A budget pause preserves credits. Resolve the incident or replenish the budget deliberately before reopening requests. Cloudflare hosting and Stripe fees are separate from this inference counter.

Run reports:

```powershell
npx wrangler d1 execute clickit --remote --config server/wrangler.jsonc --file server/metrics.sql
```

Use credit-lot totals for lifetime activation and five-suggestion counts because detailed requests are deleted after 90 days. Track returning sessions from `events`, repeat buyers from non-refunded orders, and actual customer-support minutes in `support_actions`. Measure end-to-end latency in the validation report; `api_ms` in requests is only server-side inference time.

Track contribution per fully used 500-credit pack as revenue less tax, actual Stripe fees converted to the same currency, a refund allowance, all 500 suggestions' AI cost including the allocated cost of failed/free requests, and variable hosting. Keep it at least US$3.50 before labor and income tax. Reconcile actual charges instead of relying on advertised token pricing alone.

Do not enable Worker request-body logging. Production observability is off in the supplied config. Scheduled cleanup removes technical request/session history after 90 days and clears old registration IP hashes. Purchase records and credit-lot totals remain for access, disputes, and bookkeeping.

## 7. Recovery, refunds, and incidents

Verify payment ownership privately using the Stripe purchase email and receipt. Look up the associated `orders.installation_id`. Generate a replacement key without printing it:

```powershell
node scripts/recover.cjs VERIFIED_INSTALLATION_UUID
```

The command writes an ignored private directory containing `rotate.sql` and `access-key.txt`. Apply only that SQL file to the remote D1 database, then deliver the new key to the verified owner through private email. The previous key stops working. Windows does not enforce POSIX file modes; use a private local profile and delete the generated key after delivery. Never attach these files to public issues or commit them.

```powershell
npx wrangler d1 execute clickit --remote --config server/wrangler.jsonc --file .clickit-private/GENERATED_DIRECTORY/rotate.sql
```

For eligible refunds, issue the refund in the Stripe Dashboard. The webhook revokes only the refunded purchase's credits, including after event replay. Record support time using a `support_actions` row associated with the installation. If webhook delivery failed, retry the event from Stripe after repairing the service.

For an outage, disable `INFERENCE_ENABLED` and, if appropriate, `CHECKOUT_ENABLED`, redeploy, and post the status through the public page. Do not delete the database or overwrite balances. Back up D1 before migrations and use Cloudflare recovery facilities if needed. Restore a prior Worker version for code regressions; preserve payment webhooks and the existing ledger.

## 8. First customers and later offers

Prepare three honest demonstrations: installation and first answer, a successful casual quiz interaction, and an unsupported screen handled without a click. `docs/STORE.md` contains scripts. Capture real behavior; label illustrative/mock responses and do not use them as model-performance evidence.

After store approval, share in up to three communities that permit promotion and personally invite 20 suitable adults. No unsolicited messages are sent by the implementation. Aim to reply to support within one business day. Spend nothing on advertising yet.

Initial operating targets, not forecasts:

- 60% of installed trials obtain a valid suggestion.
- 10% of users with five suggestions purchase a pack.
- Reach 10 buyers before broadening features or buying traffic.
- If 50 users reach five suggestions with no purchases, pause expansion and interview them about reliability, price, and need.

At 30 buyers and five repeat purchases, test a separate US$9.99 / 1,200-credit offer. That future SKU is intentionally not accepted by the current fixed-pack fulfillment handler. Add it with explicit server-side product mapping and tests when the evidence justifies it. Consider subscriptions only after observed weekly use across four weeks. Explanations, history, teams, affiliate infrastructure, and broader assessment support remain deferred.
