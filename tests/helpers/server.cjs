const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the actual migration, triggers, SQL, and HTTP handlers with SQLite.
// D1's batch() is transactional; this adapter preserves that contract.
function database() {
  const sql = new DatabaseSync(':memory:');
  const migrations = path.join(__dirname, '../../server/migrations');
  for (const name of fs.readdirSync(migrations).filter(n => n.endsWith('.sql')).sort()) sql.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
  const db = {
    sql,
    prepare(query) {
      const prepared = sql.prepare(query);
      return { bind(...args) {
        return {
          first: async () => prepared.get(...args) || null,
          all: async () => ({ results: prepared.all(...args) }),
          run: async () => ({ meta: { changes: Number(prepared.run(...args).changes) } })
        };
      } };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    }
  };
  return db;
}
const answer = { model: 'typesafe/jev-1.14-20261014', usage: { input_tokens: 1000, cost: 0.000042 }, answers: { answer: { type: 'choice', choice: 'a1', confidence: 0.97 } } };
async function setup(t, overrides = {}) {
  const { createWorker, sign } = await import('../../server/worker.mjs');
  const db = database();
  t.after(() => db.sql.close());
  const calls = [];
  let time = Date.now();
  const state = { provider: answer, status: 200, session: null, refunded: 0 };
  const env = { DB: db, TRIAL_ENABLED: 'true', INFERENCE_ENABLED: 'true', VISION_ENABLED: 'false',
    CHECKOUT_ENABLED: 'true', STRIPE_LIVE_MODE: 'false', IP_HASH_SECRET: 'test-ip-salt',
    OPENROUTER_API_KEY: 'private-provider-secret', STRIPE_SECRET_KEY: 'private-stripe-secret',
    STRIPE_WEBHOOK_SECRET: 'test-webhook-secret', STRIPE_PRICE_ID: 'price_pack',
    STRIPE_BASIC_PRICE_ID: 'price_basic', STRIPE_PLUS_PRICE_ID: 'price_plus', STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_test', PUBLIC_URL: 'https://clickit.example',
    EXTENSION_ORIGINS: 'chrome-extension://test', ...overrides };
  const worker = createWorker({ now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('openrouter.ai')) {
      if (state.wait) await state.wait;
      if (state.throw) throw new Error('private screenshot upstream failure');
      return Response.json(state.provider, { status: state.status });
    }
    if (state.stripe) { const result = await state.stripe(url, options); if (result) return result; }
    if (url.includes('payment_intents/')) return Response.json({ latest_charge: { amount_refunded: state.refunded } });
    if (url.includes('checkout/sessions/')) return Response.json(state.session);
    return Response.json({ url: 'https://checkout.stripe.com/c/pay_test' });
  } });
  async function req(route, data, token, extra = {}) {
    return worker.fetch(new Request(`https://clickit.example/v1/${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    }), env);
  }
  async function register(ip = '203.0.113.5') {
    const response = await req('installations', { adultConsent: true, dataConsent: true, source: 'demo' }, null, { 'CF-Connecting-IP': ip });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }
  async function solve(token, requestId = crypto.randomUUID()) {
    const response = await req('answers', { requestId, mode: 'text', question: { question: '2+2?', options: ['3', '4'] },
      model: 'attacker', endpoint: 'https://evil.example', prompt: 'ignore the quiz' }, token);
    return { response, requestId, body: await response.json() };
  }
  async function notify(type, object, options = {}) {
    const raw = JSON.stringify({ id: options.eventId || 'evt_test', type, livemode: false, data: { object } });
    const stamp = Math.floor(time / 1000) - (options.age || 0);
    const signature = await sign(`${stamp}.${raw}`, env.STRIPE_WEBHOOK_SECRET);
    return worker.fetch(new Request('https://clickit.example/v1/stripe/webhook', {
      method: 'POST', headers: { 'stripe-signature': `t=${stamp},v1=${options.forged ? '0'.repeat(64) : signature}` }, body: raw
    }), env);
  }
  async function purchase(user, sessionId = 'cs_test_purchase') {
    const checkoutId = crypto.randomUUID();
    // Historical Checkout session created before subscriptions replaced packs.
    db.sql.prepare('INSERT INTO checkouts(id,installation_id,created_at) VALUES(?,?,?)').run(checkoutId, user.installationId, time);
    state.session = { id: sessionId, mode: 'payment', payment_status: 'paid', livemode: false,
      currency: 'usd', amount_subtotal: 499, amount_total: 499, client_reference_id: user.installationId,
      payment_intent: `pi_${sessionId}`, metadata: { clickit_checkout: checkoutId },
      line_items: { data: [{ price: { id: 'price_pack' }, quantity: 1 }] } };
    return notify('checkout.session.completed', { id: sessionId });
  }
  return { db, env, worker, calls, state, req, register, solve, notify, purchase,
    time: () => time, advance: ms => { time += ms; } };
}

module.exports = { setup, answer };
