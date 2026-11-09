# Help and technical reference

[Back to the visual guide](../README.md)

## Quick fixes

| Message | Try this |
| --- | --- |
| Question visibility is below 70% | Show the complete question and readable answer choices. |
| No supported, enabled answer button | Wait for the choices to become enabled. For unsupported controls, Vision can show a manual highlight. |
| Request expired | Increase API deadline to 5,000 ms or more in Settings. |
| API key rejected | Select the provider that issued your key and save its key. |

## Vision mode

Choose **Vision · screenshot** when Text mode misses a question that you can read on the page. The model receives a PNG screenshot of the visible tab instead of extracted question text or HTML. The selected mode is saved immediately. Both TypeSafe and OpenRouter use Jev 1.14.

Keep the complete question and all answer choices visible. On Kahoot, Vision can help when the question is displayed in your participant tab but Text detection fails. If your tab shows only colored shapes and the question is on another display, that screenshot does not contain enough information to answer.

Vision checks whether a single-choice question and its choices are visible, separately from finding the correct answer. Visibility must reach 70%; when it does not, the popup shows the returned score. Your configured minimum confidence applies to the chosen answer. There is no hidden 80% confidence floor for region boxes. The answer target is used independently of the predicted choice area, so disagreement between those boxes does not block an answer. TypeSafe marks image input and Box output as [experimental](https://docs.typesafe.ai/images); the [OpenRouter API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) also accepts image assets and Box questions.

Vision takes one screenshot per request. It does not monitor DOM mutations, compare styles or pixels, or require the original answer element to remain in place. Countdown updates, rerenders, and input events do not cancel inference. Switching tabs or navigating still stops a pending answer. Screenshot captures are spaced to respect Chrome's capture rate limit. Keep the same question and viewport visible until the answer arrives: in-page question changes, scrolling, and layout changes can make the screenshot coordinates outdated.

The screenshot is resized to fit the model's image limits, with padding for narrow viewports. Coordinates are mapped back to the page, accounting for the screenshot size and browser display scaling. ClickIt clicks only a supported button or radio control at the returned position. It rejects native submit controls and targets inside navigation elements. It does not infer navigation from answer wording or use debugger access or desktop mouse control.

When the position does not identify a supported control, Vision outlines the suggested answer area and marks its center. Click the highlighted answer manually. This uses the same model response and makes no automatic click or additional API request. The highlight lets your click reach the webpage and disappears after a pointer press, Escape, scrolling, resizing, switching tabs, navigation, another Answer request, or eight seconds. Cosmetic updates and other keypresses leave it visible. It represents the model's suggestion, which can be wrong. Low confidence, navigation, tab switches, and known disabled, checkbox, native submit, or navigation-container targets still stop without a suggestion.

The provider receives the whole visible tab, which may include names and other personal content. Screenshots are processed in memory and are not saved in extension storage. Model inference uses your configured API deadline. Version 2.1.1 uses 5,000 ms for new installations; existing installations retain their setting. If your deadline is still 2,500 ms, increase it to at least 5,000 ms for Vision.

## Detection and limits

Text mode looks for one readable question associated with native radio controls, ARIA radio groups, or sibling answer buttons. It tries standard HTTP/HTTPS webpages without platform-specific setup. Missing, ambiguous, disabled, or unsupported controls produce an explanation instead of a click. If the chosen answer is already selected, no click is needed.

Automatic clicks require answer controls in the main document. Controls inside frames or shadow roots and canvas-only answer controls can receive a visual suggestion for a manual click. Typed answers and multi-select questions are unsupported. Text mode needs readable text and semantic headings or labels; Vision can also read visible images and canvas-rendered questions. Arbitrary layouts and accurate visual targeting are not guaranteed. There is no manual selector configuration.

Text mode invalidates a pending decision when the question or controls change. Vision uses the original screenshot without detecting in-page question changes. Navigation stops both modes. Repeated presses while a request is running do not start another request. Failed or expired requests do not retry automatically. Press **Answer** to try again. The default API deadline is 5,000 ms and the minimum confidence is 0; increase the threshold to skip less confident choices. The model can answer incorrectly. Some sites reject programmatic clicks.

The popup retains the last chosen answer or suggestion for each tab until the extension worker restarts or the tab closes. Timings measure API duration and time from the request starting to the local click or suggestion, not grading or server receipt.

## Access and data

### Hosted credits

Configured releases default to included AI. Users explicitly confirm adult casual use and data processing before starting a 10-credit trial. Text questions or visible-tab screenshots are sent through ClickIt's Cloudflare Worker and OpenRouter to TypeSafe's Jev model. The backend keeps the provider key, authoritative balances, request metadata, and payment references. It does not store quiz content or screenshots. Hosted Vision remains disabled until its compatibility checks pass.

One valid suggestion costs one credit, including a highlight or an already-selected answer. Page changes, visibility failures, invalid responses, and failed requests release reservations. A valid but incorrect suggestion can consume a credit. A failed acknowledgment is saved in trusted extension storage for retry, with abandoned reservations expiring after two minutes. The backend's scheduled cleanup runs every five minutes.

Credits and checkout status are shown in the popup. Checkout opens in a Stripe-hosted browser tab and is blocked during an answer request. Payments are fulfilled from signed webhooks, not the return page. Settings contains a password-masked installation access key to back up or restore credit access. This key is stored unencrypted locally, and only its hash is stored by the server. Keep it private. Contact thammatorn.j@gmail.com privately for payment recovery or billing errors. Basic provides 500 credits for US$4.99/month; Plus provides 1,200 for US$9.99/month. Monthly credits expire at renewal. Upgrades add 700 credits after the prorated payment succeeds; downgrades take effect at renewal. Cancel renewal or open Manage subscription / payment from the popup. Subscription payments have no voluntary refunds. Free and legacy credits retain their original terms.

Existing installations with an API key retain their direct-provider mode. The original direct-provider details below apply to that advanced mode. Hosted mode uses the packaged deployment origin, requires no customer API key, and uses the server's fixed prompts. The source development build has no hosted origin and needs deployment packaging before trial registration works.

Page access uses Chrome's [activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), granted when you invoke the toolbar action. No quiz content script runs before you press Answer. Persistent host permissions cover only the two API providers.

The selected provider receives the detected question and answer choices in Text mode, or the visible-tab screenshot in Vision mode. TypeSafe uses `https://api.typesafe.ai/v1/systemone` with `jev-1.14.0`; OpenRouter uses `https://openrouter.ai/api/alpha/decisions` with `typesafe/jev-1.14`. Requests omit browser cookies. There is no provider fallback. API usage is billed by your provider.

The key is stored unencrypted in the browser profile's extension storage. Only trusted extension contexts can access it; page code and the injected detector never receive it. An HTTP 401 means you should check that the selected provider issued the saved key.

## Development

Node.js 22 or newer is required for tests; browser installation needs no build step.

```powershell
npm ci
npx playwright install chromium
npm test
```

Tests load the extension in Chromium with simulated webpages, real screenshots, and mocked provider responses. They cover text selection, vision requests, screenshot scaling and padding, coordinate clicks, manual suggestion placement and click-through, suggestion cleanup, tolerance of countdowns and rerenders in Vision, changed controls in Text, tab switches, permissions, provider routing, and errors. They make no paid API calls. Live Kahoot compatibility, model accuracy, and image-request latency require separate verification.

An optional live smoke test loads the extension in a temporary Chromium profile, sends one synthetic quiz screenshot to the real provider, and checks for exactly one correct answer click and no Submit click. It makes one billed API request and reads the key from a private file without printing it:

```powershell
npm run test:vision:live -- openrouter "C:\path\to\private-key-file"
```

Use `typesafe` instead of `openrouter` for a direct TypeSafe key. Synthetic checks verify the full request and click path, not compatibility with a hosted quiz service.
