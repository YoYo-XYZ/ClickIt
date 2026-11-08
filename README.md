# ClickIt

Choose an answer to a visible single-choice quiz question with one click. Included AI credits or your own API key.

Version 3 includes a hosted service with 10 free suggestions and planned US$4.99 / 500-credit top-ups. The pilot runs at https://clickit.thammatorn-clickit.workers.dev with OpenRouter inference. Checkout and hosted Vision remain disabled until launch validation is complete.

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
- Edit prompts in **Settings**. **Reset** restores the default.

## Update without reinstalling

Update the same folder, then click **Reload** on ClickIt in `chrome://extensions`.

Hosted mode uses credits. Advanced API-key mode is billed by your provider. Vision sends the visible tab screenshot. Answers can be wrong.

## Deploy the monetized release

[Deployment, payments, validation, and operating guide](docs/LAUNCH.md) · [Store listing and launch materials](docs/STORE.md)

```powershell
npm ci
npm test
npm run check:worker
npm run package:extension -- --api-url https://YOUR-WORKER.workers.dev
```

The Worker serves the public pages and API from the same origin. A custom domain is optional. No API or payment secrets belong in the extension. Your deployment needs Cloudflare authentication, D1, provider and Stripe secrets, and the published extension origin before it can accept live customers.

[Help, privacy, and developer instructions](docs/REFERENCE.md)
