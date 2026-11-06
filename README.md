# ClickIt

ClickIt selects one answer to a visible single-choice text quiz question using Jev 1.14. Press **Answer** for each question. It clicks at most one answer option and stops. It never clicks a separate Submit button. A website may submit or advance automatically when you select an option.

## Install and use

1. Open Chrome or Edge's extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension` folder.
3. Open a quiz webpage, click ClickIt's toolbar icon, and open **Settings**.
4. Choose **TypeSafe** or **OpenRouter**, paste a key from that provider, and save.
5. Choose **Text** or **Vision** above the Answer button, then press **Answer**. Submit manually if the quiz requires it.

Reload the extension after updating its files. Version 2.4.0 adds editable answer prompts in Settings. Existing installations keep their API settings. Automatic answering, typed answers, answer banks, and selector overrides remain removed.

Choose Text or Vision, open the Settings gear, and edit that mode's prompt. Save settings to apply it, or use Reset to restore the default before saving. Each mode keeps its own prompt, shared across providers. Text uses it to choose an option; Vision uses it to locate the chosen answer button. Vision's visibility and region-detection instructions and the required response formats remain fixed. Prompts must contain 1–6,000 characters.

## Vision mode

Choose **Vision · screenshot** when Text mode misses a question that you can read on the page. The model receives a PNG screenshot of the visible tab instead of extracted question text or HTML. The selected mode is saved immediately. Both TypeSafe and OpenRouter use Jev 1.14.

Keep the complete question and all answer choices visible. On Kahoot, Vision can help when the question is displayed in your participant tab but Text detection fails. If your tab shows only colored shapes and the question is on another display, that screenshot does not contain enough information to answer.

Vision checks whether a single-choice question and its choices are visible, separately from finding the correct answer. Visibility must reach 70%; when it does not, the popup shows the returned score. Your configured minimum confidence applies to the chosen answer. There is no hidden 80% confidence floor for region boxes. The answer's center must fall inside the detected choice area; small differences between independently predicted box edges are allowed. TypeSafe marks image input and Box output as [experimental](https://docs.typesafe.ai/images); the [OpenRouter API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) also accepts image assets and Box questions.

Vision takes one screenshot per request. It does not take a second screenshot or compare pixels before clicking or highlighting. Scrolling, resizing, switching tabs, navigation, replaced or disabled answer controls, and detected page-content changes inside the question or choices still stop the action. Canvas-only visual changes do not stop it. Screenshot captures are spaced to respect Chrome's capture rate limit.

The screenshot is resized to fit the model's image limits, with padding for narrow viewports. Coordinates are mapped back to the page, accounting for the screenshot size and browser display scaling. ClickIt clicks only a supported button or radio control at the returned position. It never clicks Submit or navigation, and does not use debugger access or desktop mouse control.

When the position does not identify a supported control, Vision outlines the suggested answer area and marks its center. Click the highlighted answer manually. This uses the same model response and makes no automatic click or additional API request. The highlight lets your click reach the webpage and disappears after interaction, scrolling, resizing, switching tabs, navigation, a detected question or answer change, another Answer request, or eight seconds. It represents the model's suggestion, which can be wrong. Low confidence, detected page changes, and known disabled, checkbox, Submit, or navigation targets still stop without a suggestion. Canvas-only pixel changes cannot be detected by the page's change observer.

The provider receives the whole visible tab, which may include names and other personal content. Screenshots are processed in memory and are not saved in extension storage. Model inference uses your configured API deadline. Version 2.1.1 uses 5,000 ms for new installations; existing installations retain their setting. If your deadline is still 2,500 ms, increase it to at least 5,000 ms for Vision.

## Detection and limits

Text mode looks for one readable question associated with native radio controls, ARIA radio groups, or sibling answer buttons. It tries standard HTTP/HTTPS webpages without platform-specific setup. Missing, ambiguous, disabled, or unsupported controls produce an explanation instead of a click. If the chosen answer is already selected, no click is needed.

Automatic clicks require answer controls in the main document. Controls inside frames or shadow roots and canvas-only answer controls can receive a visual suggestion for a manual click. Typed answers and multi-select questions are unsupported. Text mode needs readable text and semantic headings or labels; Vision can also read visible images and canvas-rendered questions. Arbitrary layouts and accurate visual targeting are not guaranteed. There is no manual selector configuration.

A changed question, replaced controls, or navigation invalidates a pending decision. Repeated presses while a request is running do not start another request. Failed or expired requests do not retry automatically. Press **Answer** to try again. The default API deadline is 5,000 ms and the minimum confidence is 0; increase the threshold to skip less confident choices. The model can answer incorrectly. Some sites reject programmatic clicks.

The popup retains the last chosen answer or suggestion for each tab until the extension worker restarts or the tab closes. Timings measure API duration and time from the request starting to the local click or suggestion, not grading or server receipt.

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

Tests load the extension in Chromium with simulated webpages, real screenshots, and mocked provider responses. They cover text selection, vision requests, screenshot scaling and padding, coordinate clicks, manual suggestion placement and click-through, suggestion cleanup, allowed canvas pixel changes, changed controls, tab switches, permissions, provider routing, and errors. They make no paid API calls. Live Kahoot compatibility, model accuracy, and image-request latency require separate verification.

An optional live smoke test loads the extension in a temporary Chromium profile, sends one synthetic quiz screenshot to the real provider, and checks for exactly one correct answer click and no Submit click. It makes one billed API request and reads the key from a private file without printing it:

```powershell
npm run test:vision:live -- openrouter "C:\path\to\private-key-file"
```

Use `typesafe` instead of `openrouter` for a direct TypeSafe key. Synthetic checks verify the full request and click path, not compatibility with a hosted quiz service.
