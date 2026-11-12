const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subscriptions } = require('./helpers/subscriptions.cjs');

for (const planId of ['basic','plus']) test(`${planId} Checkout uses fixed monthly prices; paid invoices grant once, not redirects`, async t => {
  const s = await subscriptions(t); const user = await s.register();
  for(const invalid of ['constructor','__proto__','yearly',null]) assert.equal((await s.req('checkout',{checkoutId:crypto.randomUUID(),planId:invalid},user.credential)).status,400);
  assert.equal((await s.req('billing-portal',null,user.credential)).status,400);
  assert.equal(Object.keys(s.remote.customers).length,0);
  const session = await s.checkout(user, planId);
  assert.equal((await s.balance(user)).credits, 15);
  await s.checkout(user, planId);
  assert.equal(Object.keys(s.remote.sessions).length, 1);
  const call = s.calls.find(c => c.url.endsWith('/checkout/sessions'));
  const form = new URLSearchParams(call.options.body);
  assert.equal(form.get('mode'), 'subscription'); assert.equal(form.get('line_items[0][price]'), `price_${planId}`);
  assert.equal(form.get('line_items[0][quantity]'), '1'); assert.equal(form.has('allow_promotion_codes'), false);
  assert.equal(form.get('subscription_data[metadata][clickit_installation]'), user.installationId);
  assert.match(form.get('custom_text[submit][message]'), /Renews monthly until canceled/);
  assert.match(form.get('custom_text[submit][message]'), /https:\/\/clickit.example\/terms.html/);
  assert.match(form.get('custom_text[submit][message]'), /https:\/\/clickit.example\/privacy.html/);
  const sub = await s.complete(user, planId);
  const amount = planId === 'basic' ? 500 : 1200;
  assert.equal((await s.balance(user)).monthlyCredits, amount);
  assert.equal((await s.balance(user)).otherCredits, 15);
  await s.notify('invoice.paid', { id: sub.latest_invoice }); await s.notify('invoice.paid', { id: sub.latest_invoice });
  assert.equal((await s.balance(user)).monthlyCredits, amount);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM subscription_invoices').get().n, 1);
  assert.equal((await s.req('checkout', { checkoutId: crypto.randomUUID(), planId }, user.credential)).status, 409);
  assert.equal((await s.balance(user)).subscription.periodEnd, sub.current_period_end*1000);
  assert.equal(session.id, Object.keys(s.remote.sessions)[0]);
});

test('declined initial payments and authentication-required renewals grant nothing until successful payment', async t => {
  const s = await subscriptions(t); const user = await s.register();
  const sub = await s.complete(user, 'basic', false);
  assert.equal((await s.balance(user)).monthlyCredits, 0);
  assert.equal((await s.balance(user)).subscription.paymentActionRequired, true);
  const inv = s.remote.invoices[sub.latest_invoice]; inv.paid = true; inv.status = 'paid'; sub.status = 'active';
  await s.notify('invoice.paid', { id: inv.id });
  assert.equal((await s.balance(user)).monthlyCredits, 500);
  s.advance(30*86400000); sub.current_period_start = sub.current_period_end; sub.current_period_end += 30*86400;
  const renewal = s.invoice(sub, 'monthly', false); sub.status = 'past_due';
  await s.notify('invoice.payment_action_required', { id: renewal.id });
  assert.equal((await s.balance(user)).monthlyCredits, 0);
  renewal.paid = true; renewal.status = 'paid'; sub.status = 'active';
  await s.notify('invoice.paid', { id: renewal.id });
  assert.equal((await s.balance(user)).monthlyCredits, 500);
});

test('upgrade adds 700 after payment, preserves consumed usage and renewal, and survives reordered events', async t => {
  const s = await subscriptions(t); const user = await s.register(); const sub = await s.complete(user);
  s.db.sql.prepare('UPDATE credit_lots SET consumed=300 WHERE subscription_invoice_id=?').run(sub.latest_invoice);
  s.advance(15*86400000); const end = sub.current_period_end;
  const result = await s.upgrade(user);
  assert.equal(result.monthlyCredits, 900); assert.equal(result.subscription.periodEnd, end*1000);
  const upgradeId = sub.latest_invoice;
  await s.notify('invoice.paid', { id: upgradeId });
  // An old event carries old payload, but authoritative retrieval keeps Plus.
  await s.notify('customer.subscription.updated', { id: sub.id, status: 'active', items: { data: [{ price: 'price_basic' }] } });
  assert.equal((await s.balance(user)).monthlyCredits, 900);
  assert.equal((await s.balance(user)).subscription.planId, 'plus');
  // Next month replenishes to 1,200; unused previous credits expire.
  s.advance(15*86400000); sub.current_period_start = end; sub.current_period_end += 30*86400;
  const renewal = s.invoice(sub); await s.notify('invoice.paid', { id: renewal.id });
  assert.equal((await s.balance(user)).monthlyCredits, 1200);
});

test('pending upgrades retain Basic credits until payment recovery; expired or cross-owner quotes fail', async t => {
  const s = await subscriptions(t); const user = await s.register(); const other = await s.register();
  const sub = await s.complete(user); await s.complete(other);
  const quote = await (await s.req('subscription/preview', { planId: 'plus' }, user.credential)).json();
  assert.equal((await s.change(other, 'upgrade', { quoteId: quote.quoteId })).status, 409);
  s.advance(300001);
  assert.equal((await s.change(user, 'upgrade', { quoteId: quote.quoteId })).status, 409);
  s.remote.failUpgrade = true;
  const result = await s.upgrade(user);
  assert.equal(result.monthlyCredits, 500); assert.equal(result.subscription.pendingUpgrade, true);
  assert.equal(result.subscription.paymentActionRequired, true);
  const inv = s.remote.invoices[sub.latest_invoice]; inv.paid = true; inv.status = 'paid';
  sub.pending_update = null; sub.items.data[0].price.id = 'price_plus';
  await s.notify('customer.subscription.pending_update_applied', { id: sub.id });
  assert.equal((await s.balance(user)).monthlyCredits, 1200);
});

test('downgrades are scheduled, replaceable, and cancellation preserves paid credits until period end', async t => {
  const s = await subscriptions(t); const user = await s.register(); const sub = await s.complete(user, 'plus');
  assert.equal((await s.change(user, 'downgrade')).status, 200);
  assert.equal((await s.balance(user)).subscription.scheduledPlan, 'basic');
  assert.equal((await s.balance(user)).monthlyCredits, 1200);
  assert.equal((await s.change(user, 'keep_plan')).status, 200);
  assert.equal((await s.balance(user)).subscription.scheduledPlan, null);
  await s.change(user, 'downgrade');
  assert.equal((await s.change(user, 'cancel')).status, 200);
  assert.equal((await s.balance(user)).subscription.cancelAtPeriodEnd, true);
  assert.equal((await s.balance(user)).subscription.scheduledPlan, null);
  assert.equal((await s.balance(user)).monthlyCredits, 1200);
  assert.equal((await s.change(user, 'resume')).status, 200);
  assert.equal((await s.balance(user)).subscription.cancelAtPeriodEnd, false);
  await s.change(user, 'cancel'); s.advance(30*86400000); sub.status = 'canceled';
  await s.notify('customer.subscription.deleted', { id: sub.id });
  assert.equal((await s.balance(user)).monthlyCredits, 0);
  assert.equal((await s.balance(user)).otherCredits, 15);
  // Old completed checkout must not block a new subscription forever.
  await s.complete(user, 'basic');
  assert.equal((await s.balance(user)).monthlyCredits, 500);
});

test('monthly expiry is enforced in SQL, consumes monthly credits first, and allows an existing reservation to settle', async t => {
  const s = await subscriptions(t); const user = await s.register(); const sub = await s.complete(user);
  s.advance(30*86400000-1000);
  const answer = await s.solve(user.credential); assert.equal(answer.response.status, 200);
  const lot = s.db.sql.prepare('SELECT * FROM credit_lots WHERE subscription_invoice_id=?').get(sub.latest_invoice);
  assert.equal(lot.reserved, 1);
  s.advance(1001);
  const complete = await s.req('answers/complete', { requestId: answer.requestId, delivered: true }, user.credential);
  assert.equal(complete.status, 200);
  assert.equal((await complete.json()).monthlyCredits, 0);
  assert.equal(s.db.sql.prepare('SELECT consumed FROM credit_lots WHERE id=?').get(lot.id).consumed, 1);
  assert.throws(() => s.db.sql.prepare("INSERT INTO requests(id,installation_id,lot_id,mode,created_at,expires_at,cost_nano) VALUES(?,?,?,'text',?,?,11010048)")
    .run(crypto.randomUUID(), user.installationId, lot.id, s.time(), s.time()+120000), /no_credits/);
  assert.equal((await s.balance(user)).otherCredits, 15);
});

test('signed webhooks reject tampered products, owners, quantities and live environments', async t => {
  const s = await subscriptions(t); const user = await s.register(); const sub = await s.complete(user);
  const inv = s.remote.invoices[sub.latest_invoice];
  for (const mutate of [i => { i.currency='thb'; }, i => { i.customer='cus_other'; }, i => { i.lines.data[0].price.id='price_unknown'; },
    i => { i.lines.data[0].quantity=2; }, i => { i.livemode=true; }, i => { i.lines.data[0].amount=1; }]) {
    const original = structuredClone(inv); mutate(inv);
    assert.equal((await s.notify('invoice.paid', { id: inv.id })).status, 400);
    Object.assign(inv, original);
  }
  assert.equal((await s.notify('invoice.paid', { id: inv.id }, { forged: true })).status, 400);
  assert.equal((await s.notify('invoice.paid', { id: inv.id }, { age: 301 })).status, 400);
  assert.equal((await s.balance(user)).monthlyCredits, 500);
});

test('refunds affect only the paid invoice including refunds preceding fulfillment', async t => {
  const s = await subscriptions(t); const user = await s.register(); const sub = await s.complete(user);
  const base = s.remote.invoices[sub.latest_invoice]; await s.upgrade(user);
  const upgrade = s.remote.invoices[sub.latest_invoice];
  s.remote.intents[upgrade.payment_intent].latest_charge.amount_refunded=upgrade.total;
  await s.notify('charge.refunded', { invoice: upgrade.id, payment_intent: upgrade.payment_intent, amount_refunded: upgrade.total });
  assert.equal((await s.balance(user)).monthlyCredits, 500);
  await s.notify('invoice.paid', { id: upgrade.id });
  assert.equal((await s.balance(user)).monthlyCredits, 500);
  s.remote.intents[base.payment_intent].latest_charge.amount_refunded=100;
  await s.notify('charge.refunded', { invoice: base.id, payment_intent: base.payment_intent, amount_refunded: 100 });
  assert.equal((await s.balance(user)).monthlyCredits, 399);
  assert.equal((await s.balance(user)).otherCredits, 15);
});

test('maintenance recovers missed renewals, key restoration shares state, and billing portal works behind checkout gate', async t => {
  const s = await subscriptions(t); const user = await s.register(); const sub = await s.complete(user);
  s.advance(30*86400000); sub.current_period_start=sub.current_period_end; sub.current_period_end+=30*86400;
  s.invoice(sub); await s.worker.scheduled({}, s.env);
  assert.equal((await s.balance(user)).monthlyCredits, 500);
  const restored = await (await s.req('balance', undefined, user.credential)).json();
  assert.equal(restored.subscription.planId, 'basic');
  s.env.CHECKOUT_ENABLED='false';
  const portal = await s.req('billing-portal', {}, user.credential);
  assert.equal(portal.status, 200); assert.equal((await portal.json()).url, 'https://billing.stripe.com/p/session_test');
  assert.equal((await s.change(user, 'cancel')).status, 200);
  assert.equal((await s.req('subscription/preview', { planId: 'plus' }, user.credential)).status, 403);
  s.remote.portalUpdates=true;
  assert.equal((await s.req('billing-portal', {}, user.credential)).status, 503);
});

test('lost Checkout and upgrade responses retry the same remote operation without duplicate charges', async t => {
  const s = await subscriptions(t); const user = await s.register();
  s.remote.after=async ({path,method}) => { if (path==='checkout/sessions' && method==='POST') { s.remote.after=null; throw new TypeError('Response lost'); } };
  assert.equal((await s.req('checkout', { checkoutId:crypto.randomUUID(), planId:'basic' }, user.credential)).status, 503);
  await s.checkout(user);
  assert.equal(Object.keys(s.remote.sessions).length,1);
  const sub=await s.complete(user);
  s.advance(10*86400000);
  const quote=await (await s.req('subscription/preview', {planId:'plus'}, user.credential)).json();
  const changeId=crypto.randomUUID();
  s.remote.after=async ({path,method}) => { if (path===`subscriptions/${sub.id}` && method==='POST') { s.remote.after=null; throw new TypeError('Response lost after charging'); } };
  const request=()=>s.req('subscription/change', {changeId,action:'upgrade',quoteId:quote.quoteId}, user.credential);
  assert.equal((await request()).status,503);
  assert.equal(sub.items.data[0].price.id,'price_plus');
  // A restored browser has no original request ID, but can still manage billing.
  assert.equal((await s.change(user,'cancel')).status,200);
  assert.equal((await request()).status,200);
  assert.equal((await request()).status,200);
  assert.equal(Object.values(s.remote.invoices).filter(i=>i.billing_reason==='subscription_update').length,1);
  assert.equal((await s.balance(user)).monthlyCredits,1200);
  const other=await s.register();
  assert.equal((await s.req('subscription/change', {changeId,action:'upgrade',quoteId:quote.quoteId}, other.credential)).status,403);
});

test('billing retries return the current balance and the recorded outcome', async t => {
  const s = await subscriptions(t); const user = await s.register(); await s.complete(user);
  const data = { changeId: crypto.randomUUID(), action: 'cancel' };
  const initial = await (await s.req('subscription/change', data, user.credential)).json();
  // Previously stored operations include a full snapshot. It must not overwrite today's balance.
  s.db.sql.prepare('UPDATE billing_operations SET result=? WHERE id=?').run(JSON.stringify(initial), data.changeId);
  const answer = await s.solve(user.credential);
  assert.equal(answer.response.status, 200);
  await s.req('answers/complete', { requestId: answer.requestId, delivered: true }, user.credential);
  const retry = await (await s.req('subscription/change', data, user.credential)).json();
  assert.equal(retry.credits, initial.credits - 1);
  assert.equal(retry.changed, true);
  // An expired, reconciled upgrade can be recorded as unchanged.
  s.db.sql.prepare('UPDATE billing_operations SET result=? WHERE id=?').run(JSON.stringify({ changed: false }), data.changeId);
  assert.equal((await (await s.req('subscription/change', data, user.credential)).json()).changed, false);
});

test('concurrent checkout attempts serialize across handlers and changing tiers expires the old session', async t => {
  const s=await subscriptions(t); const user=await s.register();
  let entered, release;
  const reached=new Promise(resolve=>{entered=resolve;}); const blocked=new Promise(resolve=>{release=resolve;});
  s.remote.before=async ({path})=>{if(path==='customers'){entered();await blocked;}};
  const pending=s.req('checkout', {checkoutId:crypto.randomUUID(),planId:'basic'},user.credential);
  await reached;
  assert.equal((await s.req('checkout',{checkoutId:crypto.randomUUID(),planId:'plus'},user.credential)).status,409);
  release(); assert.equal((await pending).status,200);
  const initial=Object.values(s.remote.sessions)[0];
  await s.checkout(user,'plus');
  assert.equal(initial.status,'expired');
  assert.equal(Object.values(s.remote.sessions).filter(x=>x.status==='open').length,1);
  assert.equal(Object.values(s.remote.customers).length,1);
});

test('a scheduled downgrade renews with 500 credits; paginated reconciliation handles upgrades delivered before initial invoices', async t=>{
  const s=await subscriptions(t);const user=await s.register();const sub=await s.complete(user,'plus');
  await s.change(user,'downgrade');
  s.advance(30*86400000);sub.current_period_start=sub.current_period_end;sub.current_period_end+=30*86400;
  sub.items.data[0].price.id='price_basic';sub.schedule=null;
  const renewal=s.invoice(sub);await s.notify('invoice.paid',{id:renewal.id});
  assert.equal((await s.balance(user)).monthlyCredits,500);
  assert.equal((await s.balance(user)).subscription.planId,'basic');
  s.advance(10*86400000);await s.upgrade(user);
  // Simulate missing local fulfillment with both paid invoices already in Stripe.
  s.db.sql.exec('DELETE FROM credit_lots WHERE subscription_invoice_id IS NOT NULL; DELETE FROM subscription_invoices; DELETE FROM subscription_periods');
  s.remote.invoicePageSize=1;
  await s.notify('invoice.paid',{id:sub.latest_invoice});
  assert.equal((await s.balance(user)).monthlyCredits,1200);
  assert.equal(s.db.sql.prepare('SELECT COUNT(*) AS n FROM subscription_invoices').get().n,3);
});

test('pre-fulfillment refunds never expose spendable credits; reconciliation repairs missing fees and retains legacy balances', async t=>{
  const s=await subscriptions(t);const user=await s.register();const sub=await s.complete(user);
  const invoice=s.remote.invoices[sub.latest_invoice];
  s.db.sql.exec('DELETE FROM credit_lots WHERE subscription_invoice_id IS NOT NULL; DELETE FROM subscription_invoices; DELETE FROM subscription_periods');
  s.remote.intents[invoice.payment_intent].latest_charge.amount_refunded=invoice.total;
  await s.notify('charge.refunded',{invoice:invoice.id,payment_intent:invoice.payment_intent,amount_refunded:invoice.total});
  assert.equal((await s.balance(user)).monthlyCredits,0);
  assert.equal((await s.balance(user)).otherCredits,15);
  assert.equal(s.db.sql.prepare('SELECT revoked FROM credit_lots WHERE subscription_invoice_id=?').get(invoice.id).revoked,500);
  s.db.sql.exec('UPDATE subscription_invoices SET stripe_fee=NULL,stripe_fee_currency=NULL');
  await s.worker.scheduled({},s.env);
  assert.equal(s.db.sql.prepare('SELECT stripe_fee FROM subscription_invoices').get().stripe_fee,45);
  assert.equal((await s.balance(user)).monthlyCredits,0);
});
