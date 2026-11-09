// Stripe's pinned 2024-06-20 contract is kept in worker.mjs. No browser-provided
// amount, allowance, customer, subscription, or Stripe price is authoritative.
const PLANS = Object.freeze({
  basic: Object.freeze({ id: 'basic', amount: 499, credits: 500 }),
  plus: Object.freeze({ id: 'plus', amount: 999, credits: 1200 })
});
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const objectId = value => typeof value === 'string' ? value : value?.id;
const terminal = status => ['canceled', 'incomplete_expired'].includes(status);
const available = 'MAX(0,granted-revoked-consumed-reserved)';

export function billingService({ env, stripe, now, fail }) {
  const db = env.DB;
  const started = Date.now();
  let activeLease = null;
  const transport = stripe;
  async function heartbeat() {
    if (!activeLease) return;
    const time = now + Date.now() - started;
    const updated = await stmt(db, 'UPDATE billing_accounts SET lease_until=? WHERE installation_id=? AND lease_id=? AND lease_until>?',
      time+120000, activeLease.owner, activeLease.id, time).run();
    if (!updated.meta.changes) fail(409, 'Billing operation expired. Refresh and try again.');
  }
  stripe = async (...args) => {
    await heartbeat();
    const result = await transport(...args);
    await heartbeat();
    return result;
  };
  const prices = { basic: env.STRIPE_BASIC_PRICE_ID, plus: env.STRIPE_PLUS_PRICE_ID };
  const planForPrice = value => Object.values(PLANS).find(p => prices[p.id] && prices[p.id] === objectId(value));
  const assertLive = value => { if (value.livemode !== (env.STRIPE_LIVE_MODE === 'true')) fail(400, 'Incorrect payment environment.'); };
  const publicUrl = () => {
    try { const url = new URL(env.PUBLIC_URL); if (url.protocol === 'https:' && url.origin === env.PUBLIC_URL) return url.origin; } catch {}
    fail(503, 'Payments are not configured.');
  };
  const checkoutEnabled = () => { if (env.CHECKOUT_ENABLED !== 'true') fail(403, 'Subscriptions are not available yet. Your credits are preserved.'); };
  const validatePlan = id => { if (typeof id !== 'string' || !Object.hasOwn(PLANS,id) || !prices[id]) fail(400, 'Choose an available subscription plan.'); return PLANS[id]; };
  async function locked(owner, action) {
    await stmt(db, 'INSERT INTO billing_accounts(installation_id) VALUES(?) ON CONFLICT DO NOTHING', owner).run();
    const lease = crypto.randomUUID();
    const acquired = await stmt(db, 'UPDATE billing_accounts SET lease_id=?,lease_until=? WHERE installation_id=? AND lease_until<=?',
      lease, now + 120000, owner, now).run();
    if (!acquired.meta.changes) fail(409, 'Billing is syncing. Refresh and try again.');
    activeLease = { owner, id: lease };
    try { return await action(await stmt(db, 'SELECT * FROM billing_accounts WHERE installation_id=?', owner).first()); }
    finally {
      activeLease = null;
      await stmt(db, 'UPDATE billing_accounts SET lease_id=NULL,lease_until=0 WHERE installation_id=? AND lease_id=?', owner, lease).run();
    }
  }
  async function catalog() {
    const products = [];
    for (const plan of Object.values(PLANS)) {
      validatePlan(plan.id);
      const price = await stripe(`prices/${prices[plan.id]}`);
      assertLive(price);
      if (!price.active || price.currency !== 'usd' || price.unit_amount !== plan.amount || price.type !== 'recurring' ||
        price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed' ||
        price.tax_behavior !== 'exclusive') fail(503, 'Subscription prices are not configured correctly.');
      products.push(objectId(price.product));
    }
    if (!products[0] || products[0] !== products[1]) fail(503, 'Subscription prices must share a product.');
  }
  async function current(owner) {
    return stmt(db, `SELECT * FROM subscriptions WHERE installation_id=? ORDER BY
      CASE WHEN status NOT IN ('canceled','incomplete_expired') THEN 0 ELSE 1 END,period_end DESC LIMIT 1`, owner).first();
  }
  async function snapshot(owner) {
    const row = await stmt(db, `SELECT COALESCE(SUM(${available}),0) AS credits,
      COALESCE(SUM(CASE WHEN expires_at IS NOT NULL THEN ${available} ELSE 0 END),0) AS monthlyCredits,
      COALESCE(SUM(CASE WHEN expires_at IS NULL THEN ${available} ELSE 0 END),0) AS otherCredits
      FROM credit_lots WHERE installation_id=? AND (expires_at IS NULL OR expires_at>?)`, owner, now).first();
    const held = await stmt(db, 'SELECT COALESCE(SUM(reserved),0) AS reserved FROM credit_lots WHERE installation_id=?', owner).first();
    const sub = await current(owner);
    const account = await stmt(db, 'SELECT customer_id,reconcile_error FROM billing_accounts WHERE installation_id=?', owner).first();
    const period = sub ? await stmt(db, 'SELECT allowance FROM subscription_periods WHERE subscription_id=? AND period_start=?', sub.id, sub.period_start).first() : null;
    return { ...row, ...held, checkoutEnabled: env.CHECKOUT_ENABLED === 'true',
      visionEnabled: env.VISION_ENABLED === 'true',
      billingManagementAvailable: Boolean(account?.customer_id && env.STRIPE_PORTAL_CONFIGURATION_ID),
      billingSyncError: Boolean(account?.reconcile_error),
      subscription: sub ? { planId: sub.plan_id, status: sub.status, allowance: period?.allowance || 0,
        periodStart: sub.period_start, periodEnd: sub.period_end, cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        scheduledPlan: sub.scheduled_plan, pendingUpgrade: Boolean(sub.pending_upgrade),
        paymentActionRequired: Boolean(sub.payment_url) || ['past_due','unpaid','incomplete'].includes(sub.status) } : null };
  }
  function validateSubscription(sub, account) {
    assertLive(sub);
    const items = sub.items?.data;
    const plan = items?.length === 1 && planForPrice(items[0].price);
    if (!plan || items[0].quantity !== 1 || objectId(sub.customer) !== account.customer_id ||
      sub.metadata?.clickit_installation !== account.installation_id || sub.currency !== 'usd' ||
      !Number.isSafeInteger(sub.current_period_start) || !Number.isSafeInteger(sub.current_period_end) ||
      sub.current_period_end <= sub.current_period_start) fail(400, 'Unexpected subscription or owner.');
    return plan;
  }
  async function syncSubscription(sub, account) {
    const plan = validateSubscription(sub, account);
    let scheduledPlan = null;
    if (sub.schedule) {
      const schedule = await stripe(`subscription_schedules/${objectId(sub.schedule)}`);
      if (objectId(schedule.subscription) !== sub.id) fail(400, 'Unexpected subscription schedule.');
      const phase = schedule.phases?.find(p => p.start_date >= sub.current_period_end);
      if (phase) scheduledPlan = planForPrice(phase.items?.[0]?.price)?.id || null;
    }
    const latest = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : sub.latest_invoice ? await stripe(`invoices/${sub.latest_invoice}`) : null;
    const paymentUrl = latest && !latest.paid && latest.status === 'open' ? latest.hosted_invoice_url || null : null;
    await stmt(db, `INSERT INTO subscriptions(id,installation_id,status,plan_id,period_start,period_end,cancel_at_period_end,
      scheduled_plan,pending_upgrade,payment_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,plan_id=excluded.plan_id,period_start=excluded.period_start,
      period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,scheduled_plan=excluded.scheduled_plan,
      pending_upgrade=excluded.pending_upgrade,payment_url=excluded.payment_url,updated_at=excluded.updated_at`,
    sub.id, account.installation_id, sub.status, plan.id, sub.current_period_start * 1000, sub.current_period_end * 1000,
    sub.cancel_at_period_end || sub.cancel_at === sub.current_period_end ? 1 : 0, scheduledPlan,
    sub.pending_update ? 1 : 0, paymentUrl, now).run();
    return sub;
  }
  async function retrieveSubscription(id, account) {
    if (!/^sub_[A-Za-z0-9_]+$/.test(id || '')) fail(400, 'Invalid subscription.');
    return syncSubscription(await stripe(`subscriptions/${id}`), account);
  }
  async function refundInvoice(intent, amount) {
    await db.batch([
      stmt(db, 'UPDATE subscription_invoices SET refunded_amount=MAX(refunded_amount,MIN(total_amount,?)) WHERE payment_intent=?', amount, intent),
      stmt(db, `UPDATE credit_lots SET revoked=MAX(revoked,(SELECT CASE WHEN total_amount=0 THEN 0
        ELSE MIN(credits,(refunded_amount*credits+total_amount-1)/total_amount) END
        FROM subscription_invoices WHERE id=subscription_invoice_id)) WHERE subscription_invoice_id IN
        (SELECT id FROM subscription_invoices WHERE payment_intent=?)`, intent)
    ]);
  }
  async function settleInvoice(invoice, sub, account) {
    assertLive(invoice);
    if (objectId(invoice.customer) !== account.customer_id || objectId(invoice.subscription) !== sub.id || invoice.currency !== 'usd') fail(400, 'Unexpected invoice owner.');
    if (!invoice.paid || invoice.status !== 'paid') return;
    if (!['subscription_create','subscription_cycle','subscription_update'].includes(invoice.billing_reason)) return;
    if (invoice.lines?.has_more || !invoice.lines?.data?.length) fail(400, 'Unexpected invoice lines.');
    const lines = invoice.lines.data;
    for (const line of lines) {
      const subscriptionLine = line.type === 'subscription' || (invoice.billing_reason === 'subscription_update' && line.proration && line.type === 'invoiceitem');
      if (!planForPrice(line.price) || line.quantity !== 1 || !subscriptionLine || objectId(line.subscription) !== sub.id ||
        line.currency !== 'usd' || !Number.isSafeInteger(line.amount) || !Number.isSafeInteger(line.period?.start) ||
        !Number.isSafeInteger(line.period?.end) || line.period.end <= line.period.start) fail(400, 'Unexpected invoiced product.');
    }
    const monthly = invoice.billing_reason !== 'subscription_update';
    let start, end, allowance, kind;
    if (monthly) {
      if (lines.length !== 1 || lines[0].proration || lines[0].amount !== planForPrice(lines[0].price).amount || invoice.subtotal !== lines[0].amount) fail(400, 'Unexpected monthly invoice.');
      start = lines[0].period.start * 1000; end = lines[0].period.end * 1000;
      allowance = planForPrice(lines[0].price).credits; kind = 'monthly';
    } else {
      if (lines.length !== 2 || !lines.every(l => l.proration) ||
        !lines.some(l => planForPrice(l.price).id === 'basic' && l.amount <= 0) ||
        !lines.some(l => planForPrice(l.price).id === 'plus' && l.amount >= 0) ||
        lines[0].period.start !== lines[1].period.start || lines[0].period.end !== lines[1].period.end ||
        invoice.subtotal !== lines.reduce((sum,l) => sum+l.amount,0)) fail(400, 'Unexpected upgrade invoice.');
      end = lines[0].period.end * 1000;
      const period = await stmt(db, 'SELECT * FROM subscription_periods WHERE subscription_id=? AND period_end=?', sub.id, end).first();
      if (!period) fail(409, 'The initial monthly payment is still syncing.');
      start = period.period_start; allowance = 1200; kind = 'upgrade';
    }
    if (!Number.isSafeInteger(invoice.total) || invoice.total < 0 || invoice.total < invoice.subtotal || invoice.discounts?.length ||
      !/^in_[A-Za-z0-9_]+$/.test(invoice.id || '')) fail(400, 'Unexpected invoice amount.');
    // Read refunds before publishing a new grant, so a refund that predates
    // delivery never creates a briefly spendable balance.
    const intentId = objectId(invoice.payment_intent) || null;
    const intent = intentId ? await stripe(`payment_intents/${intentId}?expand[]=latest_charge.balance_transaction`) : null;
    const charge = intent?.latest_charge;
    const fee = charge?.balance_transaction;
    const refunded = Number.isSafeInteger(charge?.amount_refunded) ? Math.max(0,Math.min(invoice.total,charge.amount_refunded)) : 0;
    const existing = await stmt(db, 'SELECT id FROM subscription_invoices WHERE id=?', invoice.id).first();
    if (!existing) {
      const period = await stmt(db, 'SELECT allowance FROM subscription_periods WHERE subscription_id=? AND period_start=?', sub.id, start).first();
      const credits = Math.max(0, allowance - (period?.allowance || 0));
      await db.batch([
        stmt(db, `INSERT INTO subscription_invoices(id,installation_id,subscription_id,payment_intent,kind,period_start,period_end,
          amount,total_amount,tax_amount,currency,credits,created_at,refunded_amount,stripe_fee,stripe_fee_currency) VALUES(?,?,?,?,?,?,?,?,?,?,'usd',?,?,?,?,?)`,
        invoice.id, account.installation_id, sub.id, intentId, kind, start, end,
        invoice.subtotal, invoice.total, (invoice.total_tax_amounts || []).reduce((sum,t) => sum+t.amount,0), credits, invoice.created * 1000,
        refunded, Number.isSafeInteger(fee?.fee) ? fee.fee : null, typeof fee?.currency === 'string' ? fee.currency : null),
        stmt(db, `INSERT INTO subscription_periods(subscription_id,period_start,period_end,allowance) VALUES(?,?,?,?)
          ON CONFLICT(subscription_id,period_start) DO UPDATE SET allowance=MAX(allowance,excluded.allowance)`, sub.id, start, end, allowance),
        stmt(db, `INSERT INTO credit_lots(id,installation_id,granted,created_at,expires_at,subscription_invoice_id,revoked)
          SELECT ?,?,?,?,?,?,? WHERE ?>0`, `invoice:${invoice.id}`, account.installation_id, credits, now, end, invoice.id,
        invoice.total > 0 ? Math.min(credits,Math.ceil(credits*refunded/invoice.total)) : 0, credits)
      ]);
    }
    if (intentId) {
      if (Number.isSafeInteger(fee?.fee) && typeof fee.currency === 'string') await stmt(db,
        'UPDATE subscription_invoices SET stripe_fee=?,stripe_fee_currency=? WHERE id=?', fee.fee, fee.currency, invoice.id).run();
      if (Number.isSafeInteger(charge?.amount_refunded)) await refundInvoice(intentId, charge.amount_refunded);
    }
  }
  async function reconcileInvoices(sub, account) {
    // Process regular invoices before prorations, including when the upgrade webhook
    // arrives first. Pagination prevents missed renewals after a long outage.
    const invoices = [];
    let after = '';
    do {
      const page = await stripe(`invoices?subscription=${sub.id}&status=paid&limit=100${after ? `&starting_after=${after}` : ''}`);
      if (!Array.isArray(page.data)) fail(502, 'Unable to reconcile subscription invoices.');
      invoices.push(...page.data);
      after = page.has_more && page.data.length ? page.data.at(-1).id : '';
    } while (after);
    invoices.sort((a,b) => (a.billing_reason === 'subscription_update') - (b.billing_reason === 'subscription_update') || a.created-b.created);
    for (const invoice of invoices) {
      const stored = await stmt(db, 'SELECT stripe_fee FROM subscription_invoices WHERE id=?', invoice.id).first();
      if (!stored || stored.stripe_fee === null) await settleInvoice(invoice, sub, account);
    }
  }
  async function reconcileAccount(account) {
    if (!account.customer_id) return;
    // Retrieve all statuses so a missed canceled event cannot leave a permanent
    // local active row or allow a second subscription at checkout.
    let after = '';
    const subs = [];
    do {
      const page = await stripe(`subscriptions?customer=${account.customer_id}&status=all&limit=100${after ? `&starting_after=${after}` : ''}`);
      if (!Array.isArray(page.data)) fail(502, 'Unable to reconcile subscription.');
      subs.push(...page.data);
      after = page.has_more && page.data.length ? page.data.at(-1).id : '';
    } while (after);
    subs.sort((a,b) => Number(!terminal(a.status))-Number(!terminal(b.status)));
    for (const sub of subs) {
      await syncSubscription(sub, account);
      await reconcileInvoices(sub, account);
    }
    // A client can disappear after Stripe accepts a change. Recover confirmed
    // outcomes without requiring that browser to retain its operation ID.
    const pending = await stmt(db, `SELECT * FROM billing_operations WHERE installation_id=? AND kind='upgrade'
      AND result IS NULL AND json_extract(payload,'$.request') IS NOT NULL`, account.installation_id).all();
    for (const operation of pending.results) {
      const data = JSON.parse(operation.payload);
      const quote = await stmt(db, 'SELECT * FROM billing_operations WHERE id=?', data.quoteId).first();
      const local = await stmt(db, 'SELECT * FROM subscriptions WHERE id=?', operation.subscription_id).first();
      if (!quote || !local) continue;
      const target = JSON.parse(quote.payload);
      const period = await stmt(db, 'SELECT allowance FROM subscription_periods WHERE subscription_id=? AND period_end=?', local.id, target.periodEnd*1000).first();
      const accepted = Boolean(local.pending_upgrade) || period?.allowance === 1200;
      const expired = quote.expires_at+120000 <= now && !local.pending_upgrade;
      if (accepted || expired) await db.batch([
        stmt(db, 'UPDATE billing_operations SET result=? WHERE id=?', JSON.stringify({ changed: accepted }), operation.id),
        stmt(db, 'UPDATE billing_operations SET result=? WHERE id=?', JSON.stringify({ used: true }), quote.id)
      ]);
    }
    await stmt(db, 'UPDATE billing_accounts SET reconciled_at=?,reconcile_error=0 WHERE installation_id=?', now, account.installation_id).run();
  }
  async function ensureCustomer(account) {
    if (account.customer_id) return;
    const customer = await stripe('customers', { 'metadata[clickit_installation]': account.installation_id }, `customer:${account.installation_id}`);
    if (!/^cus_[A-Za-z0-9_]+$/.test(customer.id || '')) fail(502, 'Unexpected billing customer.');
    await stmt(db, 'UPDATE billing_accounts SET customer_id=? WHERE installation_id=?', customer.id, account.installation_id).run();
    account.customer_id = customer.id;
  }
  async function checkout(owner, data) {
    checkoutEnabled();
    const plan = validatePlan(data.planId);
    if (!/^[a-f0-9-]{36}$/.test(data.checkoutId || '')) fail(400, 'A checkout ID is required.');
    return locked(owner, async account => {
      await catalog();
      await ensureCustomer(account);
      await reconcileAccount(account);
      const sub = await current(owner);
      if (sub && !terminal(sub.status)) fail(409, 'Manage your existing subscription instead.');
      if (account.checkout_session) {
        const previous = await stripe(`checkout/sessions/${account.checkout_session}`);
        if (previous.status === 'complete') {
          const completed = await stmt(db, 'SELECT status FROM subscriptions WHERE id=? AND installation_id=?', objectId(previous.subscription) || '', owner).first();
          if (!completed || !terminal(completed.status)) fail(409, 'Your subscription payment is syncing. Refresh shortly.');
        }
        if (previous.status === 'open') {
          if (account.checkout_plan === plan.id) return { url: previous.url };
          await stripe(`checkout/sessions/${previous.id}/expire`, {}, `expire:${previous.id}`);
        }
      }
      // Persist the attempt before the remote call so a lost response retries with
      // the same Stripe idempotency key rather than making another session.
      const attempt = !account.checkout_session && account.checkout_id ? account.checkout_id : data.checkoutId;
      const attemptPlan = !account.checkout_session && account.checkout_id ? account.checkout_plan : plan.id;
      if (attemptPlan !== plan.id) fail(409, 'Retry the previous checkout plan before choosing another.');
      const owned = await stmt(db, 'SELECT installation_id FROM checkouts WHERE id=?', attempt).first();
      if (owned && owned.installation_id !== owner) fail(403, 'Invalid checkout owner.');
      if (owned && account.checkout_session) fail(409, 'This checkout attempt has ended. Start a new checkout.');
      if (!owned) {
        const inserted = await stmt(db, `INSERT INTO checkouts(id,installation_id,created_at)
          SELECT ?,?,? WHERE (SELECT COUNT(*) FROM checkouts WHERE installation_id=? AND created_at>?)<5`, attempt, owner, now, owner, now-3600000).run();
        if (!inserted.meta.changes) fail(429, 'Too many checkout attempts. Try later.');
      }
      await stmt(db, 'UPDATE billing_accounts SET checkout_id=?,checkout_plan=?,checkout_session=NULL WHERE installation_id=?', attempt, plan.id, owner).run();
      const session = await stripe('checkout/sessions', {
        mode: 'subscription', customer: account.customer_id, client_reference_id: owner,
        'metadata[clickit_checkout]': attempt, 'subscription_data[metadata][clickit_installation]': owner,
        'line_items[0][price]': prices[plan.id], 'line_items[0][quantity]': '1',
        success_url: `${publicUrl()}/purchase.html`, cancel_url: `${publicUrl()}/purchase.html?cancelled=1`,
        'automatic_tax[enabled]': 'false'
      }, `subscription-checkout:${attempt}`);
      if (!/^cs_[A-Za-z0-9_]+$/.test(session.id || '') || new URL(session.url).origin !== 'https://checkout.stripe.com') fail(502, 'Unexpected checkout URL.');
      await stmt(db, 'UPDATE billing_accounts SET checkout_session=? WHERE installation_id=?', session.id, owner).run();
      return { url: session.url };
    });
  }
  async function active(account) {
    await reconcileAccount(account);
    const row = await current(account.installation_id);
    if (!row || terminal(row.status)) fail(409, 'No active subscription.');
    return retrieveSubscription(row.id, account);
  }
  async function preview(owner, data) {
    checkoutEnabled();
    if (data.planId !== 'plus') fail(400, 'Only upgrades require a payment preview.');
    return locked(owner, async account => {
      const sub = await active(account);
      if (sub.status !== 'active' || validateSubscription(sub, account).id !== 'basic' || sub.pending_update || sub.cancel_at_period_end) fail(409, 'Restore an active Basic subscription before upgrading.');
      const period = await stmt(db, 'SELECT allowance FROM subscription_periods WHERE subscription_id=? AND period_start=?', sub.id, sub.current_period_start*1000).first();
      if (!period) fail(409, 'Your paid allowance is still syncing.');
      const date = Math.floor(now/1000);
      const invoice = await stripe(`invoices/upcoming?customer=${account.customer_id}&subscription=${sub.id}&subscription_items[0][id]=${sub.items.data[0].id}&subscription_items[0][price]=${prices.plus}&subscription_proration_date=${date}&subscription_proration_behavior=always_invoice`);
      const amount = invoice.amount_due;
      if (!Number.isSafeInteger(amount) || amount < 0 || invoice.currency !== 'usd') fail(502, 'Unexpected upgrade quote.');
      const quoteId = crypto.randomUUID();
      const payload = { planId: 'plus', prorationDate: date, periodEnd: sub.current_period_end, itemId: sub.items.data[0].id,
        amount, currency: 'usd', additionalCredits: Math.max(0,1200-period.allowance) };
      await stmt(db, 'INSERT INTO billing_operations(id,installation_id,subscription_id,kind,payload,expires_at) VALUES(?,?,?,?,?,?)',
        quoteId, owner, sub.id, 'upgrade_quote', JSON.stringify(payload), Math.min(now+300000,sub.current_period_end*1000)).run();
      return { quoteId, ...payload, expiresAt: Math.min(now+300000,sub.current_period_end*1000) };
    });
  }
  async function releaseSchedule(sub) {
    if (sub.schedule) await stripe(`subscription_schedules/${objectId(sub.schedule)}/release`, {}, `release:${objectId(sub.schedule)}`);
  }
  async function change(owner, data) {
    if (!/^[a-f0-9-]{36}$/.test(data.changeId || '')) fail(400, 'A change ID is required.');
    if (!['upgrade','downgrade','keep_plan','cancel','resume'].includes(data.action)) fail(400, 'Invalid subscription action.');
    if (['upgrade','downgrade'].includes(data.action)) checkoutEnabled();
    return locked(owner, async account => {
      const previous = await stmt(db, 'SELECT * FROM billing_operations WHERE id=?', data.changeId).first();
      if (previous && (previous.installation_id !== owner || previous.kind !== data.action)) fail(403, 'Invalid billing operation.');
      if (previous?.result) return { ...await snapshot(owner), changed: true };
      if (previous && previous.expires_at <= now) fail(409, 'Billing operation expired. Refresh your subscription before trying again.');
      const operation = previous ? JSON.parse(previous.payload) : data;
      if (operation.quoteId !== data.quoteId) fail(403, 'Billing operation does not match this quote.');
      const sub = await active(account);
      const recovered = previous && await stmt(db, 'SELECT result FROM billing_operations WHERE id=?', data.changeId).first();
      if (recovered?.result) return { ...await snapshot(owner), ...JSON.parse(recovered.result) };
      const pending = await stmt(db, `SELECT id FROM billing_operations WHERE installation_id=? AND result IS NULL
        AND expires_at>? AND json_extract(payload,'$.request') IS NOT NULL AND id!=? LIMIT 1`, owner, now, data.changeId).first();
      if (pending) fail(409, 'Retry the previous billing change before starting another.');
      if (previous && previous.subscription_id !== sub.id) fail(409, 'This change belongs to an ended subscription.');
      const plan = validateSubscription(sub, account);
      if (!previous) await stmt(db, 'INSERT INTO billing_operations(id,installation_id,subscription_id,kind,payload,expires_at) VALUES(?,?,?,?,?,?)',
        data.changeId, owner, sub.id, data.action, JSON.stringify(data), now+86400000).run();
      if (data.action === 'upgrade') {
        if (!operation.request) {
          const stored = await stmt(db, "SELECT * FROM billing_operations WHERE id=? AND installation_id=? AND kind='upgrade_quote'", data.quoteId || '', owner).first();
          if (!stored || stored.subscription_id !== sub.id || stored.expires_at <= now || stored.result) fail(409, 'Upgrade quote expired or already used. Request a new quote.');
          const quote = JSON.parse(stored.payload);
          if (plan.id !== 'basic' || sub.status !== 'active' || sub.cancel_at_period_end || sub.pending_update || sub.current_period_end !== quote.periodEnd) fail(409, 'Subscription changed. Request a new quote.');
          await releaseSchedule(sub);
          operation.request = { path: `subscriptions/${sub.id}`, form: {
            'items[0][id]': quote.itemId, 'items[0][price]': prices.plus, proration_behavior: 'always_invoice',
            proration_date: String(quote.prorationDate), payment_behavior: 'pending_if_incomplete'
          } };
          await stmt(db, 'UPDATE billing_operations SET payload=? WHERE id=?', JSON.stringify(operation), data.changeId).run();
        }
        // Replaying the exact persisted request recovers a charge whose response
        // was lost, even if Stripe has already applied the plan change.
        await stripe(operation.request.path, operation.request.form, `change:${data.changeId}`);
        await stmt(db, 'UPDATE billing_operations SET result=? WHERE id=?', JSON.stringify({ used: true }), data.quoteId).run();
      } else if (data.action === 'downgrade') {
        if (plan.id !== 'plus' || sub.status !== 'active' || sub.cancel_at_period_end || sub.pending_update) fail(409, 'An active Plus subscription is required.');
        const schedule = sub.schedule ? await stripe(`subscription_schedules/${objectId(sub.schedule)}`) :
          await stripe('subscription_schedules', { from_subscription: sub.id }, `schedule:${data.changeId}`);
        await stripe(`subscription_schedules/${schedule.id}`, { end_behavior: 'release', proration_behavior: 'none',
          'phases[0][start_date]': String(schedule.current_phase.start_date), 'phases[0][end_date]': String(sub.current_period_end),
          'phases[0][items][0][price]': prices.plus, 'phases[0][items][0][quantity]': '1',
          'phases[1][items][0][price]': prices.basic, 'phases[1][items][0][quantity]': '1',
          'phases[1][iterations]': '1', 'phases[1][proration_behavior]': 'none'
        }, `schedule-update:${data.changeId}`);
      } else {
        await releaseSchedule(sub);
        if (data.action !== 'keep_plan') await stripe(`subscriptions/${sub.id}`,
          { cancel_at_period_end: data.action === 'cancel' ? 'true' : 'false' }, `change:${data.changeId}`);
      }
      // A failed/SCA-required upgrade remains pending; only a paid invoice can
      // increase the allowance. Retrieve state rather than trusting event order.
      const authoritative = await retrieveSubscription(sub.id, account);
      await reconcileInvoices(authoritative, account);
      const result = { ...(await snapshot(owner)), changed: true };
      await stmt(db, 'UPDATE billing_operations SET result=? WHERE id=?', JSON.stringify(result), data.changeId).run();
      return result;
    });
  }
  async function portal(owner) {
    return locked(owner, async account => {
      if (!account.customer_id || !env.STRIPE_PORTAL_CONFIGURATION_ID) fail(503, 'Billing management is not configured. Contact support.');
      const configuration = await stripe(`billing_portal/configurations/${env.STRIPE_PORTAL_CONFIGURATION_ID}`);
      if (!configuration.active || configuration.features?.subscription_update?.enabled ||
        !configuration.features?.subscription_cancel?.enabled || configuration.features.subscription_cancel.mode !== 'at_period_end' ||
        !configuration.features?.payment_method_update?.enabled || !configuration.features?.invoice_history?.enabled) fail(503, 'Billing management settings need attention. Contact support.');
      const session = await stripe('billing_portal/sessions', { customer: account.customer_id,
        configuration: env.STRIPE_PORTAL_CONFIGURATION_ID, return_url: `${publicUrl()}/purchase.html` });
      if (new URL(session.url).origin !== 'https://billing.stripe.com') fail(502, 'Unexpected billing URL.');
      return { url: session.url };
    });
  }
  async function checkoutCompleted(session) {
    assertLive(session);
    const account = await stmt(db, 'SELECT * FROM billing_accounts WHERE customer_id=?', objectId(session.customer) || '').first();
    if (!account || session.client_reference_id !== account.installation_id || session.id !== account.checkout_session ||
      session.metadata?.clickit_checkout !== account.checkout_id) fail(400, 'Checkout owner does not match.');
    await locked(account.installation_id, async fresh => {
      const sub = await retrieveSubscription(objectId(session.subscription), fresh);
      await reconcileInvoices(sub, fresh);
    });
  }
  async function handleEvent(notification) {
    if (notification.type === 'charge.refunded') {
      const charge = notification.data?.object;
      if (charge?.invoice) {
        const invoice = await stripe(`invoices/${objectId(charge.invoice)}`);
        if (invoice.subscription) {
          const account = await stmt(db, 'SELECT * FROM billing_accounts WHERE customer_id=?', objectId(invoice.customer) || '').first();
          if (!account) fail(400, 'Unknown invoice owner.');
          await locked(account.installation_id, async fresh => {
            const sub = await retrieveSubscription(objectId(invoice.subscription), fresh);
            await reconcileInvoices(sub, fresh);
            await settleInvoice(invoice, sub, fresh);
          });
          return true;
        }
      }
      return false;
    }
    if (!notification.type.startsWith('invoice.') && !notification.type.startsWith('customer.subscription.')) return false;
    const object = notification.data?.object;
    const isInvoice = notification.type.startsWith('invoice.');
    const remote = isInvoice ? await stripe(`invoices/${object?.id}`) : await stripe(`subscriptions/${object?.id}`);
    const account = await stmt(db, 'SELECT * FROM billing_accounts WHERE customer_id=?', objectId(remote.customer) || '').first();
    if (!account) fail(400, 'Unknown subscription owner.');
    await locked(account.installation_id, async fresh => {
      const sub = await retrieveSubscription(isInvoice ? objectId(remote.subscription) : remote.id, fresh);
      await reconcileInvoices(sub, fresh);
      if (isInvoice) await settleInvoice(remote, sub, fresh);
    });
    return true;
  }
  async function scheduled() {
    const accounts = await stmt(db, 'SELECT installation_id FROM billing_accounts WHERE customer_id IS NOT NULL AND lease_until<=? ORDER BY reconciled_at LIMIT 10', now).all();
    for (const account of accounts.results) {
      try { await locked(account.installation_id, reconcileAccount); }
      catch {
        // Record a content-free failure indicator for operations and the popup.
        await stmt(db, 'UPDATE billing_accounts SET reconciled_at=?,reconcile_error=1 WHERE installation_id=?', now, account.installation_id).run();
      }
    }
  }
  return { snapshot, checkout, preview, change, portal, checkoutCompleted, handleEvent, scheduled };
}
