const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('restored hosted access requires local consent, preserves credits, and remembers consent across worker restarts', async () => {
  const stored = {}, calls = [];
  function load() {
    const context = vm.createContext({
      URL, AbortSignal, Response, crypto, performance,
      ClickItConfig: { apiUrl: 'https://clickit.example' },
      chrome: { storage: { local: {
        get: async () => structuredClone(stored),
        set: async value => Object.assign(stored, structuredClone(value)),
        remove: async key => { delete stored[key]; }
      } } },
      fetch: async (url, options = {}) => {
        const route = new URL(url).pathname;
        calls.push(route);
        if (route === '/v1/answers') return Response.json({ result: { index: 1, confidence: 1 }, apiMs: 1 });
        if (['/v1/balance', '/v1/answers/complete'].includes(route)) return Response.json({ credits: 57, reserved: 0 });
        throw new Error('Unexpected request: ' + route);
      }
    });
    for (const file of ['core.js', 'hosted.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
    return context.ClickItHosted;
  }
  const hosted = load();
  await hosted.restore(`ci_${'b'.repeat(64)}`);
  const restored = await hosted.state();
  assert.equal(restored.registered, true);
  assert.equal(restored.consented, false);
  assert.equal(restored.balance.credits, 57);
  const question = { question: '2 + 2?', options: ['3', '4'] };
  await assert.rejects(hosted.answer(question, 'text', { controller: new AbortController() }), /data sharing disclosure/);
  await assert.rejects(hosted.register({ adultConsent: true, dataConsent: false }), /Confirm age and data processing/);
  assert.equal(calls.includes('/v1/answers'), false);
  await hosted.register({ adultConsent: true, dataConsent: true });
  assert.equal((await hosted.state()).balance.credits, 57);
  assert.equal(calls.includes('/v1/installations'), false, 'accepting disclosure must not register another trial');
  const restarted = load();
  assert.equal((await restarted.state()).consented, true);
  const job = { controller: new AbortController() };
  assert.equal((await restarted.answer(question, 'text', job)).index, 1);
  await restarted.complete(job, true);
  assert.equal(calls.filter(route => route === '/v1/answers').length, 1);
});
