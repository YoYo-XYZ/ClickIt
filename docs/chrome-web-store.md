# ClickIt Chrome Web Store release

Assigned extension ID: `dfpglkafpdbnfecohhgmhkpceinhhpjl`. The item is a draft, not a published listing. Its public key is stored in `chrome-web-store-public-key.pem` for release packaging and testing with the same ID.

## Listing copy

Name: ClickIt

Language: English. Category: Education. Visibility: Public. Regions: All supported regions.

Short description:

Choose an answer to a visible single-choice quiz question with one click. Included AI credits or your own API key.

Detailed description:

ClickIt suggests one answer to a visible single-choice quiz question when you press Answer or use your answer hotkey.

Text mode reads the visible question and answer choices. Vision mode sends a screenshot of the whole visible tab. ClickIt selects a supported answer control or highlights an answer for you to click. You review the suggestion and submit the quiz yourself. ClickIt never submits, advances to another question, or runs without an explicit Answer press or hotkey.

Eligible new installations receive 10 free suggestions without a card. Basic costs US$4.99 per month for 500 credits. Plus costs US$9.99 per month for 1,200 credits. Plans renew automatically until canceled. Monthly credits expire at renewal and do not roll over. Checkout shows the total before you subscribe. Manage or cancel renewal in the extension. One valid delivered suggestion uses one credit, even if it is wrong. Failed requests and rejected page changes do not use credits.

Advanced settings support your own TypeSafe or OpenRouter API key, billed separately by your selected provider. Save separate Text and Vision prompts and manage Chrome's answer hotkey from Settings. Keep a private backup of your installation access key to restore hosted credits after reinstalling.

Keep one complete question and its readable choices visible. Typed answers and multi-select questions are unsupported. Some pages require a manual click on the highlighted answer. A participant screen showing only shapes without the actual question is insufficient. Compatibility, accuracy, and response time vary. Use ClickIt only for casual quizzes where assistance is permitted. The service is for adults aged 18 or older.

After your consent and an explicit Answer action, hosted requests send the question and choices or screenshot through ClickIt's Cloudflare service and OpenRouter to TypeSafe's Jev model. API-key requests go directly to your selected provider. Screenshots may include personal information visible on the tab. Review the tab before using Vision. ClickIt does not store quiz content or screenshots in its database or intentionally log them. Provider retention policies also apply.

Privacy: https://clickit.thammatorn-clickit.workers.dev/privacy.html

Terms and refunds: https://clickit.thammatorn-clickit.workers.dev/terms.html

Support: thammatorn.j@gmail.com

## Privacy form

Single purpose: Suggest and select one answer to a visible single-choice casual quiz question after an explicit user action.

Permission justifications:

- `activeTab`: Read the current question or capture the visible tab only after the user invokes ClickIt. Access ends under Chrome's active-tab rules.
- `scripting`: Detect visible questions and select or highlight one answer in the invoked tab. Page scripts receive no credentials.
- `storage`: Save settings, consent, prompts, provider API keys, installation access, and pending credit settlement in trusted extension storage.
- `https://api.typesafe.ai/*`: Make the user's direct TypeSafe requests in optional API-key mode.
- `https://openrouter.ai/*`: Make the user's direct OpenRouter requests in optional API-key mode.
- Hosted service origin: Register consented installations, request suggestions, settle credits, and manage subscriptions through ClickIt's HTTPS service.

Remote code: No. All extension JavaScript ships in the package. Provider JSON responses contain validated choices or boxes, never executable code.

Declare the actual handled data, including website content, authentication information, installation identifiers, usage records, and financial/payment records described in the privacy policy. Screenshot content can incidentally include personal information. Stripe handles card entry; ClickIt does not receive card numbers. Do not declare that no data is handled or collected.

Only certify Limited Use statements after confirming the deployed extension, website, and provider handling agree with the published policy.

## Reviewer instructions

1. Install ClickIt and open https://clickit.thammatorn-clickit.workers.dev/demo.html.
2. Open the popup, read the age and data disclosures, and start the free trial. Alternatively, restore the separate reviewer installation key in Settings, then accept the disclosures in the popup. This does not create another trial. The key belongs only in the dashboard's private reviewer instructions, never this file or the public listing.
3. Select Text and press Answer. The sample answer is 4. Confirm one answer is selected and the quiz remains unsubmitted.
4. Repeat in Vision with the whole question and choices visible. Each Answer action creates at most one suggestion.
5. Configure the answer hotkey through Settings and invoke it with the popup closed. Check toolbar status. Chrome can leave a conflicting shortcut unassigned.
6. Inspect monthly plans and subscription management. Installation and the free trial do not require payment. Reviewer access must cover testing without a personal provider key or purchase.
7. Optional API-key mode requires accepting its own disclosure in Settings. Changing provider clears that consent.

Do not include provider keys, live customer credentials, payment details, or production operator credentials in reviewer instructions.

## Release checks and operations

The user confirmed prior hands-on quiz testing. This release does not claim the 100-session/five-tester benchmark passed.

On November 10, 2026, the isolated Stripe test-clock suite passed with a separately supplied test-mode key and no external setup blockers. It covered Checkout creation and abandonment, exactly-once invoice credit grants, declined and authentication-required upgrades, proration, scheduled downgrade and renewal, failed renewal and recovery, partial refunds, portal access, and cancellation. The test-clock customer was deleted after the run. A separate validation Worker and D1 database subsequently passed actual Stripe HTTP invoice-webhook delivery, replay without duplicate credits, cancellation, and Edge Checkout with a completed test 3DS challenge. The browser purchase delivered 500 monthly credits. No live purchase has completed.

Hosted Text and Vision also passed through an isolated unpacked extension with the assigned store ID and the deployed validation backend. Each selected 4 once, submitted nothing, and settled one credit. The repeatable operator check is `node scripts/live-hosted-extension.cjs <https-service-origin> <private-installation-key-file>`. It uses real inference and is excluded from routine tests. Production Vision was then enabled and both Text and Vision passed again against the production backend, with one credit settled per action. Public checkout remains disabled pending the owner purchase. All 87 automated tests, the native Windows Text/Vision hotkey test, and the Worker dry-run build passed. A private live Basic checkout for a separate operator installation is ready for the owner; no live purchase has completed.

The store draft has the icon and three screenshots uploaded, with public visibility, all regions, and in-app purchases selected. The privacy form still needs a successful save, and the publisher contact email must be supplied and verified. The item has not been submitted.

- Run `npm test`, `npm run test:hotkey:windows`, and `npm run check:worker` after final changes.
- Run the separate Stripe test-clock suite with a private TEST key. A LIVE key must never substitute for it.
- Provision the production `/v1/stripe/webhook` endpoint for the billing events, pin its API version to `2024-06-20`, and install its signing secret as `STRIPE_WEBHOOK_SECRET` in Worker secret storage. Verify delivery of an actual Stripe event, reject invalid signatures and test-mode events, and confirm that the owner's paid invoice grants 500 monthly credits exactly once before public paid launch.
- Keep combined live validation spending below US$10, including the owner-completed Basic purchase. Cancel that test subscription's renewal.
- Build with `npm run package:extension -- --api-url https://clickit.thammatorn-clickit.workers.dev --public-key-file docs/chrome-web-store-public-key.pem`. Check that the unpacked extension ID matches the assigned ID.
- Run `node scripts/store-screenshots.cjs` after browser tests generate current interface captures. Upload the three 1280x800 PNGs and the existing 128x128 icon.
- Add the assigned store origin to the backend allowlist before reviewer testing. Keep the existing development origin while the operator installation needs it.
- Keep checkout and hosted Vision disabled until their respective checks pass. Billing management must remain available to existing subscribers when new checkout is disabled.
- Submit with automatic publication after approval. A draft or pending review is not a published listing.
- Set `STORE_URL` only after verifying the approved listing is publicly installable. Then deploy and verify the website's installation link.
- For rollback, disable new checkout and the affected inference mode, preserve records and balances, and retain billing management. A private prelaunch D1 export is stored outside Git.

Before the live cutover on November 10, 2026, production had no paid legacy orders and Stripe had no open live Checkout sessions. The previous one-time price was absent from the live catalog, so it is not configured as a live product. The legacy settlement code remains available for deployments that have real legacy purchases.

## Version 1.0.0 release notes

ClickIt supports hosted Text and Vision suggestions, optional direct provider access, monthly subscriptions, saved prompts, and a browser-managed answer hotkey. Requests remain user-triggered and never submit quizzes.

This release fixes Windows lock-key events canceling a Vision hotkey request, adds explicit API-key data-sharing consent, requires local consent after hosted access restoration, and links subscription Checkout to the privacy and refund terms. Typing and changes to the question, target, tab, or viewport still cancel stale decisions.
