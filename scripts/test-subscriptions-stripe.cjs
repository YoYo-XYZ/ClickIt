// Opt-in external validation. Uses only a privately supplied Stripe TEST key.
// Creates test prices, a portal configuration, and clock-backed test customers.
// Never enables public checkout or contacts the deployed ClickIt database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('../tests/helpers/server.cjs');

test('Stripe test-clock subscription lifecycle against the actual pinned API', { timeout: 240000 }, async t => {
  const secretPath = process.env.CLICKIT_STRIPE_SECRET_FILE;
  const key = secretPath ? fs.readFileSync(secretPath, 'utf8').trim() : process.env.STRIPE_TEST_SECRET_KEY;
  assert.match(key || '', /^(sk|rk)_test_/, 'Supply a Stripe test key through the private secret file. Live keys are refused.');
  const run = crypto.randomUUID();
  const checks = [];
  const blockers = [];
  const output=path.resolve(__dirname,'../.clickit-private/stripe-subscriptions-test.json');
  async function api(endpoint, form, method) {
    const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
      method: method || (form ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20',
        ...(form ? { 'Content-Type':'application/x-www-form-urlencoded' } : {}) },
      ...(form ? {body:new URLSearchParams(form).toString()} : {}), signal:AbortSignal.timeout(20000)
    });
    const body=await response.json();
    if (!response.ok) throw new Error(`Stripe ${endpoint.split('?')[0]}: ${body.error?.code || body.error?.type || response.status}: ${body.error?.message || 'Request failed'}`.replaceAll(key,'[redacted]'));
    return body;
  }
  const saved=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):null;
  const product=saved?null:await api('products',{name:`Clickit subscription validation ${run}`});
  const basic=saved?await api(`prices/${saved.basicPriceId}`):await api('prices',{product:product.id,currency:'usd',unit_amount:'499','recurring[interval]':'month',tax_behavior:'exclusive'});
  const plus=saved?await api(`prices/${saved.plusPriceId}`):await api('prices',{product:product.id,currency:'usd',unit_amount:'999','recurring[interval]':'month',tax_behavior:'exclusive'});
  const portal=saved?await api(`billing_portal/configurations/${saved.portalConfigurationId}`):await api('billing_portal/configurations',{
    'business_profile[headline]':'Manage Clickit test billing',
    'features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'at_period_end',
    'features[subscription_update][enabled]':'false','features[payment_method_update][enabled]':'true','features[invoice_history][enabled]':'true',
    default_return_url:'https://clickit.example/purchase.html'
  });
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const report={run,apiVersion:'2024-06-20',basicPriceId:basic.id,plusPriceId:plus.id,portalConfigurationId:portal.id,checks,blockers,status:'running'};
  t.after(()=>{if(report.status==='running'){report.status='failed';fs.writeFileSync(output,JSON.stringify(report,null,2));}});
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  const s=await setup(t,{STRIPE_BASIC_PRICE_ID:basic.id,STRIPE_PLUS_PRICE_ID:plus.id,STRIPE_PORTAL_CONFIGURATION_ID:portal.id});
  // All Stripe requests from the actual Worker go to Stripe. Provider inference
  // remains isolated; this script validates billing, not quiz/model quality.
  s.state.stripe=async(url,options)=>{
    const response=await fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${key}`}});
    if(!response.ok){const body=await response.json();s.state.lastStripeError=`Stripe integration: ${body.error?.code || body.error?.type}: ${body.error?.message}`.replaceAll(key,'[redacted]');throw new Error(s.state.lastStripeError);}
    if(new URL(url).pathname.startsWith('/v1/invoices')){
      const body=await response.clone().json();
      report.invoiceDiagnostics=(body.data || [body]).filter(i=>i.lines).map(i=>({id:i.id,status:i.status,billingReason:i.billing_reason,
        lines:i.lines.data.map(l=>({type:l.type,subscription:l.subscription,quantity:l.quantity,price:l.price?.id,amount:l.amount,currency:l.currency,period:l.period,proration:l.proration}))}));
    }
    return response;
  };
  const balance=async user=>(await s.req('balance',undefined,user.credential)).json();
  const change=async(user,action,extra={})=>{
    const response=await s.req('subscription/change',{changeId:crypto.randomUUID(),action,...extra},user.credential);
    assert.equal(response.status,200,`${await response.clone().text()} ${JSON.stringify(report.invoiceDiagnostics || [])}`);return response.json();
  };
  async function event(type,id){
    const response=await s.notify(type,{id});assert.equal(response.status,200,await response.clone().text());
  }
  async function advance(clock,time){
    await api(`test_helpers/test_clocks/${clock.id}/advance`,{frozen_time:String(time)});
    const deadline=Date.now()+60000;
    while((await api(`test_helpers/test_clocks/${clock.id}`)).status!=='ready'){
      if(Date.now()>deadline)throw new Error('Stripe test clock did not become ready.');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    s.advance(time*1000-s.time());
  }
  const frozen=Math.floor(s.time()/1000);
  const clock=await api('test_helpers/test_clocks',{frozen_time:String(frozen),name:`Clickit ${run}`});
  t.after(async()=>{await api(`test_helpers/test_clocks/${clock.id}`,undefined,'DELETE');});
  const user=await s.register();
  const customer=await api('customers',{test_clock:clock.id,'metadata[clickit_installation]':user.installationId});
  s.db.sql.prepare('INSERT INTO billing_accounts(installation_id,customer_id) VALUES(?,?)').run(user.installationId,customer.id);
  const checkout=await s.req('checkout',{checkoutId:crypto.randomUUID(),planId:'basic'},user.credential);
  if(checkout.status===200){
    const session=s.db.sql.prepare('SELECT checkout_session FROM billing_accounts').get().checkout_session;
    await api(`checkout/sessions/${session}/expire`,{});
    checks.push('Actual subscription Checkout session creation; abandoned checkout grants nothing');
  }else{
    const reason=s.state.lastStripeError || await checkout.clone().text();
    assert.match(reason,/terms of service.*URL|URL.*terms of service/is,'Only the known Terms URL blocker can be skipped');
    blockers.push(`Checkout: ${reason}`);t.diagnostic(`Checkout blocked: ${reason}`);
  }
  assert.equal((await balance(user)).monthlyCredits,0);
  const paymentMethod=await api('payment_methods',{type:'card','card[token]':'tok_visa'});
  await api(`payment_methods/${paymentMethod.id}/attach`,{customer:customer.id});
  await api(`customers/${customer.id}`,{'invoice_settings[default_payment_method]':paymentMethod.id});
  let sub=await api('subscriptions',{customer:customer.id,'items[0][price]':basic.id,'metadata[clickit_installation]':user.installationId,
    default_payment_method:paymentMethod.id,'payment_settings[payment_method_types][0]':'card'});
  await event('invoice.paid',sub.latest_invoice);
  assert.equal((await balance(user)).monthlyCredits,500);
  await event('invoice.paid',sub.latest_invoice);assert.equal((await balance(user)).monthlyCredits,500);
  checks.push('Actual paid Basic invoice and replay grant once');
  s.db.sql.prepare('UPDATE credit_lots SET consumed=300 WHERE subscription_invoice_id=?').run(sub.latest_invoice);
  await advance(clock,frozen+14*86400);
  const declined=await api('payment_methods/pm_card_chargeCustomerFail/attach',{customer:customer.id});
  await api(`subscriptions/${sub.id}`,{default_payment_method:declined.id});
  let failedQuote=await s.req('subscription/preview',{planId:'plus'},user.credential);
  assert.equal(failedQuote.status,200,await failedQuote.clone().text());
  await change(user,'upgrade',{quoteId:(await failedQuote.json()).quoteId});
  sub=await api(`subscriptions/${sub.id}`);
  assert.ok(sub.pending_update);assert.equal((await balance(user)).monthlyCredits,200);
  await api(`invoices/${sub.latest_invoice}/void`,{});
  await event('customer.subscription.updated',sub.id);
  checks.push('Actual declined upgrade remains pending without adding credits');
  const authentication=await api('payment_methods/pm_card_authenticationRequired/attach',{customer:customer.id});
  await api(`subscriptions/${sub.id}`,{default_payment_method:authentication.id});
  const preview=await s.req('subscription/preview',{planId:'plus'},user.credential);
  assert.equal(preview.status,200,await preview.clone().text());const quote=await preview.json();
  await change(user,'upgrade',{quoteId:quote.quoteId});
  sub=await api(`subscriptions/${sub.id}`);
  assert.ok(sub.pending_update);assert.equal((await balance(user)).monthlyCredits,200);
  const authenticationInvoice=await api(`invoices/${sub.latest_invoice}`);
  assert.equal((await api(`payment_intents/${authenticationInvoice.payment_intent}`)).status,'requires_action');
  await api(`subscriptions/${sub.id}`,{default_payment_method:paymentMethod.id});
  await api(`invoices/${sub.latest_invoice}/pay`,{payment_method:paymentMethod.id});
  await event('invoice.paid',sub.latest_invoice);
  assert.equal((await balance(user)).monthlyCredits,900);
  sub=await api(`subscriptions/${sub.id}`);
  assert.equal((await api(`invoices/${sub.latest_invoice}`)).amount_due,quote.amount,'Confirmed upgrade charge must match its preview');
  assert.equal((await balance(user)).subscription.periodEnd,sub.current_period_end*1000);
  checks.push('Actual prorated upgrade leaves 900 credits after 300 used and preserves renewal date');
  checks.push('Actual 3DS-required upgrade grants nothing until payment recovery');
  await change(user,'downgrade');assert.equal((await balance(user)).subscription.scheduledPlan,'basic');
  await advance(clock,sub.current_period_end+3600);
  await s.worker.scheduled({},s.env);
  assert.equal((await balance(user)).monthlyCredits,500);
  assert.equal((await balance(user)).subscription.planId,'basic');
  checks.push('Actual clock renewal applies scheduled downgrade and expires the previous allowance');
  sub=await api(`subscriptions/${sub.id}`);
  await api(`subscriptions/${sub.id}`,{default_payment_method:declined.id});
  await advance(clock,sub.current_period_end+3600);await s.worker.scheduled({},s.env);
  sub=await api(`subscriptions/${sub.id}`);
  assert.equal(sub.status,'past_due');assert.equal((await balance(user)).monthlyCredits,0);
  await api(`subscriptions/${sub.id}`,{default_payment_method:paymentMethod.id});
  await api(`invoices/${sub.latest_invoice}/pay`,{payment_method:paymentMethod.id});
  await event('invoice.paid',sub.latest_invoice);assert.equal((await balance(user)).monthlyCredits,500);
  checks.push('Actual declined renewal grants nothing and successful retry replenishes once');
  const refundedInvoice=await api(`invoices/${sub.latest_invoice}`);
  await api('refunds',{payment_intent:refundedInvoice.payment_intent,amount:'100'});
  const refunded=await s.notify('charge.refunded',{invoice:refundedInvoice.id,payment_intent:refundedInvoice.payment_intent,amount_refunded:100});
  assert.equal(refunded.status,200,await refunded.clone().text());
  assert.equal((await balance(user)).monthlyCredits,399);
  checks.push('Actual partial refund revokes only its invoice credits');
  await change(user,'cancel');assert.equal((await balance(user)).subscription.cancelAtPeriodEnd,true);
  await change(user,'resume');assert.equal((await balance(user)).subscription.cancelAtPeriodEnd,false);
  const managed=await s.req('billing-portal',{},user.credential);assert.equal(managed.status,200,await managed.clone().text());
  await change(user,'cancel');sub=await api(`subscriptions/${sub.id}`);
  await advance(clock,sub.current_period_end+3600);await s.worker.scheduled({},s.env);
  assert.equal((await balance(user)).monthlyCredits,0);
  checks.push('Actual portal, cancellation reversal, and end-of-period cancellation');
  report.status=blockers.length?'partial':'passed';
  fs.writeFileSync(output,JSON.stringify({...report,note:'Test-clock customer is deleted after the run. Test prices and portal remain available. Webhook HTTP delivery and interactive Checkout/3DS still require deployment validation.'},null,2));
  console.log(`Stripe test-clock report: ${output}`);
  if(process.env.CLICKIT_ALLOW_CHECKOUT_BLOCKED==='1'){
    await t.test('Interactive Checkout validation',st=>{if(blockers.length)st.skip('Terms URL is missing; user chose to leave Checkout validation blocked.');});
  }else assert.deepEqual(blockers,[],'External Stripe setup blockers remain; see the validation report.');
});
