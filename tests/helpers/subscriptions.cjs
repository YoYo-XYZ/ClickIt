const assert = require('node:assert/strict');
const { setup } = require('./server.cjs');

async function subscriptions(t) {
  const s = await setup(t);
  const remote = { customers: {}, sessions: {}, subscriptions: {}, invoices: {}, intents: {}, schedules: {}, idempotency: new Map(),
    failUpgrade: false, failRenewal: false, portalUpdates: false, sequence: 0 };
  const next = prefix => `${prefix}_${++remote.sequence}`;
  const clone = value => structuredClone(value);
  const second = () => Math.floor(s.time()/1000);
  function invoice(sub, kind = 'monthly', paid = true) {
    const id = next('in');
    const basic = sub.items.data[0].price.id === 'price_basic';
    const price = basic ? 'price_basic' : 'price_plus';
    const line = (priceId, amount, proration) => ({ type: proration ? 'invoiceitem' : 'subscription', subscription: sub.id, subscription_item: sub.items.data[0].id,
      quantity: 1, currency: 'usd', price: { id: priceId }, amount, proration,
      period: { start: kind === 'upgrade' ? second() : sub.current_period_start, end: sub.current_period_end } });
    const lines = kind === 'upgrade' ? [line('price_basic', -249, true), line('price_plus', 499, true)] : [line(price, basic ? 499 : 999, false)];
    const amount = lines.reduce((n,l) => n+l.amount,0);
    const pi = next('pi');
    remote.intents[pi] = { id: pi, latest_charge: { id: next('ch'), amount_refunded: 0, balance_transaction: { fee: 45, currency: 'thb' } } };
    const row = { id, livemode: false, customer: sub.customer, subscription: sub.id, currency: 'usd', subtotal: amount, total: amount,
      amount_due: amount, paid, status: paid ? 'paid' : 'open', created: second(), payment_intent: pi, discounts: [],
      hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, billing_reason: kind === 'upgrade' ? 'subscription_update' : 'subscription_cycle',
      lines: { has_more: false, data: lines }, total_tax_amounts: [] };
    remote.invoices[id] = row;
    sub.latest_invoice = id;
    return row;
  }
  s.state.stripe = async (raw, options) => {
    const url = new URL(raw);
    const path = url.pathname.replace('/v1/','');
    const form = new URLSearchParams(options.body);
    const method = options.method;
    assert.equal(options.headers['Stripe-Version'], '2024-06-20');
    const key = options.headers['Idempotency-Key'];
    if (key && remote.idempotency.has(key)) return Response.json(clone(remote.idempotency.get(key)));
    if (remote.before) await remote.before({ path, method, form });
    let result;
    if (path.startsWith('prices/')) {
      const basic = path.endsWith('price_basic');
      result = { id: basic ? 'price_basic' : 'price_plus', active: true, livemode: false, currency: 'usd', unit_amount: basic ? 499 : 999,
        type: 'recurring', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, product: 'prod_clickit', tax_behavior: 'exclusive' };
    } else if (path === 'customers') {
      result = { id: next('cus'), metadata: { clickit_installation: form.get('metadata[clickit_installation]') } };
      remote.customers[result.id] = result;
    } else if (path === 'subscriptions') {
      result = { data: Object.values(remote.subscriptions).filter(sub => sub.customer === url.searchParams.get('customer')).map(clone), has_more: false };
    } else if (path === 'invoices/upcoming') {
      result = { currency: 'usd', amount_due: 250 };
    } else if (path === 'invoices') {
      let rows = Object.values(remote.invoices).filter(i => i.subscription === url.searchParams.get('subscription') && i.paid).reverse();
      if (url.searchParams.has('starting_after')) rows=rows.slice(rows.findIndex(i => i.id===url.searchParams.get('starting_after'))+1);
      const limit=remote.invoicePageSize || 100;
      result = { data: rows.slice(0,limit).map(clone), has_more: rows.length>limit };
    } else if (path.startsWith('invoices/')) result = remote.invoices[path.split('/')[1]];
    else if (path.startsWith('payment_intents/')) result = remote.intents[path.split('/')[1]];
    else if (path === 'checkout/sessions') {
      result = { id: next('cs'), url: 'https://checkout.stripe.com/c/pay_test', status: 'open', livemode: false,
        mode: form.get('mode'), customer: form.get('customer'), client_reference_id: form.get('client_reference_id'),
        metadata: { clickit_checkout: form.get('metadata[clickit_checkout]') }, expires_at: second()+86400,
        plan: form.get('line_items[0][price]'), installation: form.get('subscription_data[metadata][clickit_installation]') };
      remote.sessions[result.id] = result;
    } else if (path.startsWith('checkout/sessions/')) {
      result = remote.sessions[path.split('/')[2]];
      if (path.endsWith('/expire')) result.status = 'expired';
    } else if (path.startsWith('subscriptions/')) {
      result = remote.subscriptions[path.split('/')[1]];
      if (method === 'POST') {
        if (form.has('cancel_at_period_end')) result.cancel_at_period_end = form.get('cancel_at_period_end') === 'true';
        if (form.has('items[0][price]')) {
          assert.equal(form.get('payment_behavior'), 'pending_if_incomplete');
          assert.equal(form.get('proration_behavior'), 'always_invoice');
          const inv = invoice(result, 'upgrade', !remote.failUpgrade);
          if (remote.failUpgrade) result.pending_update = { subscription_items: [{ price: 'price_plus' }] };
          else { result.items.data[0].price.id = 'price_plus'; result.pending_update = null; }
          result.latest_invoice = inv.id;
        }
      }
    } else if (path === 'subscription_schedules') {
      const sub = remote.subscriptions[form.get('from_subscription')];
      result = { id: next('sub_sched'), subscription: sub.id, current_phase: { start_date: sub.current_period_start, end_date: sub.current_period_end }, phases: [] };
      remote.schedules[result.id] = result; sub.schedule = result.id;
    } else if (path.startsWith('subscription_schedules/')) {
      result = remote.schedules[path.split('/')[1]];
      if (path.endsWith('/release')) remote.subscriptions[result.subscription].schedule = null;
      else if (method === 'POST') result.phases = [{ start_date: Number(form.get('phases[0][start_date]')), end_date: Number(form.get('phases[0][end_date]')), items: [{ price: 'price_plus' }] },
        { start_date: Number(form.get('phases[0][end_date]')), items: [{ price: form.get('phases[1][items][0][price]') }] }];
    } else if (path.startsWith('billing_portal/configurations/')) {
      result = { active: true, features: { subscription_update: { enabled: remote.portalUpdates }, subscription_cancel: { enabled: true, mode: 'at_period_end' },
        payment_method_update: { enabled: true }, invoice_history: { enabled: true } } };
    } else if (path === 'billing_portal/sessions') result = { url: 'https://billing.stripe.com/p/session_test' };
    else throw new Error(`Unexpected Stripe request: ${method} ${path}`);
    if (!result) return Response.json({ error: 'not found' }, { status: 404 });
    if (key) remote.idempotency.set(key, clone(result));
    if (remote.after) await remote.after({ path, method, form, result });
    return Response.json(clone(result));
  };
  async function checkout(user, planId = 'basic', checkoutId = crypto.randomUUID()) {
    const response = await s.req('checkout', { checkoutId, planId, amount: 1, credits: 999999 }, user.credential);
    assert.equal(response.status, 200, await response.clone().text());
    return Object.values(remote.sessions).at(-1);
  }
  async function complete(user, planId = 'basic', paid = true) {
    const session = await checkout(user, planId);
    const sub = { id: next('sub'), customer: session.customer, metadata: { clickit_installation: user.installationId }, livemode: false,
      currency: 'usd', status: paid ? 'active' : 'incomplete', current_period_start: second(), current_period_end: second()+30*86400,
      items: { data: [{ id: next('si'), quantity: 1, price: { id: session.plan } }] }, cancel_at_period_end: false, pending_update: null, schedule: null };
    remote.subscriptions[sub.id] = sub;
    const inv = invoice(sub, 'monthly', paid); inv.billing_reason = 'subscription_create';
    session.status = 'complete'; session.subscription = sub.id;
    const response = await s.notify('checkout.session.completed', { id: session.id });
    assert.equal(response.status, 200, await response.clone().text());
    return sub;
  }
  async function balance(user) { return (await s.req('balance', undefined, user.credential)).json(); }
  async function change(user, action, extra = {}) { return s.req('subscription/change', { action, changeId: crypto.randomUUID(), ...extra }, user.credential); }
  async function upgrade(user) {
    const quote = await s.req('subscription/preview', { planId: 'plus' }, user.credential);
    assert.equal(quote.status, 200, await quote.clone().text());
    const data = await quote.json();
    const response = await change(user, 'upgrade', { quoteId: data.quoteId });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  return { ...s, remote, invoice, checkout, complete, balance, change, upgrade };
}
module.exports = { subscriptions };
