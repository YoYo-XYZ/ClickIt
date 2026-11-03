const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
let context, worker, extensionId;
const payload = (choice = 'a1', confidence = 0.97) => ({ model: 'jev-1.14.0', answers: { answer: { type: 'choice', choice, confidence } } });
const fixture = `<!doctype html><main data-slide-id="one"><h1>What is 2 + 2?</h1><div data-testid="answer-options"><button data-testid="answer-option">3</button><button data-testid="answer-option">4</button></div><button id="submit" disabled>Submit</button></main><script>
window.clicks=[];window.submissions=0;
document.addEventListener('click',e=>{if(e.target.matches('[data-testid="answer-option"],.option')){clicks.push(e.target.textContent);setTimeout(()=>document.getElementById('submit').disabled=false,20)}if(e.target.id==='submit'){submissions++;e.target.disabled=true}})
</script>`;
before(async () => {
  const extension = path.resolve(__dirname, '../extension');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
  await worker.evaluate(async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    globalThis.apiCalls = [];
    globalThis.mock = {};
    globalThis.fetch = async (url, init) => {
      const config = { ...globalThis.mock };
      globalThis.apiCalls.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, config.delay || 0);
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
      return new Response(JSON.stringify(config.body), { status: config.status || 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
});
after(async () => { await context?.close(); });
async function configure(overrides = {}, response = {}) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('timeoutMs').value !== '');
  await worker.evaluate(config => { globalThis.mock = config; globalThis.apiCalls = []; }, { body: payload(), ...response });
  const reply = await popup.evaluate(async overrides => chrome.runtime.sendMessage({ type: 'save', settings: {
    enabled: true, apiKey: 'fake-test-key', timeoutMs: 2500, settleMs: 0, ...overrides
  } }), overrides);
  assert.equal(reply.ok, true, reply.error);
  await popup.close();
}
async function open(html = fixture) {
  const page = await context.newPage();
  await page.route('https://www.menti.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://www.menti.com/test-quiz');
  return page;
}
async function status(page, expression) {
  await page.waitForFunction(expression, null, { timeout: 5000 });
}
async function calls() { return worker.evaluate(() => apiCalls); }
async function inspect(page) {
  const popup = await context.newPage();
  await page.bringToFront();
  const id = (await worker.evaluate(async () => (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url })))).find(t => t.url === page.url())?.id;
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // Read stored per-tab status directly without changing the production message checks.
  const result = await worker.evaluate(id => statuses.get(id), id);
  await popup.close();
  return result;
}
test('real extension sends the pinned API contract and clicks/submits once', async () => {
  await configure();
  const page = await open();
  try {
    await status(page, () => window.submissions === 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    const requests = await calls();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(requests[0].body.model, 'jev-1.14.0');
    assert.deepEqual(requests[0].body.questions.answer.criteria, { a0: '3', a1: '4' });
    await page.evaluate(() => { for (let i = 0; i < 30; i++) document.querySelector('h1').className = `tick${i}`; });
    await page.waitForTimeout(600);
    assert.equal((await calls()).length, 1);
    assert.equal(await page.evaluate(() => submissions), 1);
  } finally { await page.close(); }
});
test('late decisions cannot answer a later question', async () => {
  await configure({}, { delay: 250 });
  const page = await open();
  try {
    while (!(await calls()).length) await page.waitForTimeout(10);
    await page.evaluate(() => { document.querySelector('h1').textContent = 'What is 3 + 3?'; document.querySelectorAll('[data-testid="answer-option"]')[1].textContent = '6'; });
    await status(page, () => submissions === 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['6']);
  } finally { await page.close(); }
});
test('pausing during inference prevents the click', async () => {
  await configure({}, { delay: 400 });
  const page = await open();
  try {
    while (!(await calls()).length) await page.waitForTimeout(10);
    await configure({ enabled: false });
    await page.waitForTimeout(650);
    assert.deepEqual(await page.evaluate(() => clicks), []);
  } finally { await page.close(); }
});
test('disabled options are prefetched and answered when they unlock', async () => {
  await configure({ timeoutMs: 200 });
  const page = await open(fixture.replaceAll('<button data-testid="answer-option"', '<button disabled data-testid="answer-option"'));
  try {
    while (!(await calls()).length) await page.waitForTimeout(10);
    await page.waitForTimeout(400);
    assert.deepEqual(await page.evaluate(() => clicks), []);
    await page.evaluate(() => document.querySelectorAll('[data-testid="answer-option"]').forEach(n => n.disabled = false));
    await status(page, () => submissions === 1);
    assert.equal((await calls()).length, 1);
  } finally { await page.close(); }
});
test('rate limits do not cause a request storm', async () => {
  await configure({}, { status: 429 });
  const page = await open();
  try {
    await page.waitForTimeout(850);
    assert.equal((await calls()).length, 1);
    assert.equal(await page.evaluate(() => submissions), 0);
    assert.match((await inspect(page)).text, /rate limit/);
  } finally { await page.close(); }
});
test('confidence threshold and malformed responses never click', async () => {
  for (const body of [payload('a1', 0.2), payload('a9'), { ...payload(), model: 'jev-1.13.0' }]) {
    await configure({ minConfidence: 0.8 }, { body });
    const page = await open();
    try { await page.waitForTimeout(250); assert.deepEqual(await page.evaluate(() => clicks), []); }
    finally { await page.close(); }
  }
});
test('cached answers are reused and remapped when options reorder', async () => {
  await configure();
  const page = await open();
  try {
    await status(page, () => submissions === 1);
    await page.evaluate(() => document.querySelector('main').setAttribute('data-slide-id', 'two'));
    await status(page, () => submissions === 2);
    assert.equal((await calls()).length, 1);
    await worker.evaluate(body => { mock.body = body; }, payload('a0'));
    await page.evaluate(() => {
      const options = document.querySelectorAll('[data-testid="answer-option"]');
      options[0].textContent = '4'; options[1].textContent = '3';
      document.querySelector('main').setAttribute('data-slide-id', 'three');
    });
    await status(page, () => submissions === 3);
    assert.deepEqual(await page.evaluate(() => clicks), ['4', '4', '4']);
    assert.equal((await calls()).length, 2);
  } finally { await page.close(); }
});
test('typed answers use native input events and an exact answer bank', async () => {
  await configure({ answerBank: { 'What is 2 + 2?': '4' } });
  const page = await open(`<!doctype html><main><h1>What is 2 + 2?</h1><input aria-label="Your answer" type="text"><button id="submit" disabled>Submit</button></main><script>window.submissions=0;document.querySelector('input').addEventListener('input',()=>{window.received=document.querySelector('input').value;document.querySelector('button').disabled=false});document.querySelector('button').onclick=()=>submissions++;</script>`);
  try {
    await status(page, () => submissions === 1);
    assert.equal(await page.evaluate(() => received), '4');
    assert.equal((await calls()).length, 0);
  } finally { await page.close(); }
});
test('unknown typed questions stay unanswered', async () => {
  await configure();
  const page = await open('<main><h1>Unknown question?</h1><input type="text" aria-label="Your answer"><button>Submit</button></main>');
  try {
    await page.waitForTimeout(250);
    assert.equal(await page.locator('input').inputValue(), '');
    assert.equal((await calls()).length, 0);
  } finally { await page.close(); }
});
test('semantic sibling buttons work without test IDs', async () => {
  await configure();
  const page = await open(fixture.replaceAll('data-testid="answer-option"', 'class="option"').replace('data-testid="answer-options"', 'class="options"'));
  try { await status(page, () => submissions === 1); assert.deepEqual(await page.evaluate(() => clicks), ['4']); }
  finally { await page.close(); }
});
test('timeout is bounded and Retry can recover', async () => {
  await configure({ timeoutMs: 200 }, { delay: 600 });
  const page = await open();
  try {
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => submissions), 0);
    await worker.evaluate(() => { mock.delay = 0; });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === 'https://www.menti.com/test-quiz');
      await chrome.tabs.sendMessage(tab.id, { type: 'retry' });
    });
    await popup.close();
    await status(page, () => submissions === 1);
    assert.equal((await calls()).length, 2);
  } finally { await page.close(); }
});
test('popup saves settings and public settings exclude the API key', async () => {
  await configure({ enabled: false });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  try {
    await popup.waitForFunction(() => document.getElementById('timeoutMs').value !== '');
    await popup.getByText('Settings', { exact: true }).click();
    await popup.getByText('Advanced settings', { exact: true }).click();
    await popup.locator('#minConfidence').fill('0.3');
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await popup.waitForFunction(() => document.getElementById('message').textContent.includes('Saved.'));
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.minConfidence), 0.3);
    const page = await open();
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url === 'https://www.menti.com/test-quiz').id);
    const publicConfig = await worker.evaluate(() => MentiJev.publicSettings(settings));
    assert.equal('apiKey' in publicConfig, false);
    assert.ok(tabId);
    await page.close();
    await popup.setViewportSize({ width: 380, height: 650 });
    await popup.screenshot({ path: path.resolve(__dirname, '../test-results/popup.png'), fullPage: true });
  } finally { await popup.close(); }
});
test('OpenRouter routes credentials and decisions to its own endpoint', async () => {
  for (const model of ['typesafe/jev-1.14', 'typesafe/jev-1.14-20261014']) {
    await configure({ provider: 'openrouter', apiKey: '  Bearer fake-openrouter-key  ' }, { body: { ...payload(), model } });
    const page = await open();
    try {
      await status(page, () => submissions === 1);
      const requests = await calls();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(requests[0].body.model, 'typesafe/jev-1.14');
      assert.equal(requests[0].authorization, 'Bearer fake-openrouter-key');
      assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    } finally { await page.close(); }
  }
});
test('OpenRouter rejects answers from the wrong model family', async () => {
  await configure({ provider: 'openrouter' }, { body: { ...payload(), model: 'typesafe/jev-1.13-20260917' } });
  const page = await open();
  try {
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => clicks), []);
    assert.match((await inspect(page)).text, /did not return Jev 1.14/);
  } finally { await page.close(); }
});
test('401 gives provider-specific recovery instructions without reflecting secrets', async () => {
  await configure({ provider: 'openrouter' }, { status: 401, body: { error: { message: 'fake-test-key' } } });
  const page = await open();
  try {
    await page.waitForTimeout(350);
    const result = await inspect(page);
    assert.match(result.text, /OpenRouter rejected the API key \(HTTP 401\)/);
    assert.match(result.text, /Select the provider/);
    assert.doesNotMatch(result.text, /fake-test-key/);
    assert.equal((await calls()).length, 1);
    assert.deepEqual(await page.evaluate(() => clicks), []);
  } finally { await page.close(); }
});
test('provider selector persists and rejects unknown providers and malformed keys', async () => {
  await configure({ enabled: false });
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => document.getElementById('timeoutMs').value !== '');
    await popup.getByText('Settings', { exact: true }).click();
    await popup.locator('#provider').selectOption('openrouter');
    assert.equal(await popup.locator('#keyLabel').textContent(), 'OpenRouter API key');
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await popup.waitForFunction(() => document.getElementById('message').textContent.includes('Saved.'));
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('provider').value === 'openrouter');
    const errors = await worker.evaluate(() => ['unknown-provider', 'malformed-key'].map(kind => {
      try { MentiJev.validateSettings(kind === 'unknown-provider' ? { provider: 'elsewhere' } : { apiKey: 'two words' }); return ''; }
      catch (e) { return e.message; }
    }));
    assert.match(errors[0], /Select TypeSafe or OpenRouter/);
    assert.match(errors[1], /without spaces/);
    await popup.setViewportSize({ width: 380, height: 760 });
    await popup.screenshot({ path: path.resolve(__dirname, '../test-results/popup-openrouter.png'), fullPage: true });
  } finally { await popup.close(); }
});
async function controlsFor(page) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => !document.getElementById('answerNow').disabled);
  await page.bringToFront();
  return popup;
}
test('Answer handles exactly the current screen while Autopilot stays off', async () => {
  await configure({ enabled: false, provider: 'openrouter' }, { body: { ...payload(), model: 'typesafe/jev-1.14-20261014' } });
  const page = await open();
  const popup = await controlsFor(page);
  try {
    assert.equal(await popup.locator('#settingsPanel').getAttribute('open'), null);
    assert.equal(await popup.locator('#autopilot').getAttribute('aria-pressed'), 'false');
    await page.waitForTimeout(100);
    assert.equal((await calls()).length, 0);
    await popup.evaluate(() => document.getElementById('answerNow').click());
    await status(page, () => submissions === 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    assert.equal(await worker.evaluate(() => settings.enabled), false);
    await page.evaluate(() => {
      document.querySelector('h1').textContent = 'What is 3 + 3?';
      document.querySelectorAll('[data-testid="answer-option"]')[1].textContent = '6';
      document.querySelector('main').setAttribute('data-slide-id', 'two');
    });
    await page.waitForTimeout(600);
    assert.equal((await calls()).length, 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
  } finally { await popup.close(); await page.close(); }
});
test('manual answers are discarded when the screen changes during inference', async () => {
  await configure({ enabled: false }, { delay: 300 });
  const page = await open();
  const popup = await controlsFor(page);
  try {
    await popup.evaluate(() => document.getElementById('answerNow').click());
    while (!(await calls()).length) await page.waitForTimeout(10);
    await page.evaluate(() => { document.querySelector('h1').textContent = 'Different question?'; });
    await page.waitForTimeout(650);
    assert.deepEqual(await page.evaluate(() => clicks), []);
    assert.equal((await calls()).length, 1);
  } finally { await popup.close(); await page.close(); }
});
test('Autopilot toggles immediately and answers new questions until stopped', async () => {
  await configure({ enabled: false });
  const page = await open();
  const popup = await controlsFor(page);
  try {
    await popup.evaluate(() => document.getElementById('autopilot').click());
    await status(page, () => submissions === 1);
    assert.equal(await popup.locator('#autopilot').getAttribute('aria-pressed'), 'true');
    assert.equal(await worker.evaluate(() => settings.enabled), true);
    await page.evaluate(() => {
      document.querySelector('h1').textContent = 'What is 3 + 3?';
      document.querySelectorAll('[data-testid="answer-option"]')[1].textContent = '6';
    });
    await status(page, () => submissions === 2);
    await popup.evaluate(() => document.getElementById('autopilot').click());
    await popup.waitForFunction(() => document.getElementById('autopilot').getAttribute('aria-pressed') === 'false');
    await page.evaluate(() => { document.querySelector('h1').textContent = 'Third question?'; });
    await page.waitForTimeout(600);
    assert.equal((await calls()).length, 2);
    assert.equal(await page.evaluate(() => submissions), 2);
    await popup.setViewportSize({ width: 380, height: 410 });
    await popup.screenshot({ path: path.resolve(__dirname, '../test-results/simple-controls.png'), fullPage: true });
  } finally { await popup.close(); await page.close(); }
});
test('Answer reports a missing question without starting inference', async () => {
  await configure({ enabled: false });
  const page = await open('<main><h1>Waiting for presenter</h1></main>');
  const popup = await controlsFor(page);
  try {
    await popup.evaluate(() => document.getElementById('answerNow').click());
    await popup.waitForFunction(() => document.getElementById('message').textContent.includes('No readable question'));
    assert.equal((await calls()).length, 0);
  } finally { await popup.close(); await page.close(); }
});
test('Last chosen answer keeps only the latest selection and survives reopening the popup', async () => {
  await configure({ enabled: false });
  const page = await open();
  let popup = await controlsFor(page);
  try {
    await popup.evaluate(() => document.getElementById('answerNow').click());
    await status(page, () => submissions === 1);
    await popup.waitForFunction(() => document.getElementById('answer').textContent === '4');
    await page.evaluate(() => {
      document.querySelector('h1').textContent = 'What is 3 + 3?';
      document.querySelectorAll('[data-testid="answer-option"]')[1].textContent = '6';
      document.querySelector('main').setAttribute('data-slide-id', 'two');
    });
    await page.waitForTimeout(600);
    assert.equal(await popup.locator('#answer').textContent(), '4');
    await popup.evaluate(() => document.getElementById('answerNow').click());
    await status(page, () => submissions === 2);
    await popup.waitForFunction(() => document.getElementById('answer').textContent === '6');
    await popup.close();
    popup = await controlsFor(page);
    await popup.waitForFunction(() => document.getElementById('answer').textContent === '6');
    assert.equal(await popup.locator('.latest-answer strong').count(), 1);
    assert.equal(await popup.locator('.latest-answer').textContent(), 'Last chosen answer6');
    await popup.setViewportSize({ width: 380, height: 480 });
    await popup.screenshot({ path: path.resolve(__dirname, '../test-results/simple-controls-latest-answer.png'), fullPage: true });
  } finally { await popup.close(); await page.close(); }
});
