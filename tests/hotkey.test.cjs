const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function background(overrides = {}) {
  const listeners = {}, badges = new Map(), titles = new Map();
  const tab = { id: 7, windowId: 1, url: 'https://quiz.example/question' };
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const hosted = { configured: true, registered: true, balance: { visionEnabled: true } };
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const context = vm.createContext({
    AbortController, performance, setTimeout, clearTimeout,
    ClickItVision: {},
    ClickItHosted: {
      state: async () => { if (overrides.waitForSetup) await pending; return hosted; },
      answer: async (_q, mode) => { calls.push(mode); await pending; return { index: 1, confidence: 1 }; },
      complete: async () => true
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
      scripting: { executeScript: async options => [{ documentId: 'doc', result: options.files
        ? { question: '2 + 2?', options: ['3', '4'] } : { clicked: true } }] }
    },
    importScripts: () => {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  await vm.runInContext('ready', context);
  const inspect = expression => vm.runInContext(expression, context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { listeners, badges, titles, tab, hosted, release, calls, inspect, flush };
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
  for (const kind of ['apiKey', 'configured', 'registered', 'vision', 'restricted']) {
    const app = await background();
    if (kind === 'apiKey') app.inspect("settings = { ...settings, billingMode: 'byok', apiKey: '' }");
    if (kind === 'configured') app.hosted.configured = false;
    if (kind === 'registered') app.hosted.registered = false;
    if (kind === 'vision') {
      app.inspect("settings = { ...settings, mode: 'vision' }");
      app.hosted.balance.visionEnabled = false;
    }
    if (kind === 'restricted') app.tab.url = 'chrome://version';
    app.listeners.command('answer-question', app.tab);
    await app.flush();
    assert.equal(app.badges.get(7), 'ERR', kind);
    assert.match(app.titles.get(7), /API key|free trial|Vision|regular webpage/);
    assert.equal(app.calls.length, 0);
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
