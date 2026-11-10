const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function background(overrides = {}) {
  const listeners = {}, badges = new Map(), titles = new Map();
  const tab = { id: 7, windowId: 1, url: 'https://quiz.example/question' };
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const hosted = { configured: true, registered: true, consented: true, balance: { visionEnabled: true } };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [], pageCalls = [], completions = [];
  const context = vm.createContext({
    AbortController, performance, setTimeout, clearTimeout,
    ClickItVision: {
      install: () => {}, capture: async () => 'image', prepare: async () => ({}),
      region: () => ({ x: 0, y: 0, width: 20, height: 20 })
    },
    ClickItHosted: {
      state: async () => { if (overrides.waitForSetup) await pending; return hosted; },
      answer: async (_q, mode, job) => {
        calls.push(mode); await pending;
        if (overrides.result) job.hostedRequestId = 'test-request';
        return overrides.result || { index: 1, confidence: 1 };
      },
      complete: async (_job, delivered) => { completions.push(delivered); return true; }
    },
    chrome: {
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({ settings: { billingMode: 'hosted' } }), set: async () => {} } },
      commands: { onCommand: event('command') },
      runtime: { id: 'clickit', getURL: file => `chrome-extension://clickit/${file}`, onMessage: event('message') },
      action: {
        setBadgeText: async ({ tabId, text }) => { badges.set(tabId, text); },
        setBadgeBackgroundColor: async () => {},
        setTitle: async ({ tabId, title }) => { titles.set(tabId, title); }
      },
      tabs: { query: async () => [tab], onRemoved: event('removed'), onUpdated: event('updated'), onActivated: event('activated') },
      scripting: { executeScript: async options => {
        if (options.args) pageCalls.push(options.args[0]);
        return [{ documentId: 'doc', result: options.files
          ? { question: '2 + 2?', options: ['3', '4'] } : { clicked: true, answer: '4' } }];
      } }
    },
    importScripts: () => {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  await vm.runInContext('ready', context);
  const inspect = expression => vm.runInContext(expression, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { listeners, badges, titles, tab, hosted, release, calls, pageCalls, completions, inspect, flush };
}

test('command and popup share the hosted job lock, including asynchronous setup', async () => {
  const app = await background({ waitForSetup: true });
  app.listeners.command('answer-question', app.tab);
  await app.flush();
  assert.equal(app.badges.get(7), '…');
  app.listeners.command('answer-question', app.tab);
  const response = new Promise(resolve => app.listeners.message({ type: 'answer' }, {
    id: 'clickit', url: 'chrome-extension://clickit/popup.html'
  }, resolve));
  assert.match((await response).error, /Already answering/);
  app.release();
  await app.flush();
  assert.deepEqual(app.calls, ['text']);
  assert.equal(app.badges.get(7), '✓');
  assert.match(app.titles.get(7), /Answer clicked/);
});

test('command setup errors report on the target tab without opening the popup', async () => {
  for (const kind of ['apiKey', 'configured', 'registered', 'consented', 'vision', 'restricted']) {
    const app = await background();
    if (kind === 'apiKey') app.inspect("settings = { ...settings, billingMode: 'byok', apiKey: '' }");
    if (kind === 'configured') app.hosted.configured = false;
    if (kind === 'registered') app.hosted.registered = false;
    if (kind === 'consented') app.hosted.consented = false;
    if (kind === 'vision') {
      app.inspect("settings = { ...settings, mode: 'vision' }");
      app.hosted.balance.visionEnabled = false;
    }
    if (kind === 'restricted') app.tab.url = 'chrome://version';
    app.listeners.command('answer-question', app.tab);
    await app.flush();
    assert.equal(app.badges.get(7), 'ERR', kind);
    assert.match(app.titles.get(7), /API key|free trial|data sharing|Vision|regular webpage/);
    assert.equal(app.calls.length, 0);
    assert.equal(app.inspect('jobs.size'), 0);
  }
});

test('hotkeys reject missing or non-boolean API-key consent before accessing the page or provider', async () => {
  for (const byokConsent of [undefined, false, 'true']) {
    const app = await background();
    app.inspect(`settings = ClickIt.validateSettings({ billingMode: 'byok', apiKey: 'fake-key', byokConsent: ${JSON.stringify(byokConsent)} })`);
    app.listeners.command('answer-question', app.tab);
    await app.flush();
    assert.match(app.titles.get(7), /data sharing disclosure/);
    assert.equal(app.badges.get(7), 'ERR');
    assert.equal(app.calls.length, 0);
    assert.equal(app.pageCalls.length, 0);
    assert.equal(app.inspect('jobs.size'), 0);
  }
});

test('command uses its supplied tab and falls back only when absent; unrelated commands do nothing', async () => {
  const app = await background();
  app.listeners.command('unrelated', app.tab);
  await app.flush();
  assert.equal(app.inspect('jobs.size'), 0);
  app.listeners.command('answer-question', { ...app.tab, id: 9 });
  await app.flush();
  assert.equal(app.badges.get(9), '…');
  assert.equal(app.badges.has(7), false);
  app.release();
  await app.flush();
  app.listeners.command('answer-question');
  await app.flush();
  assert.equal(app.badges.get(7), '✓');
});

test('navigation clears feedback and aborts an active command without restoring stale feedback', async () => {
  const app = await background({ waitForSetup: true });
  app.listeners.command('answer-question', app.tab);
  await app.flush();
  app.listeners.updated(7, { status: 'loading' });
  assert.equal(app.badges.get(7), '');
  app.release();
  await app.flush();
  assert.equal(app.inspect('statuses.has(7)'), false);
  assert.equal(app.inspect('jobs.size'), 0);
  assert.equal(app.badges.get(7), '');
  assert.equal(app.titles.get(7), 'ClickIt');
  assert.equal(app.calls.length, 0);
});

test('hosted Vision validates target containment before watching or clicking and releases rejected answers', async () => {
  for (const outside of [false, true]) {
    const result = { confidence: 1, boxes: {
      question: { left: 0, top: 0, right: 1, bottom: 0.2 },
      choices: { left: 0, top: 0.3, right: 1, bottom: 1 },
      target: outside ? { left: 0, top: 0, right: 0.1, bottom: 0.1 }
        : { left: 0.3, top: 0.4, right: 0.6, bottom: 0.7 }
    } };
    const app = await background({ result });
    app.inspect("settings = { ...settings, mode: 'vision' }");
    app.listeners.command('answer-question', app.tab);
    await app.flush();
    app.release();
    await app.flush();
    assert.deepEqual(app.calls, ['vision']);
    assert.equal(app.inspect('jobs.size'), 0);
    assert.deepEqual(app.pageCalls, outside ? [] : ['watch', 'click']);
    assert.deepEqual(app.completions, [!outside]);
    assert.equal(app.badges.get(7), outside ? 'ERR' : '✓');
    if (outside) assert.match(app.titles.get(7), /outside the answer choices/);
  }
});
