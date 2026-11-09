# ClickIt

Choose an answer to a visible single-choice quiz question with one click. Included AI credits or your own API key.

Version 1.0.0 includes a hosted service with 10 free suggestions and monthly subscriptions: Basic at US$4.99 for 500 credits and Plus at US$9.99 for 1,200 credits. The pilot runs at https://clickit.thammatorn-clickit.workers.dev with OpenRouter inference. Monthly credits expire at renewal. Checkout and hosted Vision remain disabled until launch validation is complete.

For the configured local pilot, load `dist/extension` in Chrome. The backend currently allows that folder's development extension ID. The source `extension` folder remains an unconfigured development build. Publish the Chrome Web Store extension and configure its assigned origin before distributing it to customers.

<p>
  <img src="docs/images/answer.png" width="300" align="top" alt="ClickIt with the Vision selector, Answer button, and status message">
  <img src="docs/images/settings.png" width="300" align="top" alt="Settings with the API provider, key, editable Vision prompt, Reset, and Save settings">
</p>

## Start in 3 steps

1. [Download ZIP](https://github.com/YoYo-XYZ/ClickIt/archive/refs/heads/main.zip) and extract it.
2. In `chrome://extensions`, enable **Developer mode**. Click **Load unpacked** and select the `extension` folder.
3. For the source development build, open **Settings**, choose **Advanced · your API key**, select your provider, paste your key, and save. Configured release builds offer **Start free trial** with included AI instead.

## Use it

- **Text** reads the page. **Vision** reads a screenshot. Keep the question and choices visible.
- Press **Answer** for each question. Click highlights yourself. Submit manually if needed.
- Use **Alt+Shift+A** to answer with the popup closed, using your saved Text or Vision mode. On macOS, use **Option+Shift+A**. Chrome may leave the shortcut unassigned if it conflicts. Check the actual **Answer hotkey** in Settings and click its green shortcut button to change or remove it in Chrome. Existing installations may keep their previous assignment.
- The toolbar badge shows `…` while answering, `✓` after selection, `!` when action is needed, or `ERR` on failure. Hover for status or open ClickIt for details.
- Edit prompts in **Settings**. **Reset** restores the default.

## Update without reinstalling

Update the same folder, then click **Reload** on ClickIt in `chrome://extensions`.

Hosted mode uses credits. Advanced API-key mode is billed by your provider. Vision sends the visible tab screenshot. Answers can be wrong.

## Deploy the monetized release

The [Worker configuration](server/wrangler.jsonc) defines the service gates, allowed extension origins, D1 binding, and Stripe price IDs. [Billing integration tests](scripts/test-subscriptions-stripe.cjs) cover Stripe test-clock validation.

```powershell
npm ci
npm test
npm run check:worker
npm run package:extension -- --api-url https://YOUR-WORKER.workers.dev
```

On Windows, `npm run test:hotkey:windows` opens a temporary Chromium profile and verifies real hotkeys in Text and Vision, duplicate protection, and shortcut remapping. It uses mocked AI responses and does not spend credits.

The Worker serves the public pages and API from the same origin. A custom domain is optional. No API or payment secrets belong in the extension. Your deployment needs Cloudflare authentication, D1, provider and Stripe secrets, and the published extension origin before it can accept live customers.

[Privacy](site/privacy.html) · [Terms](site/terms.html)
