// Headed Windows smoke test using real OS keystrokes and Chrome's shortcut editor.
// Uses a temporary browser profile, fake credentials, and mocked provider responses.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

async function main() {
  if (process.platform !== 'win32') throw new Error('This smoke test requires Windows.');
  const extension = path.resolve(__dirname, '../extension');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: false,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = worker.url().split('/')[2];
    await worker.evaluate(async () => {
      await ready;
      settings = ClickIt.validateSettings({ billingMode: 'byok', provider: 'typesafe', apiKey: 'fake-hotkey-test-key', byokConsent: true });
      globalThis.hotkeyCalls = 0;
      globalThis.hotkeyBody = { model: 'jev-1.14.0', answers: { answer: { type: 'choice', choice: 'a1', confidence: 1 } } };
      globalThis.fetch = async (_url, init) => {
        hotkeyCalls++;
        await new Promise(resolve => setTimeout(resolve, 400));
        init.signal.throwIfAborted();
        return new Response(JSON.stringify(hotkeyBody));
      };
    });
    const editor = await context.newPage();
    await editor.goto('chrome://extensions/shortcuts');
    const command = editor.locator('.command-entry').filter({ hasText: 'Answer the current question' });
    await command.getByRole('button', { name: 'Edit shortcut Answer the current question for ClickIt' }).click();
    await editor.keyboard.press('Control+Shift+Y');
    assert.equal(await worker.evaluate(async () => (await chrome.commands.getAll()).find(c => c.name === 'answer-question').shortcut), 'Ctrl+Shift+Y');

    const quiz = await context.newPage();
    const fixture = '<title>ClickIt native hotkey verification</title><main><h1>What is 2 + 2?</h1><div><button class="option">3</button><button class="option">4</button></div><button id="submit">Submit</button></main><script>window.clicks=[];window.submits=0;document.addEventListener("click",e=>{if(e.target.matches(".option"))clicks.push(e.target.textContent);if(e.target.id==="submit")submits++});</script>';
    await quiz.route('https://quiz.example/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await quiz.goto('https://quiz.example/text');
    const press = async (twice = false) => {
      await quiz.bringToFront();
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$hotkeyShell = New-Object -ComObject WScript.Shell; if (-not $hotkeyShell.AppActivate('ClickIt native hotkey verification')) { throw 'Cannot focus test browser' }; " +
        `$hotkeyShell.SendKeys('${twice ? '^+y^+y' : '^+y'}')`]);
    };
    await press(true);
    await quiz.waitForFunction(() => clicks.length === 1);
    assert.deepEqual(await quiz.evaluate(() => [clicks, submits]), [['4'], 0]);
    assert.equal(await worker.evaluate(() => hotkeyCalls), 1);
    const id = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), id), '✓');

    // A new document must receive activeTab access from the command itself.
    await quiz.unroute('https://quiz.example/**');
    await quiz.route('https://quiz.example/**', route => route.fulfill({ contentType: 'text/html',
      body: '<title>ClickIt native hotkey verification</title>' + require('../tests/fixtures/vision.cjs') }));
    await quiz.goto('https://quiz.example/vision');
    const body = await quiz.evaluate(() => {
      const scale = Math.min(1, 1568 / (innerWidth * devicePixelRatio), 1568 / (innerHeight * devicePixelRatio));
      const drawnWidth = Math.round(innerWidth * devicePixelRatio * scale), drawnHeight = Math.round(innerHeight * devicePixelRatio * scale);
      const width = Math.max(280, drawnWidth), height = Math.max(280, drawnHeight);
      const left = Math.floor((width - drawnWidth) / 2), top = Math.floor((height - drawnHeight) / 2);
      const box = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { type: 'box', confidence: 1, box: {
          left: (left + rect.left / innerWidth * drawnWidth) / width, right: (left + rect.right / innerWidth * drawnWidth) / width,
          top: (top + rect.top / innerHeight * drawnHeight) / height, bottom: (top + rect.bottom / innerHeight * drawnHeight) / height
        } };
      };
      return { model: 'jev-1.14.0', answers: { ready: { type: 'noul', noul: 1 },
        question: box('#question'), choices: box('#choices'), target: box('#option4') } };
    });
    await worker.evaluate(body => { settings = { ...settings, mode: 'vision' }; hotkeyBody = body; }, body);
    await press();
    const deadline = Date.now() + 10000;
    while (!await worker.evaluate(() => hotkeyCalls === 2 && jobs.size === 0)) {
      assert.ok(Date.now() < deadline, JSON.stringify(await worker.evaluate(() => [...statuses.values()])));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const status = await worker.evaluate(id => statuses.get(id), id);
    assert.equal(status?.answer, '4', JSON.stringify(status));
    assert.deepEqual(await quiz.evaluate(() => [clicks, submissions]), [['4'], 0]);
    assert.equal(await worker.evaluate(() => hotkeyCalls), 2);

    const controls = await context.newPage();
    await controls.goto(`chrome-extension://${extensionId}/popup.html`);
    await controls.locator('#settingsToggle').click();
    await controls.waitForFunction(() => document.getElementById('hotkeyValue').textContent === 'Ctrl+Shift+Y');
    await editor.bringToFront();
    await command.getByRole('button', { name: 'Edit shortcut Answer the current question for ClickIt' }).click();
    await command.locator('#clear').click();
    await controls.locator('#settingsToggle').click();
    await controls.locator('#settingsToggle').click();
    await controls.waitForFunction(() => document.getElementById('hotkeyValue').textContent === 'Not assigned');
    console.log('Passed native Text and Vision hotkeys without opening the popup, duplicate protection, toolbar feedback, browser remapping, and unassigned Settings display.');
  } finally { await context.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
