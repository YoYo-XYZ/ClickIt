const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
let context, worker, extensionId, browserSession, sequence = 0;
const payload = (choice = 'a1', confidence = 0.97, model = 'jev-1.14.0') => ({ model, answers: { answer: { type: 'choice', choice, confidence } } });
const fixture = `<!doctype html><main><h1>What is 2 + 2?</h1><div><button type="button" class="option">3</button><button type="button" class="option">4</button></div><button id="submit">Submit</button></main><script>
window.clicks=[];window.submissions=0;
document.addEventListener('click',e=>{if(e.target.matches('.option,input[type="radio"],[role="radio"]'))clicks.push(e.target.textContent||e.target.value);if(e.target.id==='submit')submissions++});
</script>`;

before(async () => {
  const extension = path.resolve(__dirname, '../extension');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
  browserSession = await context.browser().newBrowserCDPSession();
  await worker.evaluate(() => {
    globalThis.apiCalls = [];
    globalThis.captures = [];
    globalThis.mock = {};
    const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = async (...args) => { captures.push(args); return capture(...args); };
    globalThis.fetch = async (url, init) => {
      const config = { ...globalThis.mock };
      apiCalls.push({ url, body: JSON.parse(init.body), headers: init.headers, authorization: init.headers.Authorization, credentials: init.credentials });
      await new Promise((resolve, reject) => {
        if (init.signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(resolve, config.delay || 0);
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
      if (config.networkError) throw new TypeError('Network failed');
      return new Response(JSON.stringify(config.body), { status: config.status || 200 });
    };
  });
});
after(async () => { await context?.close(); });

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for extension');
    await delay(15);
  }
}
async function popup() {
  const page = await context.newPage();
  await page.setViewportSize({ width: 300, height: 520 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => loaded);
  return page;
}

async function configure(overrides = {}, response = {}) {
  await until(() => worker.evaluate(() => jobs.size === 0));
  const controls = await popup();
  try {
    await worker.evaluate(config => { globalThis.mock = config; globalThis.apiCalls = []; globalThis.captures = []; }, { body: payload(), ...response });
    const reply = await controls.evaluate(settings => chrome.runtime.sendMessage({ type: 'save', settings }), {
      provider: 'typesafe', apiKey: 'fake-test-key', byokConsent: true, timeoutMs: 2500, minConfidence: 0, ...overrides
    });
    assert.equal(reply.ok, true, reply.error);
  } finally { await controls.close(); }
}
async function open(html = fixture, origin = 'https://quiz.example', grant = true) {
  const page = await context.newPage();
  await page.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${origin}/question-${++sequence}`);
  if (grant) {
    // Trigger the real toolbar action to grant activeTab. The shipped manifest is unchanged.
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const target = targetInfos.find(target => target.url === page.url());
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  }
  return page;
}
async function tabId(page) {
  await page.bringToFront();
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
}
async function calls() { return worker.evaluate(() => apiCalls); }
async function start(page, controls) {
  await page.bringToFront();
  return controls.evaluate(() => chrome.runtime.sendMessage({ type: 'answer' }));
}
async function finished(page) {
  const id = await tabId(page);
  await until(() => worker.evaluate(id => !jobs.has(id), id));
  return worker.evaluate(id => statuses.get(id), id);
}
async function scenario(html, action, origin) {
  const page = await open(html, origin);
  const controls = await popup();
  try { await action(page, controls); }
  finally { await controls.close(); await page.close(); }
}

test('manifest has only user-triggered page access; old settings are discarded', async () => {
  const manifest = require('../extension/manifest.json');
  assert.deepEqual(manifest.commands['answer-question'], {
    suggested_key: { default: 'Alt+Shift+A', mac: 'Alt+Shift+A' },
    description: 'Answer the current question'
  });
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting']);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.host_permissions, ['https://api.typesafe.ai/*', 'https://openrouter.ai/*', 'https://clickit.thammatorn-clickit.workers.dev/*']);
  await configure({ enabled: true, answerBank: { Question: 'Answer' }, questionSelector: 'h1', settleMs: 8 });
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(Object.keys(saved).sort(), ['apiKey', 'billingMode', 'byokConsent', 'minConfidence', 'mode', 'provider', 'textPrompt', 'timeoutMs', 'visionPrompt']);
  assert.equal(saved.billingMode, 'byok');
  assert.equal(saved.mode, 'text');
  assert.equal(saved.apiKey, 'fake-test-key');
});

test('API-key users must explicitly accept disclosure before answering, and changing provider clears consent', async () => {
  await configure({ byokConsent: false });
  await scenario(fixture, async (page, controls) => {
    const reply = await start(page, controls);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /data sharing disclosure/);
    assert.equal((await calls()).length, 0);
    assert.equal(await worker.evaluate(() => captures.length), 0);
    await controls.locator('#answerNow').click();
    await controls.locator('#byokConsent').waitFor({ state: 'visible' });
    assert.equal(await controls.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await controls.locator('#byokConsent').isChecked(), false);
    assert.equal(await controls.getByText('Data sharing details', { exact: true }).count(), 0);
    const consent = controls.locator('label').filter({ has: controls.locator('#byokConsent') });
    assert.match(await consent.textContent(), /I'm 18\+ and accept the Terms\. See the Clickit, OpenRouter, and TypeSafe privacy policies\./);
    assert.equal(await controls.locator('#byokDisclosure').count(), 0);
    for (const name of ['Clickit', 'Terms', 'OpenRouter', 'TypeSafe privacy policies']) {
      assert.equal(await consent.getByRole('link', { name, exact: true }).isVisible(), true);
    }
    await controls.locator('#byokConsent').check();
    await finishEditing(controls);
    await until(() => worker.evaluate(() => settings.byokConsent));
    await start(page, controls);
    assert.equal((await finished(page)).answer, '4');
    await controls.locator('#settingsToggle').click();
    await controls.locator('#provider').selectOption('openrouter');
    assert.equal(await controls.locator('#byokConsent').isChecked(), false);
    await finishEditing(controls);
    await until(() => worker.evaluate(() => !settings.byokConsent));
    await controls.reload();
    await controls.locator('#settingsToggle').click();
    assert.equal(await controls.locator('#byokConsent').isChecked(), false);
    assert.equal((await start(page, controls)).ok, false);
    assert.equal((await calls()).length, 1);
  });
});

test('Answer makes one click, never submits, and never follows new questions', async () => {
  await configure();
  await scenario(fixture, async (page, controls) => {
    await page.bringToFront();
    await delay(100);
    assert.equal((await calls()).length, 0);
    assert.equal(await page.evaluate(() => window.ClickItPage), undefined);
    assert.equal((await start(page, controls)).ok, true);
    const result = await finished(page);
    assert.equal(result.answer, '4');
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    assert.equal(await page.evaluate(() => submissions), 0);
    const [request] = await calls();
    assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.body.model, 'jev-1.14.0');
    assert.deepEqual(request.body.state, { question: 'What is 2 + 2?' });
    assert.deepEqual(request.body.questions.answer.criteria, { a0: '3', a1: '4' });
    assert.equal(request.credentials, 'omit');
    await page.evaluate(() => { document.querySelector('h1').textContent = 'What is 3 + 3?'; document.querySelectorAll('.option')[1].textContent = '6'; });
    await delay(600);
    assert.equal((await calls()).length, 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    await start(page, controls);
    assert.equal((await finished(page)).answer, '6');
    assert.deepEqual(await page.evaluate(() => clicks), ['4', '6']);
    assert.equal(await page.evaluate(() => submissions), 0);
  });
});

test('detection works on unrelated HTTP and HTTPS sites with plain sibling buttons', async () => {
  for (const origin of ['http://study.example', 'https://another-quiz.example']) {
    await configure();
    await scenario(fixture, async (page, controls) => {
      await start(page, controls);
      assert.equal((await finished(page)).answer, '4');
      assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    }, origin);
  }
});

test('native labelled radios and ARIA radio groups select once and skip an already-selected answer', async () => {
  const layouts = [
    '<fieldset><legend>What is 2 + 2?</legend><label><input type="radio" name="answer" value="3">3</label><label><input type="radio" name="answer" value="4">4</label></fieldset>',
    '<p id="question">What is 2 + 2?</p><div role="radiogroup" aria-labelledby="question"><div role="radio" aria-checked="false">3</div><div role="radio" aria-checked="false">4</div></div>'
  ];
  for (const layout of layouts) {
    await configure();
    const html = fixture.replace(/<main>.*<\/main>/, `<main>${layout}</main>`);
    await scenario(html, async (page, controls) => {
      await start(page, controls);
      assert.equal((await finished(page)).answer, '4');
      assert.equal(await page.evaluate(() => clicks.length), 1);
      await page.evaluate(() => { const node = document.querySelectorAll('input,[role="radio"]')[1]; if (node.matches('input')) node.checked = true; else node.setAttribute('aria-checked', 'true'); });
      await start(page, controls);
      assert.match((await finished(page)).text, /already selected/);
      assert.equal(await page.evaluate(() => clicks.length), 1);
    });
  }
});

test('missing, ambiguous, multi-select, typed, image-only, and disabled questions do not call the API', async () => {
  const layouts = [
    '<main><h1>Waiting</h1></main>',
    '<main><h1>Question?</h1><textarea></textarea></main>',
    '<main><h1>Pick several</h1><label><input type="checkbox">A</label><label><input type="checkbox">B</label><button>Submit</button></main>',
    '<main><h1>Pick one</h1><div><button><img src="a.png"></button><button><img src="b.png"></button></div></main>',
    fixture.replaceAll('class="option"', 'class="option" disabled'),
    fixture.replace('>3</button>', '>4</button>'),
    fixture.replace('</main>', '<section><h2>Another question?</h2><div><button>A</button><button>B</button></div></section></main>'),
    fixture.replace('<h1>What is 2 + 2?</h1>', '<h1>Question one?</h1><h2>Question two?</h2>')
  ];
  for (const html of layouts) {
    await configure();
    await scenario(html, async (page, controls) => {
      await start(page, controls);
      const result = await finished(page);
      assert.match(result.text, /unsupported|Multiple|ambiguous|disabled/);
      await controls.evaluate(() => refresh());
      assert.equal(await controls.locator('#status').getAttribute('role'), 'alert');
      assert.equal(await controls.locator('#answerResult').count(), 0);
      assert.equal((await calls()).length, 0);
    });
  }
});

test('hidden controls and navigation are excluded from choices', async () => {
  await configure();
  await scenario(fixture.replace('<main>', '<nav><button>Home</button><button>Account</button></nav><main>')
    .replace('<button type="button" class="option">3', '<button hidden class="option">hidden</button><button type="button" class="option">3'), async (page, controls) => {
    await start(page, controls);
    await finished(page);
    assert.deepEqual((await calls())[0].body.questions.answer.criteria, { a0: '3', a1: '4' });
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
  });
});

test('changes and replaced controls invalidate a pending decision without answering a later question', async () => {
  const changes = [
    () => { document.querySelector('h1').textContent = 'Different question?'; },
    () => { document.querySelectorAll('.option')[1].textContent = 'Different answer'; },
    () => { const node = document.querySelectorAll('.option')[1]; node.replaceWith(node.cloneNode(true)); },
    () => { document.querySelectorAll('.option')[1].disabled = true; },
    () => { document.querySelector('main').setAttribute('data-slide-id', 'next'); },
    () => { history.pushState({}, '', '/next-question'); }
  ];
  for (const change of changes) {
    await configure({}, { delay: 200 });
    await scenario(fixture, async (page, controls) => {
      await start(page, controls);
      await until(async () => (await calls()).length === 1);
      const originalUrl = page.url();
      await page.evaluate(change);
      const result = await finished(page);
      if (page.url() !== originalUrl) assert.equal(result, undefined);
      else assert.match(result.text, /changed/);
      assert.deepEqual(await page.evaluate(() => clicks), []);
      assert.equal((await calls()).length, 1);
    });
  }
});

test('navigation to an identical question cannot receive the old decision', async () => {
  await configure({}, { delay: 200 });
  await scenario(fixture, async (page, controls) => {
    await start(page, controls);
    await until(async () => (await calls()).length === 1);
    await page.goto(`${new URL(page.url()).origin}/replacement`);
    await finished(page);
    assert.deepEqual(await page.evaluate(() => clicks), []);
    assert.equal((await calls()).length, 1);
  });
});

test('repeated requests are rejected while busy and closing the popup does not cancel the authorized click', async () => {
  await configure({}, { delay: 200 });
  const page = await open();
  const controls = await popup();
  try {
    const replies = await Promise.all([start(page, controls), start(page, controls)]);
    assert.equal(replies.filter(reply => reply.ok).length, 1);
    assert.match(replies.find(reply => !reply.ok).error, /Already answering/);
    await controls.close();
    await finished(page);
    assert.equal((await calls()).length, 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
  } finally { if (!controls.isClosed()) await controls.close(); await page.close(); }
});

test('confidence and response validation prevent invalid clicks', async () => {
  const bodies = [payload('a1', 0.2), payload('a9'), payload('a1', 2), payload('bad'), payload('a1', 0.9, 'jev-1.13.0')];
  for (const body of bodies) {
    await configure({ minConfidence: 0.8 }, { body });
    await scenario(fixture, async (page, controls) => {
      await start(page, controls);
      assert.match((await finished(page)).text, /threshold|invalid|did not return/);
      assert.deepEqual(await page.evaluate(() => clicks), []);
    });
  }
});

test('timeouts and rate limits stop; another explicit press retries', async () => {
  for (const response of [{ delay: 600 }, { status: 429 }, { networkError: true }]) {
    await configure({ timeoutMs: 200 }, response);
    await scenario(fixture, async (page, controls) => {
      await start(page, controls);
      assert.match((await finished(page)).text, /expired|rate limit|Cannot reach/);
      await delay(300);
      assert.equal((await calls()).length, 1);
      assert.deepEqual(await page.evaluate(() => clicks), []);
      await worker.evaluate(body => { mock = { body }; }, payload());
      await start(page, controls);
      assert.equal((await finished(page)).answer, '4');
      assert.equal((await calls()).length, 2);
      assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    });
  }
});

test('OpenRouter keeps its credentials and pinned model contract', async () => {
  for (const model of ['typesafe/jev-1.14', 'typesafe/jev-1.14-20261014']) {
    await configure({ provider: 'openrouter', apiKey: ' Bearer fake-openrouter-key ' }, { body: payload('a1', 0.97, model) });
    await scenario(fixture, async (page, controls) => {
      await start(page, controls);
      assert.equal((await finished(page)).answer, '4');
      const [request] = await calls();
      assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(request.body.model, 'typesafe/jev-1.14');
      assert.equal(request.authorization, 'Bearer fake-openrouter-key');
    });
  }
  await configure({ provider: 'openrouter' }, { body: payload('a1', 0.9, 'typesafe/jev-1.13') });
  await scenario(fixture, async (page, controls) => {
    await start(page, controls);
    assert.match((await finished(page)).text, /did not return Jev 1.14/);
    assert.deepEqual(await page.evaluate(() => clicks), []);
  });
});

test('authentication errors do not echo provider response bodies or secrets', async () => {
  await configure({ provider: 'openrouter' }, { status: 401, body: { error: 'fake-test-key' } });
  await scenario(fixture, async (page, controls) => {
    await start(page, controls);
    const result = await finished(page);
    assert.match(result.text, /OpenRouter rejected the API key \(HTTP 401\)/);
    assert.doesNotMatch(result.text, /fake-test-key/);
    assert.deepEqual(await page.evaluate(() => clicks), []);
  });
});

test('popup saves lean settings and reopens without answer history', async () => {
  await configure({ minConfidence: 0.3, timeoutMs: 5000 });
  await scenario(fixture, async (page, controls) => {
    assert.equal(await controls.locator('#autopilot,#answerBank').count(), 0);
    assert.equal(await controls.locator('html').evaluate(node => node.getBoundingClientRect().width), 300);
    assert.equal(await controls.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await controls.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await controls.locator('#settingsToggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await controls.locator('#answerNow').isVisible(), false);
    assert.equal(await controls.locator('.status').isVisible(), false);
    await controls.screenshot({ path: path.resolve(__dirname, '../test-results/popup-settings.png'), fullPage: true });
    assert.equal(await controls.locator('#minConfidence,#timeoutMs').count(), 0);
    await finishEditing(controls);
    assert.equal(await controls.locator('#settingsPanel').isVisible(), false);
    assert.equal(await controls.locator('#answerNow').isVisible(), true);
    assert.equal(await controls.locator('.status').isVisible(), true);
    assert.deepEqual(await worker.evaluate(() => [settings.minConfidence, settings.timeoutMs]), [0.3, 5000]);
    await page.bringToFront();
    await controls.evaluate(() => document.getElementById('answerNow').click());
    await finished(page);
    await controls.waitForFunction(() => document.getElementById('answer').textContent === '4');
    await page.evaluate(() => { document.querySelector('h1').textContent = 'What is 3 + 3?'; document.querySelectorAll('.option')[1].textContent = '6'; });
    await start(page, controls);
    await finished(page);
    const reopened = await popup();
    try {
      await page.bringToFront();
      assert.equal(await reopened.locator('#answerResult').count(), 0);
      await reopened.screenshot({ path: path.resolve(__dirname, '../test-results/popup.png'), fullPage: true });
    } finally { await reopened.close(); }
  });
});

test('ungranted and restricted pages fail cleanly; page contexts cannot access settings or start inference', async () => {
  await configure();
  const page = await open(fixture, 'https://ungranted.example', false);
  const controls = await popup();
  try {
    await start(page, controls);
    assert.match((await finished(page)).text, /Cannot access this page/);
    assert.equal((await calls()).length, 0);
    await page.goto('chrome://version');
    const reply = await start(page, controls);
    assert.match(reply.ok ? (await finished(page)).text : reply.error, /regular webpage|Cannot access/);
    assert.equal((await calls()).length, 0);
  } finally { await controls.close(); await page.close(); }
  await scenario(fixture, async (page) => {
    const id = await tabId(page);
    const [result] = await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: async () => {
      const denied = [];
      for (const type of ['inspect', 'answer']) {
        try { denied.push(await chrome.runtime.sendMessage({ type }) === undefined); }
        catch { denied.push(true); }
      }
      try { await chrome.storage.local.get('settings'); denied.push(false); } catch { denied.push(true); }
      return denied;
    } }), id);
    assert.deepEqual(result.result, [true, true, true]);
    assert.equal((await calls()).length, 0);
  });
});

test('AI access segments support keyboard switching and persist the selected billing mode', async () => {
  await configure();
  const controls = await popup();
  try {
    await controls.getByRole('button', { name: 'Settings', exact: true }).click();
    const included = controls.getByRole('radio', { name: 'Clickit', exact: true });
    const ownKey = controls.getByRole('radio', { name: 'Your API key', exact: true });
    assert.equal(await ownKey.isChecked(), true);
    await ownKey.focus();
    await controls.keyboard.press('ArrowLeft');
    assert.equal(await included.isChecked(), true);
    assert.equal(await controls.locator('#hostedPanel').isVisible(), true);
    assert.equal(await controls.locator('#byokSettings').isHidden(), true);
    await finishEditing(controls);
    assert.equal(await worker.evaluate(() => settings.billingMode), 'hosted');
    assert.equal(await controls.locator('#hostedPanel').isVisible(), false);
    await controls.reload();
    await controls.waitForFunction(() => loaded);
    await controls.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await included.isChecked(), true);
    await included.focus();
    await controls.keyboard.press('ArrowRight');
    assert.equal(await ownKey.isChecked(), true);
    assert.equal(await controls.locator('#hostedPanel').isVisible(), false);
    assert.equal(await controls.locator('#apiKey').isVisible(), true);
    assert.equal(await controls.locator('#apiKey').inputValue(), 'fake-test-key');
    assert.equal((await calls()).length, 0);
  } finally { await controls.close(); }
});

test('API key settings remain visible with saved credentials and consent', async () => {
  await configure();
  const controls = await popup();
  try {
    await controls.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await controls.getByRole('heading', { name: 'API key', exact: true }).isVisible(), true);
    assert.equal(await controls.locator('#provider').isVisible(), true);
    assert.equal(await controls.locator('#apiKey').isVisible(), true);
    assert.equal(await controls.locator('#byokConsent').isVisible(), true);
    assert.equal(await controls.locator('#byokConsent').isChecked(), true);
    assert.equal(await controls.locator('#byokSettings').getByRole('link', { name: 'Clickit', exact: true }).isVisible(), true);
    assert.equal(await controls.locator('#byokSettings').getByRole('link', { name: 'OpenRouter', exact: true }).isVisible(), true);
    await finishEditing(controls);
    assert.equal(await worker.evaluate(() => settings.apiKey), 'fake-test-key');
    assert.equal(await worker.evaluate(() => settings.byokConsent), true);
    assert.equal((await calls()).length, 0);
  } finally { await controls.close(); }
});

test('hotkey settings show actual assignments in both billing modes and open Chrome shortcut settings', async () => {
  await configure();
  const controls = await popup();
  try {
    await controls.evaluate(() => {
      globalThis.testShortcut = 'Alt+Shift+Y';
      chrome.commands.getAll = async () => [{ name: 'answer-question', shortcut: testShortcut }];
      chrome.tabs.create = async options => { globalThis.shortcutPage = options.url; };
    });
    for (const [mode, shortcut] of [['byok', 'Alt+Shift+Y'], ['hosted', '']]) {
      await controls.evaluate(shortcut => { testShortcut = shortcut; }, shortcut);
      await controls.locator('#settingsToggle').click();
      await controls.locator(`input[name="billingMode"][value="${mode}"]`).check();
      await controls.waitForFunction(value => document.getElementById('hotkeyValue').textContent === value, shortcut || 'Not assigned');
      assert.equal(await controls.locator('#hotkeyValue').isVisible(), true);
      assert.equal(await controls.locator('#answerShortcut').isVisible(), false);
      await controls.locator('#changeShortcut').click();
      assert.equal(await controls.evaluate(() => shortcutPage), 'chrome://extensions/shortcuts');
      await controls.locator('#settingsToggle').click();
      assert.equal(await controls.locator('#answerShortcut').textContent(), shortcut || '');
    }
  } finally { await controls.close(); }
});

test('toolbar reports popup runs, keeps busy feedback on opening, and clears completed feedback only on opening or navigation', async () => {
  await configure({}, { delay: 350 });
  await scenario(fixture, async (page, controls) => {
    const id = await tabId(page);
    const badge = () => worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), id);
    await start(page, controls);
    assert.equal(await badge(), '…');
    await controls.evaluate(() => refresh(true));
    assert.equal(await badge(), '…');
    await finished(page);
    assert.equal(await badge(), '✓');
    await controls.evaluate(() => refresh());
    assert.equal(await badge(), '✓');
    await controls.evaluate(() => refresh(true));
    assert.equal(await badge(), '');
    await worker.evaluate(() => { mock.status = 429; });
    await start(page, controls);
    await finished(page);
    assert.equal(await badge(), 'ERR');
    assert.match(await worker.evaluate(id => chrome.action.getTitle({ tabId: id }), id), /rate limit/);
    await page.reload();
    assert.equal(await badge(), '');
  });
});

const visionFixture = require('./fixtures/vision.cjs');

async function visionResponse(page, target = '#option4') {
  return page.evaluate(target => {
    // Convert known fixture rectangles into the model's image coordinate system, including padding.
    const scale = Math.min(1, 1568 / (innerWidth * devicePixelRatio), 1568 / (innerHeight * devicePixelRatio));
    const drawnWidth = Math.round(innerWidth * devicePixelRatio * scale), drawnHeight = Math.round(innerHeight * devicePixelRatio * scale);
    const width = Math.max(280, drawnWidth), height = Math.max(280, drawnHeight);
    const left = Math.floor((width - drawnWidth) / 2), top = Math.floor((height - drawnHeight) / 2);
    const box = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { type: 'box', confidence: 0.98, box: {
        left: (left + rect.left / innerWidth * drawnWidth) / width, right: (left + rect.right / innerWidth * drawnWidth) / width,
        top: (top + rect.top / innerHeight * drawnHeight) / height, bottom: (top + rect.bottom / innerHeight * drawnHeight) / height
      } };
    };
    return { model: 'jev-1.14.0', answers: { ready: { type: 'noul', noul: 0.99 },
      question: box('#question'), choices: box('#choices'), target: box(target) } };
  }, target);
}
async function mockVision(page, mutate = body => body) {
  await worker.evaluate(body => { mock.body = body; }, mutate(await visionResponse(page)));
}

test('mode switches stay responsive during slow saves and persist the final choice before answering', async () => {
  await configure({ mode: 'text' });
  const controls = await popup();
  try {
    await controls.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.modeRequests = [];
      globalThis.answerModes = [];
      globalThis.disabledChanges = [];
      new MutationObserver(records => {
        disabledChanges.push(...records.map(record => record.target.id));
      }).observe(document.querySelector('body'), { subtree: true, attributes: true, attributeFilter: ['disabled'] });
      chrome.runtime.sendMessage = async message => {
        if (message.type === 'save') {
          modeRequests.push(message.settings.mode);
          await new Promise(resolve => { globalThis.releaseModeSave = resolve; });
        }
        if (message.type === 'answer') {
          answerModes.push((await original({ type: 'inspect' })).data.settings.mode);
          return { ok: true };
        }
        return original(message);
      };
    });
    const vision = controls.getByRole('radio', { name: 'Vision', exact: true });
    const text = controls.getByRole('radio', { name: 'Text', exact: true });
    const initialBox = await controls.locator('#mode').boundingBox();
    await vision.check();
    await controls.waitForFunction(() => modeRequests.length === 1);
    assert.equal(await vision.isEnabled(), true);
    assert.equal(await controls.getByRole('button', { name: 'Answer', exact: true }).isEnabled(), true);
    assert.equal(await controls.locator('#visionPrompt').evaluate(el => el.hidden), false);
    assert.deepEqual(await controls.locator('#mode').boundingBox(), initialBox);
    assert.deepEqual(await controls.evaluate(() => disabledChanges), []);
    assert.equal(await controls.locator('#mode').evaluate(el => getComputedStyle(el).opacity), '1');
    await text.check();
    await vision.check();
    await text.check();
    assert.equal(await text.isChecked(), true);
    await controls.evaluate(() => releaseModeSave());
    await controls.waitForFunction(() => modeRequests.length === 2);
    assert.deepEqual(await controls.evaluate(() => modeRequests), ['vision', 'text']);
    await controls.getByRole('button', { name: 'Answer', exact: true }).click();
    assert.deepEqual(await controls.evaluate(() => answerModes), []);
    await controls.evaluate(() => releaseModeSave());
    await controls.waitForFunction(() => answerModes.length === 1);
    assert.deepEqual(await controls.evaluate(() => answerModes), ['text']);
    assert.equal(await worker.evaluate(() => settings.mode), 'text');
  } finally { await controls.close(); }
});

test('a failed mode save restores the saved selection and prompt', async () => {
  await configure({ mode: 'text' });
  const controls = await popup();
  try {
    await controls.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = message => message.type === 'save'
        ? Promise.resolve({ ok: false, error: 'Mode save failed.' }) : original(message);
    });
    await controls.getByRole('radio', { name: 'Vision', exact: true }).click();
    await controls.waitForFunction(() => document.getElementById('message').textContent === 'Mode save failed.');
    assert.equal(await controls.getByRole('radio', { name: 'Text', exact: true }).isChecked(), true);
    assert.equal(await controls.locator('#textPrompt').evaluate(el => el.hidden), false);
    assert.equal(await worker.evaluate(() => settings.mode), 'text');
  } finally { await controls.close(); }
});

test('Vision reads a real screenshot where Text detection fails, makes one click, and sends no extracted HTML', async () => {
  await configure();
  await scenario(visionFixture, async (page, controls) => {
    await start(page, controls);
    assert.match((await finished(page)).text, /unsupported/);
    assert.equal((await calls()).length, 0);
    const visionToggle = controls.getByRole('radio', { name: 'Vision', exact: true });
    const textToggle = controls.getByRole('radio', { name: 'Text', exact: true });
    await visionToggle.check();
    await until(() => worker.evaluate(() => settings.mode === 'vision'));
    await visionToggle.focus();
    await visionToggle.press('ArrowLeft');
    await until(() => worker.evaluate(() => settings.mode === 'text'));
    assert.equal(await textToggle.isChecked(), true);
    await textToggle.press('ArrowRight');
    await until(() => worker.evaluate(() => settings.mode === 'vision'));
    assert.equal(await visionToggle.isChecked(), true);
    await mockVision(page);
    await start(page, controls);
    assert.equal((await finished(page)).answer, '4');
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    assert.equal(await page.evaluate(() => submissions), 0);
    const [request] = await calls();
    assert.equal(request.headers['TypeSafe-Danger-Zone-Images'], 'true');
    assert.deepEqual(Object.keys(request.body.state), ['screen']);
    const asset = request.body.assets[request.body.state.screen];
    assert.equal(asset.type, 'image');
    assert.equal(asset.format, 'png');
    const png = Buffer.from(asset.data_base64, 'base64');
    assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.ok(png.length > 1000);
    assert.ok(png.readUInt32BE(16) >= 280 && png.readUInt32BE(16) <= 1568);
    assert.ok(png.readUInt32BE(20) >= 280 && png.readUInt32BE(20) <= 1568);
    assert.equal(request.body.questions.ready.type, 'noul');
    assert.equal(request.body.questions.target.type, 'box');
    assert.equal(await worker.evaluate(() => captures.length), 1);
    const reopened = await popup();
    try {
      assert.equal(await reopened.getByRole('radio', { name: 'Vision', exact: true }).isChecked(), true);
      assert.equal(await reopened.getByRole('radio', { name: 'Text', exact: true }).isChecked(), false);
      await reopened.screenshot({ path: path.resolve(__dirname, '../test-results/vision-popup.png'), fullPage: true });
    } finally { await reopened.close(); }
    await page.evaluate(() => { document.getElementById('question').textContent = 'Another question?'; });
    await delay(100);
    assert.equal((await calls()).length, 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
  });
});

test('Vision maps resized, padded, and high-DPI screenshots to the correct page coordinates', async () => {
  const sizes = [{ width: 2200, height: 1200 }, { width: 240, height: 720 }, { width: 1000, height: 700, dpi: 2 }];
  for (const size of sizes) {
    await configure({ mode: 'vision' });
    await scenario(visionFixture, async (page, controls) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      if (size.dpi) {
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.dpi, mobile: false });
      }
      await mockVision(page);
      await start(page, controls);
      const result = await finished(page);
      assert.equal(result.answer, '4', result.text);
      assert.deepEqual(await page.evaluate(() => clicks), ['4']);
      const asset = Object.values((await calls())[0].body.assets)[0];
      const png = Buffer.from(asset.data_base64, 'base64');
      assert.ok(png.readUInt32BE(16) >= 280 && png.readUInt32BE(16) <= 1568);
      assert.ok(png.readUInt32BE(20) >= 280 && png.readUInt32BE(20) <= 1568);
    });
  }
});

test('Vision ignores a countdown outside the question and answer regions', async () => {
  await configure({ mode: 'vision' }, { delay: 200 });
  await scenario(visionFixture, async (page, controls) => {
    await mockVision(page);
    await start(page, controls);
    await until(async () => (await calls()).length === 1);
    await page.evaluate(() => { window.tick = setInterval(() => { document.getElementById('timer').textContent = String(Math.random()); }, 30); });
    assert.equal((await finished(page)).answer, '4');
    await page.evaluate(() => clearInterval(window.tick));
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
  });
});

test('Vision allows cosmetic stylesheet and page-attribute updates during inference', async () => {
  const changes = [
    () => { document.querySelector('style').textContent += '\n#timer { color: red; }'; },
    () => { document.querySelector('style').textContent += '\n#question { color: red; } #choices button:hover { background: yellow; }'; },
    () => { document.body.setAttribute('data-countdown', '19'); }
  ];
  for (const change of changes) {
    await configure({ mode: 'vision' }, { delay: 200 });
    await scenario(visionFixture, async (page, controls) => {
      await mockVision(page);
      await start(page, controls);
      await until(async () => (await calls()).length === 1);
      await page.evaluate(change);
      const result = await finished(page);
      assert.equal(result.answer, '4', result.text);
      assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    });
  }
});

test('Vision cancels changed questions, choices, target controls, scrolling, resizing, and navigation', async () => {
  const changes = [
    page => page.evaluate(() => { document.getElementById('question').textContent = 'A different question?'; }),
    page => page.evaluate(() => { document.getElementById('option1').textContent = 'Different'; }),
    page => page.evaluate(() => { const node = document.getElementById('option4'); node.replaceWith(node.cloneNode(true)); }),
    page => page.evaluate(() => { document.getElementById('option4').disabled = true; }),
    page => page.evaluate(() => scrollTo(0, 100)),
    page => page.setViewportSize({ width: 1300, height: 740 }),
    page => page.keyboard.press('a'),
    page => page.evaluate(() => history.pushState({}, '', '/another-question')),
    page => page.reload()
  ];
  for (const change of changes) {
    await configure({ mode: 'vision' }, { delay: 200 });
    await scenario(visionFixture, async (page, controls) => {
      await mockVision(page);
      await start(page, controls);
      await until(async () => (await calls()).length === 1);
      const originalUrl = page.url();
      await change(page);
      const result = await finished(page);
      if (page.url() !== originalUrl || change === changes.at(-1)) assert.equal(result, undefined);
      else assert.match(result.text, /changed|supported, enabled/);
      assert.deepEqual(await page.evaluate(() => clicks), []);
      assert.equal((await calls()).length, 1);
    });
  }
});

test('Vision ignores lock-key events without ignoring question changes', async () => {
  for (const changeQuestion of [false, true]) {
    await configure({ mode: 'vision' }, { delay: 250 });
    await scenario(visionFixture, async (page, controls) => {
      await mockVision(page);
      await start(page, controls);
      await until(async () => (await calls()).length === 1);
      await page.evaluate(changeQuestion => {
        for (const key of ['NumLock', 'CapsLock', 'ScrollLock']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        if (changeQuestion) document.getElementById('question').textContent = 'Changed question';
      }, changeQuestion);
      const result = await finished(page);
      assert.deepEqual(await page.evaluate(() => clicks), changeQuestion ? [] : ['4']);
      if (changeQuestion) assert.match(result.text, /changed/);
      else assert.equal(result.answer, '4', result.text);
    });
  }
});

test('Vision allows canvas pixel changes during inference and takes only one screenshot', async () => {
  await configure({ mode: 'vision' }, { delay: 200 });
  const html = visionFixture.replace('<div id="question">What is 2 + 2?</div>', '<canvas id="question" width="600" height="120"></canvas>') +
    '<script>const drawing=document.getElementById("question").getContext("2d");drawing.font="28px Arial";drawing.fillText("What is 2 + 2?",0,40);</script>';
  await scenario(html, async (page, controls) => {
    await mockVision(page);
    await start(page, controls);
    await until(async () => (await calls()).length === 1);
    await page.evaluate(() => { const drawing = document.getElementById('question').getContext('2d'); drawing.fillRect(0, 0, 600, 120); });
    assert.equal((await finished(page)).answer, '4');
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    assert.equal(await worker.evaluate(() => captures.length), 1);
    assert.equal(await page.evaluate(() => submissions), 0);
  });
});

test('Vision rejects unclear, malformed, out-of-range, and low-confidence model outputs', async () => {
  const mutations = [
    body => { body.answers.ready.noul = 0.4; },
    body => { delete body.answers.question; },
    body => { body.answers.target.box.left = -0.1; },
    body => { body.answers.target.box.left = body.answers.target.box.right; },
    body => { body.answers.target.confidence = 0.5; },
    body => { body.answers.choices.box.right = 0.1; },
    body => { body.model = 'jev-1.13.0'; }
  ];
  for (const mutate of mutations) {
    await configure({ mode: 'vision', minConfidence: 0.8 });
    await scenario(visionFixture, async (page, controls) => {
      await mockVision(page, body => { mutate(body); return body; });
      await start(page, controls);
      assert.match((await finished(page)).text, /visibility|invalid|threshold|outside|did not return/);
      assert.deepEqual(await page.evaluate(() => clicks), []);
      assert.equal(await worker.evaluate(() => captures.length), 1);
    });
  }
});

test('Vision accepts real-provider confidence and rounded boxes when the target center hits the answer', async () => {
  await configure({ mode: 'vision' });
  await scenario(visionFixture, async (page, controls) => {
    await mockVision(page, body => {
      body.answers.ready.noul = 0.8;
      body.answers.choices.confidence = 0.5;
      body.answers.target.confidence = 0.64;
      body.answers.choices.box.bottom = body.answers.target.box.bottom - 0.02;
      return body;
    });
    await start(page, controls);
    const result = await finished(page);
    assert.equal(result.answer, '4', result.text);
    assert.equal(result.confidence, 0.64);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    assert.equal(await page.evaluate(() => submissions), 0);
  });
});

test('Vision rejects answer targets outside the choices region for both providers', async () => {
  for (const provider of ['typesafe', 'openrouter']) {
    await configure({ mode: 'vision', provider });
    await scenario(visionFixture, async (page, controls) => {
      await mockVision(page, body => {
        if (provider === 'openrouter') body.model = 'typesafe/jev-1.14';
        body.answers.choices.box = { left: 0, top: 0, right: 0.01, bottom: 0.01 };
        return body;
      });
      await start(page, controls);
      assert.match((await finished(page)).text, /outside the answer choices/);
      assert.deepEqual(await page.evaluate(() => clicks), []);
    });
  }
});

const customVisionFixture = visionFixture.replace(/<button id="(option\d)">(\d)<\/button>/g,
  '<div id="$1" style="display:grid;place-items:center">$2</div>').replace('button{', '#choices>div,button{');
const highlight = page => page.locator('[data-clickit-highlight]');

test('Vision highlights unsupported answers, keeps targeting accurate, and passes a manual click through', async () => {
  await configure({ mode: 'vision' }, { delay: 200 });
  await scenario(customVisionFixture, async (page, controls) => {
    await mockVision(page);
    await start(page, controls);
    assert.match((await finished(page)).text, /Click the highlighted answer/);
    const id = await tabId(page);
    assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), id), '!');
    assert.deepEqual(await page.evaluate(() => clicks), []);
    assert.equal(await page.evaluate(() => submissions), 0);
    assert.equal((await calls()).length, 1);
    assert.equal(await worker.evaluate(() => captures.length), 1);
    const target = await page.locator('#option4').boundingBox();
    const area = await highlight(page).locator('.area').boundingBox();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(area[key] - target[key]) < 1, `${key}: ${area[key]} vs ${target[key]}`);
    const marker = await highlight(page).locator('.marker').boundingBox();
    assert.ok(Math.abs(marker.x + marker.width / 2 - target.x - target.width / 2) < 1);
    assert.ok(Math.abs(marker.y + marker.height / 2 - target.y - target.height / 2) < 1);
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/vision-highlight.png') });
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    assert.equal(await page.evaluate(() => submissions), 0);
    assert.equal(await highlight(page).count(), 0);
    assert.equal((await calls()).length, 1);
  });
});

test('Vision suggestions disappear on question changes, styles, scrolling, resizing, navigation, keys, tab switches, and the next run', async () => {
  const changes = [
    page => page.evaluate(() => { document.getElementById('question').textContent = 'Another question?'; }),
    page => page.evaluate(() => { document.getElementById('option4').style.transform = 'translateX(10px)'; }),
    page => page.evaluate(() => scrollTo(0, 50)),
    page => page.setViewportSize({ width: 1300, height: 740 }),
    page => page.evaluate(() => history.pushState({}, '', '/another-question')),
    page => page.keyboard.press('Escape'),
    async () => { const other = await context.newPage(); try { await other.bringToFront(); await delay(100); } finally { await other.close(); } },
    async (page, controls) => {
      await worker.evaluate(() => { mock.delay = 200; });
      await start(page, controls);
      await until(async () => (await calls()).length === 2);
      assert.equal(await highlight(page).count(), 0);
      await finished(page);
      await page.keyboard.press('Escape');
    }
  ];
  for (const change of changes) {
    await configure({ mode: 'vision' });
    await scenario(customVisionFixture, async (page, controls) => {
      await mockVision(page);
      await start(page, controls);
      assert.match((await finished(page)).text, /highlighted/);
      await change(page, controls);
      await until(async () => await highlight(page).count() === 0);
      assert.deepEqual(await page.evaluate(() => clicks), []);
    });
  }
});

test('Vision suggestions expire after eight seconds without another model request or click', async () => {
  await configure({ mode: 'vision' });
  await scenario(customVisionFixture, async (page, controls) => {
    // Accelerate only the suggestion lifetime in the extension's isolated world.
    const id = await tabId(page);
    await worker.evaluate(async id => {
      await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
        const timeout = globalThis.setTimeout;
        globalThis.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 8000 ? 300 : ms, ...args);
      } });
    }, id);
    await mockVision(page);
    await start(page, controls);
    assert.match((await finished(page)).text, /highlighted/);
    await until(async () => await highlight(page).count() === 0);
    assert.deepEqual(await page.evaluate(() => clicks), []);
    assert.equal((await calls()).length, 1);
  });
});

test('Vision does not suggest unsupported controls when confidence is low or the captured question changes', async () => {
  for (const stale of [false, true]) {
    await configure({ mode: 'vision', minConfidence: 0.8 }, { delay: 200 });
    await scenario(customVisionFixture, async (page, controls) => {
      await mockVision(page, body => {
        if (!stale) body.answers.target.confidence = 0.5;
        return body;
      });
      await start(page, controls);
      if (stale) {
        await until(async () => (await calls()).length === 1);
        await page.evaluate(() => { document.getElementById('question').textContent = 'Another question?'; });
      }
      assert.match((await finished(page)).text, /threshold|changed/);
      assert.equal(await highlight(page).count(), 0);
      assert.deepEqual(await page.evaluate(() => clicks), []);
    });
  }
});

test('Vision rejects submission, navigation, disabled, and checkbox targets without suggesting them', async () => {
  for (const kind of ['submit', 'navigation', 'custom-navigation', 'disabled', 'checkbox']) {
    await configure({ mode: 'vision' });
    await scenario(visionFixture, async (page, controls) => {
      await page.evaluate(kind => {
        const option = document.getElementById('option4');
        if (kind === 'navigation') option.textContent = 'Next';
        if (kind === 'custom-navigation') option.outerHTML = '<div id="option4">Next</div>';
        if (kind === 'disabled') option.disabled = true;
        if (kind === 'checkbox') option.setAttribute('role', 'checkbox');
      }, kind);
      const body = await visionResponse(page, kind === 'submit' ? '#submit' : '#option4');
      if (kind === 'submit') body.answers.choices.box.bottom = body.answers.target.box.bottom;
      await worker.evaluate(body => { mock.body = body; }, body);
      await start(page, controls);
      assert.match((await finished(page)).text, /submission|No supported/);
      assert.equal(await highlight(page).count(), 0);
      assert.deepEqual(await page.evaluate(() => clicks), []);
      assert.equal(await page.evaluate(() => submissions), 0);
    });
  }
});

test('Vision switching tabs cancels the pending click and a second press cannot start another run', async () => {
  await configure({ mode: 'vision' }, { delay: 300 });
  await scenario(visionFixture, async (page, controls) => {
    await mockVision(page);
    const replies = await Promise.all([start(page, controls), start(page, controls)]);
    assert.equal(replies.filter(reply => reply.ok).length, 1);
    await until(async () => (await calls()).length === 1);
    const other = await context.newPage();
    try {
      assert.match((await finished(page)).text, /active tab changed|viewport changed/);
      assert.deepEqual(await page.evaluate(() => clicks), []);
      assert.equal((await calls()).length, 1);
    } finally { await other.close(); }
  });
});

test('Vision supports OpenRouter without sending a key or screenshot to another provider', async () => {
  await configure({ mode: 'vision', provider: 'openrouter' });
  await scenario(visionFixture, async (page, controls) => {
    await mockVision(page, body => { body.model = 'typesafe/jev-1.14-20261014'; return body; });
    await start(page, controls);
    const result = await finished(page);
    assert.equal(result.answer, '4', result.text);
    const [request] = await calls();
    assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(request.body.model, 'typesafe/jev-1.14');
    assert.equal(request.headers['TypeSafe-Danger-Zone-Images'], undefined);
    assert.equal((await calls()).length, 1);
    assert.deepEqual(await page.evaluate(() => clicks), ['4']);
  });
});

test('saved multiline prompts reach the answer instructions in both modes and providers', async () => {
  const textPrompt = 'Read state.question carefully.\nChoose the best supplied option.';
  const visionPrompt = 'Read the visible quiz.\nBound the answer button with the best answer.';
  for (const provider of ['typesafe', 'openrouter']) for (const mode of ['text', 'vision']) {
    await configure({ provider, mode });
    await scenario(mode === 'vision' ? visionFixture : fixture, async (page, controls) => {
      await controls.getByRole('button', { name: 'Settings', exact: true }).click();
      await controls.locator('#promptSettings > summary').click();
      const key = `${mode}Prompt`, prompt = mode === 'text' ? textPrompt : visionPrompt;
      await controls.locator(`#${key}`).fill(prompt);
      await finishEditing(controls);
      const reopened = await popup();
      try { assert.equal(await reopened.locator(`#${key}`).inputValue(), prompt); }
      finally { await reopened.close(); }
      if (mode === 'vision') await mockVision(page, body => {
        if (provider === 'openrouter') body.model = 'typesafe/jev-1.14';
        return body;
      });
      else if (provider === 'openrouter') await worker.evaluate(() => { mock.body.model = 'typesafe/jev-1.14'; });
      await start(page, controls);
      assert.equal((await finished(page)).answer, '4');
      const request = (await calls())[0].body;
      const answer = mode === 'vision' ? request.questions.target : request.questions.answer;
      assert.equal(answer.instructions, prompt);
      assert.equal(answer.type, mode === 'vision' ? 'box' : 'choice');
      assert.deepEqual(await page.evaluate(() => clicks), ['4']);
    });
  }
});

test('custom prompts stay collapsed until opened across billing modes; Reset restores only the selected prompt and saves automatically', async () => {
  for (const billingMode of ['byok', 'hosted']) for (const mode of ['text', 'vision']) {
    await configure({ billingMode, mode, textPrompt: 'Custom text prompt', visionPrompt: 'Custom vision prompt' });
    const controls = await popup();
    try {
      await controls.getByRole('button', { name: 'Settings', exact: true }).click();
      assert.equal(await controls.locator('#promptSettings').getAttribute('open'), null);
      await controls.locator('#promptSettings > summary').click();
      const key = `${mode}Prompt`, other = mode === 'text' ? 'visionPrompt' : 'textPrompt';
      assert.equal(await controls.locator(`#${key}`).isVisible(), true);
      assert.equal(await controls.locator(`#${other}`).isHidden(), true);
      await controls.locator('input[name="promptMode"]:not(:checked)').check();
      assert.equal(await controls.locator(`#${other}`).isVisible(), true);
      assert.equal(await controls.locator('input[name="mode"]:checked').inputValue(), mode);
      await controls.locator(`input[name="promptMode"][value="${mode}"]`).check();
      await controls.locator(`input[name="billingMode"][value="${billingMode === 'byok' ? 'hosted' : 'byok'}"]`).check();
      assert.equal(await controls.locator(`#${key}`).isVisible(), true);
      await controls.locator(`input[name="billingMode"][value="${billingMode}"]`).check();
      await controls.getByRole('button', { name: 'Reset', exact: true }).click();
      const expected = await worker.evaluate(key => C.defaults[key], key);
      assert.equal(await controls.locator(`#${key}`).inputValue(), expected);
      assert.match(await controls.locator(`#${other}`).inputValue(), /^Custom /);
      await controls.screenshot({ path: path.resolve(__dirname, `../test-results/popup-${mode}-prompt.png`), fullPage: true });
      await finishEditing(controls);
      assert.equal(await worker.evaluate(key => settings[key], key), expected);
      const reopened = await popup();
      try {
        await reopened.getByRole('button', { name: 'Settings', exact: true }).click();
        await reopened.locator('#promptSettings > summary').click();
        assert.equal(await reopened.locator(`#${key}`).isVisible(), true);
        assert.equal(await reopened.locator(`#${key}`).inputValue(), expected);
      } finally { await reopened.close(); }
    } finally { await controls.close(); }
  }
});

test('blank, oversized, and non-text prompts are rejected without overwriting saved prompts', async () => {
  await configure({ textPrompt: 'Saved text', visionPrompt: 'Saved vision' });
  const controls = await popup();
  try {
    for (const key of ['textPrompt', 'visionPrompt']) for (const value of [' \n ', 'x'.repeat(6001), null]) {
      const result = await controls.evaluate(async ({ key, value }) => {
        const { data } = await chrome.runtime.sendMessage({ type: 'inspect' });
        return chrome.runtime.sendMessage({ type: 'save', settings: { ...data.settings, [key]: value } });
      }, { key, value });
      assert.equal(result.ok, false);
      assert.match(result.error, /Prompts/);
    }
    assert.deepEqual(await worker.evaluate(() => [settings.textPrompt, settings.visionPrompt]), ['Saved text', 'Saved vision']);
  } finally { await controls.close(); }
});

test('settings save on field changes without buttons and recover after invalid edits', async () => {
  await configure({ textPrompt: 'Original instructions' });
  const controls = await popup();
  try {
    await controls.locator('#settingsToggle').click();
    assert.equal(await controls.locator('#saveSettings, .settings-footer').count(), 0);
    await controls.locator('#promptSettings > summary').click();
    await controls.locator('#textPrompt').fill(' ');
    await controls.locator('#promptLabel').click();
    await controls.evaluate(() => settingsSave);
    assert.equal(await controls.locator('#message').getAttribute('role'), 'alert');
    assert.equal(await worker.evaluate(() => settings.textPrompt), 'Original instructions');
    await controls.locator('#textPrompt').fill('Automatically saved instructions');
    await controls.locator('#promptLabel').click();
    await controls.evaluate(() => settingsSave);
    assert.equal(await worker.evaluate(() => settings.textPrompt), 'Automatically saved instructions');
    assert.equal(await controls.locator('#settingsPanel').isVisible(), true);
    assert.equal(await controls.locator('#message').textContent(), '');
    await controls.reload();
    await controls.waitForFunction(() => loaded);
    assert.equal(await controls.locator('#textPrompt').inputValue(), 'Automatically saved instructions');
    assert.equal((await calls()).length, 0);
  } finally { await controls.close(); }
});

async function finishEditing(controls) {
  await controls.evaluate(async () => {
    document.activeElement?.blur();
    await settingsSave;
  });
  if (await controls.locator('#settingsPanel').isVisible()) await controls.locator('#settingsToggle').click();
}
