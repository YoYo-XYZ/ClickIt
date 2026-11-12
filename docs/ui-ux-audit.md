# UI/UX audit

November 12, 2026. Implemented in version 2.1.3.

The audit covered the answer popup, loading and error feedback, Text and Vision modes, Vision's manual highlight, settings, both AI access methods, consent, prompts, hotkeys, credit recovery, subscription states, checkout and billing returns, landing/pricing pages, sample quiz, and legal-page layouts.

## Findings and changes

| Priority | Finding | Implemented change |
| --- | --- | --- |
| High | A 184px Answer button mixed the action with the previous result. | A 52px action and a separate last-answer area. Results hide during inference and on errors. |
| High | Credits and onboarding were only discoverable inside settings or after an Answer failure. | A direct account row shows the current balance or access method and opens settings. Accepting trial consent returns to Answer without another save step or starting inference. |
| High | All billing buttons had similar weight. Payment recovery competed with routine plan changes. | Payment problems get the primary action. Billing management is a secondary button during normal use. Cancellation and scheduled changes remain directly accessible. |
| High | An expired upgrade quote disabled confirmation without a recovery action. | The expiry is explicit. Get a new quote requests a fresh price and requires a separate payment confirmation. The confirmation button states the amount due. |
| High | The same return page discussed successful payments, canceled checkout, cancellation, and invoice problems in long paragraphs. | Separate checkout-complete, checkout-canceled, and billing-return states give the relevant next step. Older return URLs retain a useful default. Return parameters never activate subscriptions or grant credits. |
| High | Lost billing responses could leave conflicting payment actions available. | Pending operations expose Retry billing update and block additional changes. Existing server idempotency remains intact. |
| Medium | Settings stacked bordered panels, a large prompt editor, and equally prominent controls. | Simple sections and dividers, collapsed custom prompts, consistent control sizes, and a compact hotkey row. Done becomes Save settings only when configuration changes. |
| Medium | Editing the other prompt required leaving settings and switching the answer mode. | Independent Text/Vision prompt editors preserve the actual answer mode. Reset affects only the prompt being edited. |
| Medium | Failed checkout could retain opening feedback. Missing balances were easy to confuse with exhausted credits. | Failures clear pending feedback and show an alert. Unknown balances say Balance unavailable and retain Refresh. Zero credits remain a distinct state. |
| Medium | Recovery instructions were long and restored keys could remain exposed. | Shorter private-backup guidance, a labeled key field, and an accessible Show/Hide control. Restoring access masks the key again. |
| Medium | Popup messages and results were rewritten on every polling cycle. | Unchanged live-region content stays untouched, preventing repeated screen-reader announcements. Errors have distinct styling and alert semantics. |
| Medium | Site and extension used different palettes, corner sizes, and typography. Pricing used oversized cards. | Shared visual choices, plain pricing rows, smaller headings, aligned controls, and responsive layouts. Legal text remains readable without changing payment policies. |
| Low | Shortcut text had a Ctrl spelling error, and operational copy repeated itself. | Actual shortcut labels, shorter answer/highlight messages, and one elapsed-time value in place of an API timing breakdown. |

## Payment behavior

The extension shows the selected plan's monthly price, credits, renewal behavior, credit expiry, and per-suggestion charging rule before opening Stripe. Upgrades show the amount due now, added credits, existing period end, and renewal price before confirmation. Downgrades apply at renewal. Cancellation remains reversible through Resume renewal.

Successful checkout, canceled checkout, and returning from billing management have separate messages. The page tells users to reopen Clickit and refresh; payment problems offer recovery through Stripe. Invoice confirmation remains the authority for adding credits. The price catalog, metering, refund rules, and webhook settlement behavior are unchanged.

## Verification

- `npm ci` under Node.js 22.19.0.
- `npm test`: 96 tests, including real Chromium extension tests with mocked providers and Stripe responses.
- `npm run test:hotkey:windows`: native Text/Vision hotkeys, duplicate protection, toolbar feedback, remapping, and unassigned shortcut display.
- `npm run check:worker`: Worker and website asset build passed.
- Extension layouts checked at 320px and 360px, including payment problems, canceled renewal, expanded settings, and 200% text enlargement.
- Public pages and all return variants checked at 320px, 360px, 768px, and 1280px.
- Keyboard checks cover access segments, settings navigation, prompt editing, Escape, focus restoration, and error announcements.
- Configured extension package checked for matching source files, version consistency, assigned extension ID, overflow, and startup errors.
- Screenshots reviewed for answer, onboarding, subscription management, payment recovery, mobile pricing, and return states. Captures and the test log are in the ignored `test-results/` directory.

Stripe-hosted card forms were exercised through mocked checkout and portal contracts. No live charge, deployment, or store publication was performed.
