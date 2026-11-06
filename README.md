# ClickIt

ClickIt selects one answer to a visible single-choice text quiz question using Jev 1.14. Press **Answer** for each question. It clicks at most one answer option and stops. It never clicks a separate Submit button. A website may submit or advance automatically when you select an option.

## Install and use

1. Open Chrome or Edge's extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension` folder.
3. Open a quiz webpage, click ClickIt's toolbar icon, and open **Settings**.
4. Choose **TypeSafe** or **OpenRouter**, paste a key from that provider, and save.
5. Choose **Text** or **Vision** above the Answer button, then press **Answer**. Submit manually if the quiz requires it.

Reload the extension after updating its files. Version 2.1 adds Vision mode. Existing installations keep their API settings and start in Text mode. Automatic answering, typed answers, answer banks, and selector overrides remain removed.

## Vision mode

Choose **Vision · screenshot** when Text mode misses a question that you can read on the page. The model receives a PNG screenshot of the visible tab instead of extracted question text or HTML. The selected mode is saved immediately. Both TypeSafe and OpenRouter use Jev 1.14.

Keep the complete question and all answer choices visible. On Kahoot, Vision can help when the question is displayed in your participant tab but Text detection fails. If your tab shows only colored shapes and the question is on another display, that screenshot does not contain enough information to answer.

Vision asks whether one clear single-choice question can be answered and requests the question, choices, and correct answer button regions. It requires at least 0.9 for the answerability decision and 0.8 confidence for each region, or your higher configured threshold. These are initial application thresholds, not measured accuracy guarantees. TypeSafe marks image input and Box output as [experimental](https://docs.typesafe.ai/images); the [OpenRouter API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) also accepts image assets and Box questions.

Before clicking, ClickIt captures the tab again and checks the question and all answer choices for pixel changes. Countdown changes outside those regions are allowed. Scrolling, resizing, switching tabs, navigation, replaced or disabled answer controls, and changes inside the question or choices stop the action. Animated content inside the question can also stop it. Screenshot captures are spaced to respect Chrome's capture rate limit.

The screenshot is resized to fit the model's image limits, with padding for narrow viewports. Coordinates are mapped back to the page, accounting for the screenshot size and browser display scaling. ClickIt clicks only a supported button or radio control at the returned position. It never clicks Submit or navigation, and does not use debugger access or desktop mouse control.

The provider receives the whole visible tab, which may include names and other personal content. Screenshots are processed in memory and are not saved in extension storage. Model inference still uses your configured API deadline; increase it in Settings if image requests expire.

## Detection and limits

Text mode looks for one readable question associated with native radio controls, ARIA radio groups, or sibling answer buttons. It tries standard HTTP/HTTPS webpages without platform-specific setup. Missing, ambiguous, disabled, or unsupported controls produce an explanation instead of a click. If the chosen answer is already selected, no click is needed.

Answer controls must be in the main document. Controls inside frames or shadow roots, canvas-only answer controls, typed answers, and multi-select questions are unsupported. Text mode needs readable text and semantic headings or labels; Vision can also read visible images and canvas-rendered questions. Arbitrary layouts and accurate visual targeting are not guaranteed. There is no manual selector configuration.

A changed question, replaced controls, or navigation invalidates a pending decision. Repeated presses while a request is running do not start another request. Failed or expired requests do not retry automatically. Press **Answer** to try again. The default API deadline is 2,500 ms and the minimum confidence is 0; increase the threshold to skip less confident choices. The model can answer incorrectly. Some sites reject programmatic clicks.

The popup retains the last chosen answer for each tab until the extension worker restarts or the tab closes. Timings measure API duration and time from the request starting to the local click, not grading or server receipt.

## Access and data

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

Tests load the extension in Chromium with simulated webpages, real screenshots, and mocked provider responses. They cover text selection, vision requests, screenshot scaling and padding, coordinate clicks, stale images, changed controls, tab switches, permissions, provider routing, and errors. They make no paid API calls. Live Kahoot compatibility, model accuracy, and image-request latency require separate verification.
