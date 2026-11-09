import '../extension/core.js';
import { billingService } from './billing.mjs';
const C = globalThis.ClickIt;
const MAX_BODY = 3_000_000;
const RESERVE_NANO = 11_010_048; // OpenRouter's 262,144-token context at the capped $0.042/M input price.
const encoder = new TextEncoder();
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const hash = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
export async function sign(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function readBody(request, limit = MAX_BODY) {
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'A request body is required.');
  let size = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, 'Request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function bodyJSON(request, limit) {
  const raw = await readBody(request, limit);
  try { return JSON.parse(raw); } catch { fail(400, 'Invalid JSON.'); }
}
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
async function expire(db, now) {
  await stmt(db, `UPDATE requests SET status='released', completed_at=? WHERE status IN ('reserved','ready') AND expires_at <= ?`, now, now).run();
}
async function cleanup(db, now) {
  await expire(db, now);
  const cutoff = now - 90 * 86400000;
  await db.batch([
    stmt(db, "DELETE FROM requests WHERE status IN ('settled','released') AND completed_at < ?", cutoff),
    stmt(db, 'DELETE FROM events WHERE created_at < ?', cutoff),
    stmt(db, "UPDATE installations SET ip_hash='' WHERE created_at < ? AND ip_hash != ''", cutoff)
  ]);
}
function billing(env, fetchImpl, now) {
  return billingService({ env, now, fail, stripe: (path, form, key) => stripe(fetchImpl, env, path, form, key) });
}
async function identity(request, db) {
  const token = /^Bearer (ci_[a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token) fail(401, 'Start your free trial or restore your installation credential.');
  const row = await stmt(db, 'SELECT id FROM installations WHERE credential_hash=?', await hash(token)).first();
  if (!row) fail(401, 'Installation credential is no longer valid. Contact support to recover a purchase.');
  return row.id;
}
function requestData(data, env) {
  if (!data || typeof data !== 'object' || !/^[a-f0-9-]{36}$/.test(data.requestId || '')) fail(400, 'A valid request ID is required.');
  if (data.mode === 'text') {
    let question;
    try { question = C.validateQuestion(data.question); } catch { fail(400, 'Invalid quiz question or choices.'); }
    if (JSON.stringify(question).length > 60000) fail(413, 'Question is too large.');
    return { body: C.requestBody(question, 'openrouter'), count: question.options.length, mode: 'text' };
  }
  if (data.mode === 'vision') {
    if (env.VISION_ENABLED !== 'true') fail(403, 'Hosted Vision is awaiting compatibility validation. Use Text or your own API key.');
    if (typeof data.image !== 'string' || data.image.length > 2_800_000 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(data.image)) fail(400, 'A resized PNG screenshot is required.');
    return { body: C.visionRequest(data.image, 'openrouter'), mode: 'vision' };
  }
  fail(400, 'Choose Text or Vision mode.');
}
async function stripe(fetchImpl, env, path, form, key) {
  if (!env.STRIPE_SECRET_KEY) fail(503, 'Payments are not configured.');
  const response = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) fail(502, 'Payment service unavailable. Please try again later.');
  return response.json();
}
async function webhook(request, env, fetchImpl, now) {
  if (!env.STRIPE_WEBHOOK_SECRET) fail(503, 'Webhook is not configured.');
  const raw = await readBody(request, 256000);
  const parts = (request.headers.get('stripe-signature') || '').split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) fail(400, 'Invalid webhook signature.');
  const expected = await sign(`${timestamp}.${raw}`, env.STRIPE_WEBHOOK_SECRET);
  if (!signatures.some(sig => equal(sig, expected))) fail(400, 'Invalid webhook signature.');
  let notification;
  try { notification = JSON.parse(raw); } catch { fail(400, 'Invalid webhook body.'); }
  if (!notification || typeof notification.type !== 'string') fail(400, 'Invalid webhook event.');
  if (notification.livemode !== (env.STRIPE_LIVE_MODE === 'true')) fail(400, 'Incorrect payment environment.');
  const object = notification.data?.object;
  const subscriptions = billing(env, fetchImpl, now);
  if (await subscriptions.handleEvent(notification)) return json({ received: true });
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(notification.type)) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(object?.id || '')) fail(400, 'Invalid checkout.');
    // Retrieve authoritative state and line items, including on replay or delayed delivery.
    const session = await stripe(fetchImpl, env, `checkout/sessions/${object.id}?expand[]=line_items`);
    if (session.mode === 'subscription') {
      await subscriptions.checkoutCompleted(session);
      return json({ received: true });
    }
    if (session.payment_status !== 'paid') return json({ received: true });
    const item = session.line_items?.data;
    const owner = session.client_reference_id;
    if (session.mode !== 'payment' || session.currency !== 'usd' || session.amount_subtotal !== 499 ||
      !Number.isSafeInteger(session.amount_total) || session.amount_total < 499 ||
      session.livemode !== (env.STRIPE_LIVE_MODE === 'true') ||
      !Array.isArray(item) || item.length !== 1 || item[0].price?.id !== env.STRIPE_PRICE_ID || item[0].quantity !== 1 ||
      typeof session.payment_intent !== 'string') fail(400, 'Unexpected paid product.');
    const checkout = await stmt(env.DB, 'SELECT installation_id FROM checkouts WHERE id=?', session.metadata?.clickit_checkout || '').first();
    if (!checkout || checkout.installation_id !== owner) fail(400, 'Checkout owner does not match.');
    const intent = await stripe(fetchImpl, env, `payment_intents/${encodeURIComponent(session.payment_intent)}?expand[]=latest_charge.balance_transaction`);
    const refunded = Math.max(0, Math.min(session.amount_total, intent.latest_charge?.amount_refunded || 0));
    const fee = intent.latest_charge?.balance_transaction;
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO orders(session_id,installation_id,payment_intent,amount,currency,credits,total_amount,tax_amount,stripe_fee,stripe_fee_currency,created_at)
        VALUES(?,?,?,499,'usd',500,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`, session.id, owner, session.payment_intent,
        session.amount_total, session.total_details?.amount_tax ?? 0,
        Number.isSafeInteger(fee?.fee) ? fee.fee : null, typeof fee?.currency === 'string' ? fee.currency : null, now),
      stmt(env.DB, 'UPDATE orders SET refunded_amount=MAX(refunded_amount,?) WHERE session_id=?', refunded, session.id),
      stmt(env.DB, `INSERT INTO credit_lots(id,installation_id,order_id,granted,created_at)
        SELECT ?,installation_id,session_id,500,? FROM orders WHERE session_id=? ON CONFLICT(order_id) DO NOTHING`, `paid:${session.id}`, now, session.id),
      stmt(env.DB, `UPDATE credit_lots SET revoked=MAX(revoked,(SELECT MIN(500,(refunded_amount*500+total_amount-1)/total_amount)
        FROM orders WHERE session_id=credit_lots.order_id)) WHERE order_id=?`, session.id)
    ]);
  } else if (notification.type === 'charge.refunded') {
    if (typeof object?.payment_intent !== 'string' || !Number.isSafeInteger(object.amount_refunded) || object.amount_refunded < 0) fail(400, 'Invalid refund.');
    await revoke(env.DB, object.payment_intent, object.amount_refunded);
  }
  return json({ received: true });
}
async function revoke(db, intent, amount) {
  await db.batch([
    stmt(db, 'UPDATE orders SET refunded_amount=MAX(refunded_amount,MIN(total_amount,?)) WHERE payment_intent=?', amount, intent),
    stmt(db, `UPDATE credit_lots SET revoked=MAX(revoked, (SELECT MIN(500,(refunded_amount*500+total_amount-1)/total_amount)
      FROM orders WHERE session_id=credit_lots.order_id)) WHERE order_id IN (SELECT session_id FROM orders WHERE payment_intent=?)`, intent)
  ]);
}

export function createWorker({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const allowed = (env.EXTENSION_ORIGINS || '').split(',').filter(Boolean);
      const origin = request.headers.get('Origin');
      const cors = origin && allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' } : {};
      try {
        if (url.pathname === '/launch.json' && request.method === 'GET') return json({
          storeUrl: env.STORE_URL || '', supportUrl: env.SUPPORT_URL || '',
          trialEnabled: env.TRIAL_ENABLED === 'true'
        });
        if (!url.pathname.startsWith('/v1/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
        if (url.pathname === '/v1/stripe/webhook' && request.method === 'POST') return await webhook(request, env, fetchImpl, now());
        if (origin && !allowed.includes(origin)) fail(403, 'This client origin is not enabled.');
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        const response = await route(request, env, url, fetchImpl, now());
        return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors } });
      } catch (error) {
        // Do not log exceptions or provider bodies: they can contain quiz content or screenshots.
        return new Response(JSON.stringify({ error: error instanceof HttpError ? error.message : 'Service unavailable. Please try again later.' }), {
          status: error instanceof HttpError ? error.status : 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }
        });
      }
    },
    async scheduled(_controller, env) {
      await cleanup(env.DB, now());
      await billing(env, fetchImpl, now()).scheduled();
    }
  };
}

async function route(request, env, url, fetchImpl, now) {
  const db = env.DB;
  if (!db) fail(503, 'Hosted service is not configured.');
  if (request.method === 'POST' && url.pathname === '/v1/installations') {
    if (env.TRIAL_ENABLED !== 'true' || !env.IP_HASH_SECRET) fail(503, 'The free pilot is not open yet.');
    const data = await bodyJSON(request, 1024);
    if (data.adultConsent !== true || data.dataConsent !== true) fail(400, 'Confirm age and data processing before starting.');
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) fail(503, 'Trial registration is unavailable.');
    const ipHash = await sign(ip, env.IP_HASH_SECRET);
    const id = crypto.randomUUID();
    const credential = `ci_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
    const source = ['chrome-web-store', 'community', 'demo', 'direct'].includes(data.source) ? data.source : 'direct';
    const result = await db.batch([
      stmt(db, `INSERT INTO installations(id,credential_hash,ip_hash,source,created_at,last_seen_at)
        SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM installations)<100
        AND (SELECT COUNT(*) FROM installations WHERE ip_hash=? AND created_at>?)<3`,
      id, await hash(credential), ipHash, source, now, now, ipHash, now - 86400000),
      stmt(db, `INSERT INTO credit_lots(id,installation_id,granted,created_at)
        SELECT ?,id,10,? FROM installations WHERE id=?`, `trial:${id}`, now, id)
    ]);
    if (!result[0].meta.changes) fail(429, 'The trial limit has been reached. Try later or contact support.');
    return json({ credential, installationId: id, ...await billing(env, fetchImpl, now).snapshot(id) }, 201);
  }
  const id = await identity(request, db);
  await expire(db, now);
  if (request.method === 'GET' && url.pathname === '/v1/balance') {
    await db.batch([
      stmt(db, `INSERT INTO events(installation_id,kind,created_at) SELECT id,'session_started',? FROM installations WHERE id=? AND last_seen_at<?`, now, id, now - 1800000),
      stmt(db, 'UPDATE installations SET last_seen_at=? WHERE id=?', now, id)
    ]);
    return json(await billing(env, fetchImpl, now).snapshot(id));
  }
  if (request.method === 'POST' && ['/v1/checkout', '/v1/subscription/preview', '/v1/subscription/change', '/v1/billing-portal'].includes(url.pathname)) {
    const service = billing(env, fetchImpl, now);
    const data = await bodyJSON(request, 4096);
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Invalid billing request.');
    if (url.pathname === '/v1/checkout') return json(await service.checkout(id, data));
    if (url.pathname === '/v1/subscription/preview') return json(await service.preview(id, data));
    if (url.pathname === '/v1/subscription/change') return json(await service.change(id, data));
    return json(await service.portal(id));
  }
  if (request.method === 'POST' && url.pathname === '/v1/answers') {
    if (env.INFERENCE_ENABLED !== 'true' || !env.OPENROUTER_API_KEY) fail(503, 'Hosted answers are paused. Your balance is unchanged.');
    const data = await bodyJSON(request);
    const input = requestData(data, env);
    input.body.provider = { only: ['typesafe'], allow_fallbacks: false,
      max_price: { prompt: 0.042, completion: 0, request: 0, image: 0 } };
    const previous = await stmt(db, 'SELECT status FROM requests WHERE id=?', data.requestId).first();
    if (previous) fail(409, 'This request was already received. Refresh your balance before trying again.');
    const recent = await stmt(db, 'SELECT COUNT(*) AS n FROM requests WHERE installation_id=? AND created_at>?', id, now - 60000).first();
    if (recent.n >= 20) fail(429, 'Please wait before answering more questions.');
    try {
      const result = await stmt(db, `INSERT INTO requests(id,installation_id,lot_id,mode,created_at,expires_at,cost_nano)
        SELECT ?,?,id,?,?,?,? FROM credit_lots WHERE installation_id=? AND granted-revoked-consumed-reserved>0 AND (expires_at IS NULL OR expires_at>?) ORDER BY expires_at IS NULL,expires_at,created_at,id LIMIT 1`,
      data.requestId, id, input.mode, now, now + 120000, RESERVE_NANO, id, now).run();
      if (!result.meta.changes) fail(402, 'No credits left. Upgrade your plan, wait for renewal, or use your own API key.');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const detail = String(error.message);
      if (detail.includes('budget_exhausted')) fail(503, 'Hosted answers are paused at the pilot spending limit. Your balance is unchanged.');
      if (detail.includes('no_credits')) fail(402, 'No credits left. Upgrade your plan, wait for renewal, or use your own API key.');
      fail(409, 'Another answer is active. Please wait before trying again.');
    }
    await stmt(db, 'UPDATE installations SET last_seen_at=? WHERE id=?', now, id).run();
    const started = Date.now();
    try {
      const response = await fetchImpl(C.providers.openrouter.endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input.body), signal: AbortSignal.timeout(15000), credentials: 'omit'
      });
      // Provider errors might contain billable usage. Missing usage retains the conservative reserve.
      let result;
      try { result = JSON.parse(await readBody(response, 256000)); } catch { result = null; }
      const tokens = result?.usage?.input_tokens;
      const measured = Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 262144;
      const cost = result?.usage?.cost;
      const reportedCost = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 &&
        Number.isSafeInteger(Math.ceil(cost * 1e9));
      await stmt(db, `UPDATE requests SET cost_nano=?, cost_final=1, input_tokens=?, api_ms=? WHERE id=? AND cost_final=0`,
        reportedCost ? Math.ceil(cost * 1e9) : measured ? Math.ceil(tokens * 42) : RESERVE_NANO,
        measured ? tokens : null, Date.now() - started, data.requestId).run();
      if (!response.ok) fail(response.status === 429 ? 429 : 502, 'AI provider could not answer. No credit consumed.');
      let parsed;
      try { parsed = input.mode === 'vision' ? C.parseVision(result, 'openrouter') : C.parseAnswer(result, input.count, 'openrouter'); }
      catch (error) { fail(422, error.message); }
      const changed = await stmt(db, `UPDATE requests SET status='ready' WHERE id=? AND status='reserved' AND expires_at>?`, data.requestId, Date.now()).run();
      if (!changed.meta.changes) fail(409, 'Request expired. No credit consumed.');
      return json({ requestId: data.requestId, result: parsed, apiMs: Date.now() - started });
    } catch (error) {
      await stmt(db, `UPDATE requests SET status='released',completed_at=? WHERE id=? AND status IN ('reserved','ready')`, Date.now(), data.requestId).run();
      if (error instanceof HttpError) throw error;
      fail(502, 'AI request failed or expired. No credit consumed.');
    }
  }
  if (request.method === 'POST' && url.pathname === '/v1/answers/complete') {
    const data = await bodyJSON(request, 1024);
    if (typeof data.delivered !== 'boolean' || !/^[a-f0-9-]{36}$/.test(data.requestId || '')) fail(400, 'Invalid completion.');
    const row = await stmt(db, 'SELECT status FROM requests WHERE id=? AND installation_id=?', data.requestId, id).first();
    if (!row) fail(404, 'Request not found.');
    if (data.delivered && row.status === 'reserved') fail(409, 'No validated answer is ready.');
    await stmt(db, `UPDATE requests SET status=?,completed_at=? WHERE id=? AND installation_id=? AND status IN ('reserved','ready')`,
      data.delivered ? 'settled' : 'released', now, data.requestId, id).run();
    return json(await billing(env, fetchImpl, now).snapshot(id));
  }
  fail(404, 'Endpoint not found.');
}

export default createWorker();
