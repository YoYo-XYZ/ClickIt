# ClickIt

ClickIt selects one answer to a visible single-choice text quiz question using Jev 1.14. Press **Answer** for each question. It clicks at most one answer option and stops. It never clicks a separate Submit button. A website may submit or advance automatically when you select an option.

## Install and use

1. Open Chrome or Edge's extensions page and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension` folder.
3. Open a quiz webpage, click ClickIt's toolbar icon, and open **Settings**.
4. Choose **TypeSafe** or **OpenRouter**, paste a key from that provider, and save.
5. Press **Answer**. Submit manually if the quiz requires it.

Reload the extension after updating its files. Version 2 removes automatic answering, typed answers, answer banks, and selector overrides. Existing provider credentials, confidence, and deadline settings are retained; obsolete settings are discarded.

## Detection and limits

ClickIt looks for one readable question associated with native radio controls, ARIA radio groups, or sibling answer buttons. It tries standard HTTP/HTTPS webpages without platform-specific setup. Missing, ambiguous, disabled, or unsupported controls produce an explanation instead of a click. If the chosen answer is already selected, no click is needed.

Only the main document is supported. Questions inside frames or shadow roots, image-only questions, typed answers, and multi-select questions are unsupported. Detection uses page headings, legends, and accessible labels; arbitrary layouts are not guaranteed to work. There is no manual selector configuration.

A changed question, replaced controls, or navigation invalidates a pending decision. Repeated presses while a request is running do not start another request. Failed or expired requests do not retry automatically. Press **Answer** to try again. The default API deadline is 2,500 ms and the minimum confidence is 0; increase the threshold to skip less confident choices. The model can answer incorrectly. Some sites reject programmatic clicks.

The popup retains the last chosen answer for each tab until the extension worker restarts or the tab closes. Timings measure API duration and time from the request starting to the local click, not grading or server receipt.

## Access and data

Page access uses Chrome's [activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), granted when you invoke the toolbar action. No quiz content script runs before you press Answer. Persistent host permissions cover only the two API providers.

The selected provider receives only the detected question and answer choices. TypeSafe uses `https://api.typesafe.ai/v1/systemone` with `jev-1.14.0`; OpenRouter uses `https://openrouter.ai/api/alpha/decisions` with `typesafe/jev-1.14`. Requests omit browser cookies. There is no provider fallback. API usage is billed by your provider.

The key is stored unencrypted in the browser profile's extension storage. Only trusted extension contexts can access it; page code and the injected detector never receive it. An HTTP 401 means you should check that the selected provider issued the saved key.

## Development

Node.js 22 or newer is required for tests; browser installation needs no build step.

```powershell
npm ci
npx playwright install chromium
npm test
```

Tests load the extension in Chromium with simulated webpages and mocked provider responses. They make no paid API calls. Live website compatibility and answer accuracy require separate verification.
