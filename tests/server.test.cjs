const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, answer } = require('./helpers/server.cjs');

test('hosted prompts are validated before reserving credits and custom Text instructions reach the provider', async t => {
  const s = await setup(t, { VISION_ENABLED: 'true' });
  const user = await s.register();
  for (const mode of ['text', 'vision']) {
    for (const prompt of ['', ' \n ', 'x'.repeat(6001), null, 42, {}]) {
      const response = await s.req('answers', { requestId: crypto.randomUUID(), mode, prompt,
        question: { question: '2+2?', options: ['3', '4'] }, image: 'iVBORw0KGgo=' }, user.credential);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Prompts/);
    }
  }
  assert.equal(s.calls.length, 0);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  const prompt = 'Read state.question carefully.\nChoose the best supplied option.';
  const response = await s.req('answers', { requestId: crypto.randomUUID(), mode: 'text', prompt,
    question: { question: '2+2?', options: ['3', '4'] } }, user.credential);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(s.calls[0].options.body).questions.answer.instructions, prompt);
});

test('trial consent, opaque credentials, stored hashes, source, IP rate limit, and 100-install cap', async t => {
  const s = await setup(t);
  assert.equal((await s.req('installations', { adultConsent: false, dataConsent: true })).status, 400);
  const user = await s.register();
  assert.equal(user.credits, 15);
  assert.match(user.credential, /^ci_[a-f0-9]{64}$/);
  const stored = s.db.sql.prepare('SELECT * FROM installations WHERE id=?').get(user.installationId);
  assert.notEqual(stored.credential_hash, user.credential);
  assert.equal(stored.source, 'demo');
  assert.equal(JSON.stringify(stored).includes('203.0.113.5'), false);
  assert.equal((await s.req('balance', undefined, user.credential)).status, 200);
  assert.equal((await s.req('balance', undefined, `ci_${'0'.repeat(64)}`)).status, 401);
  await s.register(); await s.register();
  assert.equal((await s.req('installations', { adultConsent: true, dataConsent: true })).status, 429);
  for (let i = 3; i < 100; i++) await s.register(`198.51.100.${i}`);
  assert.equal((await s.req('installations', { adultConsent: true, dataConsent: true }, null, { 'CF-Connecting-IP': 'new-address' })).status, 429);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM credit_lots').get().n, 100);
});

test('new trials get 15 suggestions without changing existing trial balances', async t => {
  const s = await setup(t);
  const existing = await s.register();
  s.db.sql.prepare('UPDATE credit_lots SET granted=10, consumed=4 WHERE installation_id=?').run(existing.installationId);
  const user = await s.register();
  assert.equal(user.credits, 15);
  assert.equal((await (await s.req('balance', undefined, existing.credential)).json()).credits, 6);
  for (let remaining = 14; remaining >= 0; remaining--) {
    const result = await s.solve(user.credential);
    assert.equal(result.response.status, 200);
    const completed = await s.req('answers/complete', { requestId: result.requestId, delivered: true }, user.credential);
    assert.equal((await completed.json()).credits, remaining);
    s.advance(60001);
  }
  assert.equal((await s.solve(user.credential)).response.status, 402);
  assert.equal((await (await s.req('balance', undefined, existing.credential)).json()).credits, 6);
});

test('hosted requests use default prompts when omitted, settle once, and reject a second active request', async t => {
  const s = await setup(t);
  const user = await s.register();
  const first = await s.solve(user.credential);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.result.index, 1);
  const upstream = JSON.parse(s.calls[0].options.body);
  assert.equal(upstream.model, 'typesafe/jev-1.14');
  assert.equal(upstream.questions.answer.instructions, globalThis.ClickIt.defaults.textPrompt);
  assert.equal(s.calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(upstream.provider, { only:['typesafe'], allow_fallbacks:false, max_price:{prompt:.042,completion:0,request:0,image:0} });
  assert.equal(s.calls[0].options.headers.Authorization, 'Bearer private-provider-secret');
  assert.equal((await s.solve(user.credential)).response.status, 409);
  assert.equal((await s.solve(user.credential, first.requestId)).response.status, 409);
  let current = await (await s.req('balance', undefined, user.credential)).json();
  assert.equal(current.credits, 14); assert.equal(current.reserved, 1);
  const complete = () => s.req('answers/complete', { requestId: first.requestId, delivered: true }, user.credential);
  assert.equal((await complete()).status, 200);
  await complete(); await s.req('answers/complete', { requestId: first.requestId, delivered: false }, user.credential);
  current = await (await s.req('balance', undefined, user.credential)).json();
  assert.equal(current.credits, 14); assert.equal(current.reserved, 0);
  assert.equal(s.db.sql.prepare('SELECT spent_nano FROM budget').get().spent_nano, 42000);
});

test('page rejection, invalid results, upstream errors, and expiry return credits but retain inference costs', async t => {
  const s = await setup(t);
  const user = await s.register();
  const solved = await s.solve(user.credential);
  await s.req('answers/complete', { requestId: solved.requestId, delivered: false }, user.credential);
  s.state.provider = { model: 'wrong-model', usage: { input_tokens: 1000 } };
  assert.equal((await s.solve(user.credential)).response.status, 422);
  s.state.provider = { private: 'raw screenshot error' }; s.state.status = 500;
  const error = await s.solve(user.credential);
  assert.equal(error.response.status, 502);
  assert.equal(JSON.stringify(error.body).includes('raw screenshot'), false);
  s.state.throw = true;
  assert.equal((await s.solve(user.credential)).response.status, 502);
  s.state.throw = false; s.state.status = 200; s.state.provider = answer;
  const abandoned = await s.solve(user.credential);
  s.advance(120001);
  await s.worker.scheduled({}, s.env);
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 15);
  await s.req('answers/complete', { requestId: abandoned.requestId, delivered: true }, user.credential);
  assert.equal(s.db.sql.prepare('SELECT consumed FROM credit_lots').get().consumed, 0);
  assert.ok(s.db.sql.prepare('SELECT spent_nano FROM budget').get().spent_nano >= 22020096);
});

test('atomic SQL guards prevent overspend, early settlement, and cross-installation completion', async t => {
  const s = await setup(t);
  const user = await s.register(); const other = await s.register();
  let unblock;
  s.state.wait = new Promise(resolve => { unblock = resolve; });
  const pending = s.solve(user.credential);
  // Give the first handler time to reach the blocked provider fetch.
  while (!s.calls.length) await new Promise(resolve => setImmediate(resolve));
  const request = s.db.sql.prepare('SELECT id FROM requests').get();
  assert.equal((await s.req('answers/complete', { requestId: request.id, delivered: true }, user.credential)).status, 409);
  assert.equal((await s.req('answers/complete', { requestId: request.id, delivered: false }, other.credential)).status, 404);
  assert.equal((await s.solve(user.credential)).response.status, 409);
  unblock(); await pending;
  await s.req('answers/complete', { requestId: request.id, delivered: true }, user.credential);
  s.db.sql.exec('UPDATE credit_lots SET consumed=granted WHERE reserved=0');
  assert.equal((await s.solve(user.credential)).response.status, 402);
  assert.equal(s.calls.length, 1);
});

test('global budget, request limits, disabled Vision, gates, and payload bounds stop before inference', async t => {
  const s = await setup(t);
  const user = await s.register();
  s.db.sql.exec('UPDATE budget SET limit_nano=11010047');
  assert.equal((await s.solve(user.credential)).response.status, 503);
  assert.equal(s.calls.length, 0);
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 15);
  const vision = await s.req('answers', { requestId: crypto.randomUUID(), mode: 'vision', image: 'iVBORw0KGgo=' }, user.credential);
  assert.equal(vision.status, 403);
  assert.equal((await s.req('answers', { padding: 'x'.repeat(3000001) }, user.credential)).status, 413);
  s.env.CHECKOUT_ENABLED = 'false';
  assert.equal((await s.req('checkout', { checkoutId: crypto.randomUUID() }, user.credential)).status, 403);
  s.env.INFERENCE_ENABLED = 'false';
  assert.equal((await s.solve(user.credential)).response.status, 503);
  assert.equal((await s.req('balance', undefined, user.credential, { Origin: 'https://evil.example' })).status, 403);
  const cors = await s.req('balance', undefined, user.credential, { Origin: 'chrome-extension://test' });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'chrome-extension://test');
});

test('API bodies must be JSON objects before registration, billing, or inference', async t => {
  const s = await setup(t);
  const user = await s.register();
  for (const route of ['installations', 'checkout', 'subscription/preview', 'subscription/change', 'billing-portal', 'answers', 'answers/complete']) {
    for (const data of [null, [], 'invalid', 1, true]) {
      const response = await s.req(route, data, user.credential, { Origin: 'chrome-extension://test' });
      assert.equal(response.status, 400, `${route}: ${JSON.stringify(data)}`);
      assert.equal(response.headers.get('access-control-allow-origin'), 'chrome-extension://test');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(s.calls.length, 0);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM installations').get().n, 1);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('legacy purchases still fulfill once through signed webhooks, and new purchases require a subscription plan', async t => {
  const s = await setup(t);
  const user = await s.register();
  assert.equal((await s.purchase(user)).status, 200);
  assert.equal((await s.req('checkout', { checkoutId: crypto.randomUUID() }, user.credential)).status, 400);
  await s.notify('checkout.session.completed', { id: s.state.session.id });
  await s.notify('checkout.session.async_payment_succeeded', { id: s.state.session.id }, { eventId: 'evt_second' });
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 515);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal((await s.notify('checkout.session.completed', { id: s.state.session.id }, { forged: true })).status, 400);
  assert.equal((await s.notify('checkout.session.completed', { id: s.state.session.id }, { age: 301 })).status, 400);
});

test('unpaid, wrong products, tampered owners, and wrong payment environments grant no credits', async t => {
  const s = await setup(t);
  const user = await s.register();
  await s.purchase(user);
  s.db.sql.exec('DELETE FROM credit_lots WHERE order_id IS NOT NULL; DELETE FROM orders');
  const original = structuredClone(s.state.session);
  for (const patch of [{ payment_status: 'unpaid' }, { amount_subtotal: 1 }, { currency: 'thb' },
    { client_reference_id: 'someone-else' }, { livemode: true }, { line_items: { data: [{ price: { id: 'price_wrong' }, quantity: 1 }] } }]) {
    s.state.session = { ...original, ...patch };
    const response = await s.notify('checkout.session.completed', { id: original.id });
    assert.equal(response.status, patch.payment_status ? 200 : 400);
    assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  }
});

test('refunds revoke unused entitlement idempotently, including held credits and out-of-order fulfillment', async t => {
  const s = await setup(t);
  const user = await s.register();
  await s.purchase(user);
  s.db.sql.exec("UPDATE credit_lots SET consumed=granted WHERE order_id IS NULL");
  const held = await s.solve(user.credential);
  const refund = { payment_intent: s.state.session.payment_intent, amount_refunded: 499 };
  await s.notify('charge.refunded', refund);
  await s.notify('charge.refunded', refund);
  await s.req('answers/complete', { requestId: held.requestId, delivered: false }, user.credential);
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 0);
  await s.notify('checkout.session.completed', { id: s.state.session.id });
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 0);
  const other = await s.register('198.51.100.150');
  s.state.refunded = 499;
  assert.equal((await s.purchase(other, 'cs_refunded_before_delivery')).status, 200);
  assert.equal((await (await s.req('balance', undefined, other.credential)).json()).credits, 15);
});

test('partial refunds only reduce the matching purchase and never restore previously revoked credits', async t => {
  const s = await setup(t);
  const user = await s.register();
  await s.purchase(user);
  await s.notify('charge.refunded', { payment_intent: s.state.session.payment_intent, amount_refunded: 100 });
  const remaining = (await (await s.req('balance', undefined, user.credential)).json()).credits;
  assert.equal(remaining, 414); // ceil(500 * 100/499) = 101 revoked.
  await s.notify('charge.refunded', { payment_intent: s.state.session.payment_intent, amount_refunded: 50 });
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, remaining);
});

test('tax-inclusive refunds use the total charge as their denominator and preserve gross refund records', async t => {
  const s = await setup(t);
  const user = await s.register();
  await s.purchase(user);
  s.db.sql.exec("UPDATE orders SET total_amount=549,tax_amount=50");
  await s.notify('charge.refunded', { payment_intent: s.state.session.payment_intent, amount_refunded: 100 });
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 423); // 92 credits revoked.
  await s.notify('charge.refunded', { payment_intent: s.state.session.payment_intent, amount_refunded: 549 });
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 15);
  assert.equal(s.db.sql.prepare('SELECT refunded_amount FROM orders').get().refunded_amount, 549);
});

test('scheduled retention deletes old technical history without removing balances, purchases, or lifetime spend', async t => {
  const s = await setup(t);
  const user = await s.register();
  const result = await s.solve(user.credential);
  await s.req('answers/complete', { requestId: result.requestId, delivered: true }, user.credential);
  await s.purchase(user);
  const cost = s.db.sql.prepare('SELECT spent_nano FROM budget').get().spent_nano;
  s.advance(91 * 86400000);
  await s.worker.scheduled({}, s.env);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(s.db.sql.prepare('SELECT ip_hash FROM installations').get().ip_hash, '');
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 514);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(s.db.sql.prepare('SELECT spent_nano FROM budget').get().spent_nano, cost);
});

test('hosted Vision accepts independent target boxes and visibility failures return the credit', async t => {
  const s = await setup(t, { VISION_ENABLED: 'true' });
  const user = await s.register();
  const region = box => ({ type: 'box', confidence: .95, box });
  s.state.provider = { model: 'typesafe/jev-1.14', usage: { input_tokens: 2000 }, answers: {
    ready: { type: 'noul', noul: .9 },
    question: region({ left:.1, top:.1, right:.9, bottom:.3 }),
    choices: region({ left:.7, top:.7, right:.9, bottom:.9 }),
    target: region({ left:.1, top:.4, right:.4, bottom:.6 })
  } };
  const requestId = crypto.randomUUID();
  const input = { requestId, mode:'vision', image:'iVBORw0KGgo=', prompt:'Read the visible quiz.\nBound the best answer button.' };
  const response = await s.req('answers', input, user.credential);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).result.boxes.target);
  assert.equal(s.calls[0].options.headers['TypeSafe-Danger-Zone-Images'], undefined);
  assert.equal(s.calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  const upstream = JSON.parse(s.calls[0].options.body);
  assert.equal(Object.values(upstream.assets)[0].data_base64, input.image);
  assert.equal(upstream.questions.target.instructions, input.prompt);
  await s.req('answers/complete', { requestId, delivered:true }, user.credential);
  s.state.provider.answers.ready.noul = .2;
  assert.equal((await s.req('answers', { ...input, prompt: undefined, requestId:crypto.randomUUID() }, user.credential)).status, 422);
  assert.equal(JSON.parse(s.calls[1].options.body).questions.target.instructions, globalThis.ClickIt.defaults.visionPrompt);
  assert.equal((await (await s.req('balance', undefined, user.credential)).json()).credits, 14);
});

test('OpenRouter reported cost takes precedence over token estimates, with bounded-token fallback', async t => {
  const s = await setup(t);
  const user = await s.register();
  s.state.provider = structuredClone(answer);
  s.state.provider.usage = { input_tokens: 1000, cost: .000123456 };
  const first = await s.solve(user.credential);
  assert.equal(first.response.status, 200);
  assert.equal(s.db.sql.prepare('SELECT spent_nano FROM budget').get().spent_nano, 123456);
  await s.req('answers/complete', { requestId: first.requestId, delivered:false }, user.credential);
  s.state.provider.usage = { input_tokens: 262144 };
  const second = await s.solve(user.credential);
  assert.equal(second.response.status, 200);
  assert.equal(s.db.sql.prepare('SELECT spent_nano FROM budget').get().spent_nano, 11133504);
});

test('hosted requests never fall back to a direct TypeSafe credential', async t => {
  const s = await setup(t, { OPENROUTER_API_KEY:'', TYPESAFE_API_KEY:'unused-old-secret' });
  const user = await s.register();
  assert.equal((await s.solve(user.credential)).response.status, 503);
  assert.equal(s.calls.length, 0);
});
