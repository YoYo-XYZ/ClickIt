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
    globalThis.mock = {};
    globalThis.fetch = async (url, init) => {
      const config = { ...globalThis.mock };
      apiCalls.push({ url, body: JSON.parse(init.body), authorization: init.headers.Authorization, credentials: init.credentials });
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
  await page.setViewportSize({ width: 360, height: 520 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => document.getElementById('timeoutMs').value !== '');
  return page;
}
async function configure(overrides = {}, response = {}) {
  await until(() => worker.evaluate(() => jobs.size === 0));
  const controls = await popup();
  try {
    await worker.evaluate(config => { globalThis.mock = config; globalThis.apiCalls = []; }, { body: payload(), ...response });
    const reply = await controls.evaluate(settings => chrome.runtime.sendMessage({ type: 'save', settings }), {
      provider: 'typesafe', apiKey: 'fake-test-key', timeoutMs: 2500, minConfidence: 0, ...overrides
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
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting']);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.host_permissions, ['https://api.typesafe.ai/*', 'https://openrouter.ai/*']);
  await configure({ enabled: true, answerBank: { Question: 'Answer' }, questionSelector: 'h1', settleMs: 8 });
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(Object.keys(saved).sort(), ['apiKey', 'minConfidence', 'provider', 'timeoutMs']);
  assert.equal(saved.apiKey, 'fake-test-key');
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
      await page.evaluate(change);
      assert.match((await finished(page)).text, /changed/);
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

test('popup saves lean settings, shows only the latest answer, and keeps it on reopening', async () => {
  await configure();
  await scenario(fixture, async (page, controls) => {
    assert.equal(await controls.locator('#autopilot,#answerBank,textarea').count(), 0);
    await controls.getByText('Settings', { exact: true }).click();
    await controls.locator('#minConfidence').fill('0.3');
    await controls.getByRole('button', { name: 'Save settings' }).click();
    await controls.waitForFunction(() => document.getElementById('message').textContent === 'Saved.');
    assert.equal(await worker.evaluate(() => settings.minConfidence), 0.3);
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
      await reopened.waitForFunction(() => document.getElementById('answer').textContent === '6');
      assert.equal(await reopened.locator('.latest-answer strong').count(), 1);
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
