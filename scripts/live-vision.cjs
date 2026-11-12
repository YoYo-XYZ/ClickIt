const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const fixture = require('../tests/fixtures/vision.cjs');

// Explicit opt-in: one real, billed API request. Credentials stay out of output and source files.
async function main() {
  const [provider, keyFile] = process.argv.slice(2);
  if (!['openrouter', 'typesafe'].includes(provider) || !keyFile) {
    throw new Error('Usage: npm run test:vision:live -- <openrouter|typesafe> <private-key-file>');
  }
  const apiKey = fs.readFileSync(keyFile, 'utf8').trim().replace(/^Bearer\s+/i, '');
  assert.ok(apiKey, 'The key file is empty.');
  const extension = path.resolve(__dirname, '../extension');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    const page = await context.newPage();
    await page.route('https://quiz.example/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://quiz.example/live-test');
    const session = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    await session.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(target => target.url === page.url()).targetId });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => loaded);
    const save = await popup.evaluate(settings => chrome.runtime.sendMessage({ type: 'save', settings }), {
      mode: 'vision', provider, apiKey, byokConsent: true, timeoutMs: 15000, minConfidence: 0
    });
    assert.ok(save.ok, save.error);
    await page.bringToFront();
    const start = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'answer' }));
    assert.ok(start.ok, start.error);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    const deadline = Date.now() + 25000;
    while (await worker.evaluate(id => jobs.has(id), tabId)) {
      assert.ok(Date.now() < deadline, 'Live request did not finish.');
      await delay(100);
    }
    const status = await worker.evaluate(id => statuses.get(id), tabId);
    const actions = await page.evaluate(() => ({ clicks, submissions }));
    assert.deepEqual(actions, { clicks: ['4'], submissions: 0 }, status?.text);
    console.log(JSON.stringify({ provider, answer: status.answer, confidence: status.confidence, apiMs: status.apiMs, ...actions }));
  } finally { await context.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
