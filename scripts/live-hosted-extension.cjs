// Explicit billed smoke check against a deployed service. Never runs in npm test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const fixture = require('../tests/fixtures/vision.cjs');

async function main() {
  const [base, credentialFile] = process.argv.slice(2);
  assert.equal(new URL(base).protocol, 'https:');
  assert.equal(new URL(base).origin, base);
  const credential = fs.readFileSync(credentialFile, 'utf8').trim();
  if (!/^ci_[a-f0-9]{64}$/.test(credential)) throw new Error('The installation access key has an invalid format.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clickit-hosted-'));
  let context;
  try {
    const extension = path.join(directory, 'extension');
    fs.cpSync(path.resolve(__dirname, '../extension'), extension, { recursive: true });
    fs.writeFileSync(path.join(extension, 'config.js'), `globalThis.ClickItConfig = Object.freeze(${JSON.stringify({ apiUrl: base })});`);
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
    manifest.host_permissions.push(`${base}/*`);
    manifest.key = fs.readFileSync(path.resolve(__dirname, '../docs/chrome-web-store-public-key.pem'), 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
      channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
      args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = worker.url().split('/')[2];
    assert.equal(id, 'dfpglkafpdbnfecohhgmhkpceinhhpjl');
    await worker.evaluate(async credential => {
      await ClickItHosted.restore(credential);
      await ClickItHosted.register({ adultConsent: true, dataConsent: true });
    }, credential);
    const page = await context.newPage();
    await page.route('https://quiz.example/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto('https://quiz.example/hosted-validation');
    const session = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    await session.send('Extensions.triggerAction', { id, targetId: targetInfos.find(target => target.url === page.url()).targetId });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => !document.getElementById('saveSettings').disabled);
    for (const mode of ['text', 'vision']) {
      await page.goto('https://quiz.example/hosted-validation');
      if (mode === 'text') await page.evaluate(() => {
        document.body.innerHTML = '<form><fieldset><legend>What is 2 + 2?</legend><label><input id="option3" type="radio" name="answer" value="3">3</label><label><input id="option4" type="radio" name="answer" value="4">4</label></fieldset><button id="submit">Submit</button></form>';
        document.addEventListener('click', event => { if (event.target.type === 'radio') clicks[clicks.length - 1] = event.target.value; });
      });
      await page.evaluate(() => {
        document.addEventListener('submit', event => { submissions++; event.preventDefault(); }, true);
        HTMLFormElement.prototype.submit = function () { submissions++; };
        HTMLFormElement.prototype.requestSubmit = function () { submissions++; };
      });
      const saved = await popup.evaluate(settings => chrome.runtime.sendMessage({ type: 'save', settings }), { mode, billingMode: 'hosted', minConfidence: 0, timeoutMs: 15000 });
      assert.ok(saved.ok, saved.error);
      await page.evaluate(() => { clicks.length = 0; submissions = 0; });
      const before = await worker.evaluate(() => ClickItHosted.state(true));
      await page.bringToFront();
      const started = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'answer' }));
      assert.ok(started.ok, started.error);
      const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      const deadline = Date.now() + 30000;
      while (await worker.evaluate(id => jobs.has(id), tabId)) {
        assert.ok(Date.now() < deadline, 'Hosted answer did not finish.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const status = await worker.evaluate(id => statuses.get(id), tabId);
      assert.deepEqual(await page.evaluate(() => ({ clicks, submissions })), { clicks: ['4'], submissions: 0 }, status?.text);
      const after = await worker.evaluate(() => ClickItHosted.state(true));
      assert.equal(after.balance.credits, before.balance.credits - 1);
      assert.equal(after.balance.reserved, 0);
      console.log(JSON.stringify({ mode, storeId: id, selected: '4', submissions: 0, creditsConsumed: 1, apiMs: status.apiMs }));
    }
  } finally {
    if (context) await context.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
