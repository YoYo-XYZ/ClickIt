const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
let context, worker, extensionId, session;
const fixture = '<main><h1>What is 2 + 2?</h1><div><button class="option">3</button><button class="option">4</button></div><button id="submit">Submit</button></main><script>window.clicks=0;window.submits=0;document.addEventListener("click",e=>{if(e.target.matches(".option"))clicks++;if(e.target.id==="submit")submits++})</script>';
const token = `ci_${'a'.repeat(64)}`;
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
before(async () => {
  const extension = path.resolve(__dirname, '../extension');
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
  assert.equal(extensionId, 'dfpglkafpdbnfecohhgmhkpceinhhpjl');
  session = await context.browser().newBrowserCDPSession();
  await worker.evaluate(() => {
    globalThis.hostedCalls = [];
    globalThis.serverCredits = 15;
    globalThis.hostedMock = { delay: 0, failCompletion: false, checkoutEnabled: false };
    globalThis.openedCheckouts = [];
    globalThis.hostedChangeResults = {};
    const create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = async options => { if (options.url.startsWith('https://checkout.stripe.com/') || options.url.startsWith('https://billing.stripe.com/')) { openedCheckouts.push(options.url); return {}; } return create(options); };
    globalThis.fetch = async (url, init = {}) => {
      const route = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      hostedCalls.push({ route, body, authorization: init.headers?.Authorization });
      const balance = () => ({ credits: serverCredits, reserved: 0, checkoutEnabled: hostedMock.checkoutEnabled, visionEnabled: hostedMock.visionEnabled || false,
        monthlyCredits: hostedMock.monthlyCredits || 0, otherCredits: serverCredits-(hostedMock.monthlyCredits || 0),
        subscription: hostedMock.subscription || null, billingManagementAvailable: Boolean(hostedMock.subscription) });
      if (route === '/v1/installations') return Response.json({ credential: `ci_${'a'.repeat(64)}`, installationId: 'test-installation', ...balance() });
      if (route === '/v1/balance') return Response.json(balance());
      if (route === '/v1/answers/complete') {
        if (hostedMock.failCompletion) throw new TypeError('Offline');
        if (body.delivered) serverCredits--;
        return Response.json(balance());
      }
      if (route === '/v1/checkout') return Response.json({ url: 'https://checkout.stripe.com/c/pay_test' });
      if (route === '/v1/billing-portal') return Response.json({ url: 'https://billing.stripe.com/p/session_test' });
      if (route === '/v1/subscription/preview') return Response.json({ quoteId: 'test-quote', amount: 250, currency: 'usd', additionalCredits: 700,
        periodEnd: Math.floor(Date.now()/1000)+86400, expiresAt: Date.now()+300000 });
      if (route === '/v1/subscription/change') {
        if (hostedChangeResults[body.changeId]) return Response.json(hostedChangeResults[body.changeId]);
        if (body.action === 'upgrade') { hostedMock.subscription.planId='plus'; hostedMock.subscription.allowance=1200; serverCredits+=700; hostedMock.monthlyCredits+=700; }
        if (body.action === 'downgrade') hostedMock.subscription.scheduledPlan='basic';
        if (body.action === 'keep_plan') hostedMock.subscription.scheduledPlan=null;
        if (body.action === 'cancel') hostedMock.subscription.cancelAtPeriodEnd=true;
        if (body.action === 'resume') hostedMock.subscription.cancelAtPeriodEnd=false;
        const result={ ...balance(), changed: true };
        hostedChangeResults[body.changeId]=structuredClone(result);
        if(hostedMock.loseChangeResponse){hostedMock.loseChangeResponse=false;throw new TypeError('Billing response lost');}
        return Response.json(result);
      }
      if (route === '/v1/answers') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, hostedMock.delay);
          init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted','AbortError')); }, { once: true });
        });
        return Response.json({ requestId: body.requestId, result: hostedMock.result ?? { index: 1, confidence: .97 }, apiMs: 30 });
      }
      throw new Error('Unexpected network request');
    };
  });
});
after(async () => {
  await context?.close();
});
async function popup() {
  const page = await context.newPage();
  await page.setViewportSize({ width: 300, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(() => loaded);
  return page;
}
async function scenario(action) {
  const quiz = await context.newPage();
  await quiz.route('https://quiz.example/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
  await quiz.goto('https://quiz.example/quiz');
  const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const target = targetInfos.find(t => t.url === quiz.url());
  await session.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  const controls = await popup();
  try { await quiz.bringToFront(); await action(quiz, controls); }
  finally { await controls.close(); await quiz.close(); }
}
async function start(controls) { return controls.evaluate(() => chrome.runtime.sendMessage({ type: 'answer' })); }
async function finish() { await until(() => worker.evaluate(() => jobs.size === 0)); }

test('Answer opens AI access in Settings when a hosted trial is needed', async () => {
  await scenario(async (_quiz, controls) => {
    assert.equal(await controls.locator('#hostedPanel').isVisible(), false);
    await controls.locator('#answerNow').click();
    await controls.locator('#adultConsent').waitFor({ state: 'visible' });
    assert.equal(await controls.locator('#settingsToggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await controls.locator('#adultConsent').evaluate(node => node === document.activeElement), true);
    assert.match(await controls.locator('#message').textContent(), /free trial/);
    assert.equal(await controls.locator('#message').isVisible(), true);
    assert.equal((await worker.evaluate(() => hostedCalls)).length, 0);
  });
});

test('new hosted installations ask for consent and never send an API request just by opening the popup', async () => {
  const controls = await popup();
  try {
    assert.equal(await controls.locator('input[name="billingMode"][value="hosted"]').isChecked(), true);
    assert.equal(await controls.locator('#startTrial').isDisabled(), true);
    assert.equal(await controls.locator('#creditBalance').textContent(), '15 free answers');
    assert.equal((await worker.evaluate(() => hostedCalls)).length, 0);
    assert.equal(await controls.locator('#hostedPanel').isVisible(), false);
    await controls.locator('#settingsToggle').click();
    assert.equal(await controls.getByRole('group', { name: 'AI access', exact: true }).locator('#hostedPanel').isVisible(), true);
    await controls.locator('#adultConsent').check();
    assert.equal(await controls.locator('#startTrial').isDisabled(), true);
    await controls.locator('#dataConsent').check();
    await controls.locator('#startTrial').click();
    await until(() => controls.locator('#trialConsent').isHidden());
    assert.equal(await controls.locator('#settingsPanel').isHidden(), true);
    assert.equal(await controls.locator('#answerNow').isVisible(), true);
    assert.equal(await controls.locator('#creditBalance').textContent(), '15 credits left');
    const calls = await worker.evaluate(() => hostedCalls);
    assert.equal(calls[0].body.adultConsent, true);
    assert.equal(calls[0].body.dataConsent, true);
    assert.equal(calls[0].authorization, undefined);
    assert.equal(await controls.locator('#buyCredits').isDisabled(), true);
    fs.mkdirSync(path.resolve(__dirname, '../test-results'), { recursive: true });
    await controls.locator('body').screenshot({ path: path.resolve(__dirname, '../test-results/hosted-trial.png') });
  } finally { await controls.close(); }
});

test('a hosted suggestion clicks once then settles, while balance refresh never releases an active reservation', async () => {
  await worker.evaluate(() => { hostedCalls.length = 0; hostedMock.delay = 250; });
  await scenario(async (quiz, controls) => {
    assert.equal((await start(controls)).ok, true);
    await until(() => worker.evaluate(() => hostedCalls.some(c => c.route === '/v1/answers')));
    await worker.evaluate(() => ClickItHosted.state(true));
    assert.equal((await worker.evaluate(() => hostedCalls.filter(c => c.route === '/v1/answers/complete'))).length, 0);
    const blocked = await controls.evaluate(() => chrome.runtime.sendMessage({ type: 'checkout' }));
    assert.equal(blocked.ok, false);
    await finish();
    assert.equal(await quiz.evaluate(() => clicks), 1);
    assert.equal(await quiz.evaluate(() => submits), 0);
    const calls = await worker.evaluate(() => hostedCalls);
    const request = calls.find(c => c.route === '/v1/answers');
    assert.deepEqual(request.body.question.options, ['3','4']);
    assert.equal(request.authorization, `Bearer ${token}`);
    assert.equal(request.body.prompt, await worker.evaluate(() => settings.textPrompt));
    const completion = calls.find(c => c.route === '/v1/answers/complete');
    assert.equal(completion.body.delivered, true);
    assert.equal(completion.body.requestId, request.body.requestId);
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('hostedPending')).hostedPending), {});
    await controls.evaluate(() => refresh());
    assert.equal(await controls.locator('#creditBalance').textContent(), '14 credits left');
    // Store artwork shows the intended launch configuration, not the disabled pilot gate.
    await worker.evaluate(async () => { hostedMock.checkoutEnabled = true; await ClickItHosted.state(true); });
    await controls.evaluate(() => refresh());
    await controls.locator('body').screenshot({ path: path.resolve(__dirname, '../test-results/hosted-answer.png') });
    await worker.evaluate(async () => { hostedMock.checkoutEnabled = false; await ClickItHosted.state(true); });
  });
});

test('changed questions and timeouts release reservations without selecting answers', async () => {
  for (const timeout of [false, true]) {
    await worker.evaluate(timeout => { hostedCalls.length = 0; hostedMock.delay = timeout ? 1000 : 250; settings.timeoutMs = timeout ? 200 : 5000; }, timeout);
    await scenario(async (quiz, controls) => {
      await start(controls);
      await until(() => worker.evaluate(() => hostedCalls.some(c => c.route === '/v1/answers')));
      if (!timeout) await quiz.locator('h1').evaluate(node => { node.textContent = 'Different question?'; });
      await finish();
      assert.equal(await quiz.evaluate(() => clicks), 0);
      const completed = await worker.evaluate(() => hostedCalls.find(c => c.route === '/v1/answers/complete'));
      assert.equal(completed.body.delivered, false);
    });
  }
});

test('malformed hosted Text and Vision results release the credit without clicking', async () => {
  const box = { left: .1, top: .1, right: .9, bottom: .9 };
  const boxes = { question: box, choices: box, target: box };
  try {
    for (const [mode, result] of [
      ['text', { index: 2, confidence: .9 }],
      ['text', { index: 1.5, confidence: .9 }],
      ['text', { index: 1, confidence: 2 }],
      ['vision', { boxes: {}, confidence: .9 }],
      ['vision', { boxes: { ...boxes, target: { ...box, right: 2 } }, confidence: .9 }],
      ['vision', { boxes: { ...boxes, target: { ...box, left: .9, right: .1 } }, confidence: .9 }],
      ['vision', { boxes, confidence: -1 }]
    ]) {
      await worker.evaluate(async ({ mode, result }) => {
        settings.mode = mode;
        hostedCalls.length = 0;
        Object.assign(hostedMock, { delay: 0, visionEnabled: true, result });
        await ClickItHosted.state(true);
      }, { mode, result });
      await scenario(async (quiz, controls) => {
        const key = `${mode}Prompt`, prompt = `Custom ${mode} instructions.\nChoose the best answer.`;
        await controls.getByRole('button', { name: 'Settings', exact: true }).click();
        await controls.locator('#promptSettings > summary').click();
        await controls.locator(`#${key}`).fill(prompt);
        await finishEditing(controls);
        await quiz.bringToFront();
        assert.equal((await start(controls)).ok, true);
        await finish();
        assert.equal(await quiz.evaluate(() => clicks), 0);
        const calls = await worker.evaluate(() => hostedCalls);
        assert.equal(calls.find(c => c.route === '/v1/answers').body.mode, mode);
        assert.equal(calls.find(c => c.route === '/v1/answers').body.prompt, prompt);
        assert.equal(calls.find(c => c.route === '/v1/answers/complete').body.delivered, false);
      });
    }
  } finally {
    await worker.evaluate(async () => {
      settings.mode = 'text';
      delete hostedMock.result;
      hostedMock.visionEnabled = false;
      await ClickItHosted.state(true);
    });
  }
});

test('offline completion persists the settlement and retries instead of making another paid request', async () => {
  await worker.evaluate(() => { hostedCalls.length = 0; hostedMock.delay = 0; hostedMock.failCompletion = true; settings.timeoutMs = 5000; });
  await scenario(async (_quiz, controls) => {
    await start(controls); await finish();
    const pending = await worker.evaluate(async () => (await chrome.storage.local.get('hostedPending')).hostedPending);
    assert.equal(Object.values(pending)[0], true);
    await start(controls); await finish();
    assert.equal((await worker.evaluate(() => hostedCalls.filter(c => c.route === '/v1/answers'))).length, 1);
    await worker.evaluate(async () => { hostedMock.failCompletion = false; await ClickItHosted.state(true); });
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('hostedPending')).hostedPending), {});
  });
});

test('subscription selection opens only hosted Stripe checkout, and restore validates the access key with the server', async () => {
  const controls = await popup();
  try {
    await worker.evaluate(async () => { hostedMock.checkoutEnabled = true; await ClickItHosted.state(true); });
    await controls.evaluate(() => refresh());
    await controls.locator('#settingsToggle').click();
    await controls.locator('#subscriptionPlan').selectOption('plus');
    await controls.locator('#buyCredits').click();
    await until(() => worker.evaluate(() => openedCheckouts.length === 1));
    assert.equal((await worker.evaluate(() => openedCheckouts))[0], 'https://checkout.stripe.com/c/pay_test');
    assert.equal((await worker.evaluate(() => hostedCalls.find(c => c.route === '/v1/checkout'))).body.planId, 'plus');
    await controls.locator('#accessRecovery summary').click();
    assert.equal(await controls.locator('#hostedAccessKey').inputValue(), token);
    await controls.locator('#showAccessKey').click();
    await controls.locator('#restoreAccess').click();
    await until(async () => (await controls.locator('#message').textContent()).includes('restored'));
    assert.equal(await controls.locator('#hostedAccessKey').getAttribute('type'), 'password');
    assert.equal(await controls.locator('#showAccessKey').getAttribute('aria-pressed'), 'false');
    await controls.locator('body').screenshot({ path: path.resolve(__dirname, '../test-results/hosted-settings.png') });
  } finally { await controls.close(); }
});

test('subscription controls preview upgrades before charging and manage renewals while checkout is disabled', async () => {
  await worker.evaluate(async () => {
    hostedCalls.length=0; serverCredits=210; hostedMock.monthlyCredits=200;
    hostedMock.subscription={ planId:'basic', status:'active', allowance:500, periodEnd:Date.now()+86400000, cancelAtPeriodEnd:false, scheduledPlan:null, pendingUpgrade:false };
    await ClickItHosted.state(true);
  });
  const controls = await popup();
  try {
    await controls.locator('#settingsToggle').click();
    assert.equal(await controls.locator('#subscribeOptions').isHidden(), true);
    assert.equal(await controls.locator('#creditBalance').textContent(), '210 credits left');
    assert.equal((await worker.evaluate(() => ClickItHosted.state())).balance.monthlyCredits, 200);
    await controls.locator('#upgradePlan').click();
    await controls.locator('#upgradeQuote').waitFor({ state:'visible' });
    assert.match(await controls.locator('#upgradeQuoteText').textContent(), /700 credits/);
    assert.equal(await controls.locator('#subscriptionActions').isHidden(), true);
    assert.match(await controls.locator('#confirmUpgrade').textContent(), /Pay.*2\.50.*upgrade/);
    assert.equal((await worker.evaluate(() => hostedCalls.filter(c => c.route === '/v1/subscription/change'))).length, 0);
    await controls.evaluate(() => { upgradeQuote.expiresAt = Date.now()-1; controls(); });
    assert.equal(await controls.locator('#confirmUpgrade').textContent(), 'Get a new quote');
    await controls.locator('#confirmUpgrade').click();
    await until(async () => (await controls.locator('#confirmUpgrade').textContent()).startsWith('Pay'));
    assert.equal((await worker.evaluate(() => hostedCalls.filter(c => c.route === '/v1/subscription/change'))).length, 0);
    await controls.locator('#confirmUpgrade').click();
    await until(async () => (await controls.locator('#creditBalance').textContent()) === '910 credits left');
    assert.equal((await worker.evaluate(() => ClickItHosted.state())).balance.monthlyCredits, 900);
    await controls.locator('body').screenshot({ path:path.resolve(__dirname,'../test-results/hosted-subscription.png') });
    await controls.locator('#downgradePlan').click();
    await until(async () => (await controls.locator('#creditNote').textContent()).includes('renews on Basic'));
    await controls.locator('#keepPlan').click();
    await until(() => controls.locator('#keepPlan').isHidden());
    await worker.evaluate(async () => { hostedMock.checkoutEnabled=false; await ClickItHosted.state(true); });
    await controls.evaluate(() => refresh());
    assert.equal(await controls.locator('#downgradePlan').isDisabled(), true);
    assert.equal(await controls.locator('#manageSubscription').isDisabled(), false);
    await controls.locator('#manageSubscription').click();
    await until(() => worker.evaluate(() => openedCheckouts.includes('https://billing.stripe.com/p/session_test')));
    await controls.locator('#cancelSubscription').click();
    await until(async () => (await controls.locator('#creditNote').textContent()).includes('Automatic renewal is off'));
    await controls.locator('#resumeSubscription').click();
    await until(() => controls.locator('#resumeSubscription').isHidden());
    assert.equal(await controls.evaluate(() => document.documentElement.scrollWidth>innerWidth), false);
  } finally { await controls.close(); }
});

test('reopening the popup can retry a lost billing response using the original change ID',async()=>{
  await worker.evaluate(async()=>{
    hostedCalls.length=0;serverCredits=210;hostedMock.monthlyCredits=200;hostedMock.checkoutEnabled=true;hostedMock.loseChangeResponse=true;
    hostedMock.subscription={planId:'basic',status:'active',allowance:500,periodEnd:Date.now()+86400000,cancelAtPeriodEnd:false,scheduledPlan:null,pendingUpgrade:false};
    await ClickItHosted.state(true);
  });
  let controls=await popup();
  try{
    await controls.locator('#settingsToggle').click();
    await controls.locator('#upgradePlan').click();await controls.locator('#upgradeQuote').waitFor({state:'visible'});
    await controls.locator('#confirmUpgrade').click();
    await until(async()=>(await controls.locator('#message').textContent()).includes('Billing response lost'));
    assert.equal(await controls.locator('#upgradeQuote').isVisible(), true);
    await controls.close();controls=await popup();
    await controls.locator('#settingsToggle').click();
    await controls.locator('#retryBilling').waitFor({state:'visible'});
    await controls.locator('#retryBilling').click();
    await until(()=>controls.locator('#retryBilling').isHidden());
    assert.equal(await controls.locator('#creditBalance').textContent(), '910 credits left');
    assert.equal((await worker.evaluate(() => ClickItHosted.state())).balance.monthlyCredits, 900);
    const changes=await worker.evaluate(()=>hostedCalls.filter(c=>c.route==='/v1/subscription/change'));
    assert.equal(changes.length,2);assert.equal(changes[0].body.changeId,changes[1].body.changeId);
    assert.equal(await worker.evaluate(()=>serverCredits),910);
  }finally{await controls.close();}
});

test('payment problems offer billing recovery instead of another plan change', async () => {
  const controls = await popup();
  try {
    await controls.locator('#accountEntry').click();
    const subscription = { planId: 'basic', status: 'active', allowance: 500, periodEnd: Date.now()+86400000, cancelAtPeriodEnd: false };
    for (const state of [
      { status: 'past_due', paymentActionRequired: true },
      { pendingUpgrade: true }
    ]) {
      await worker.evaluate(async state => {
        hostedMock.subscription = state;
        await ClickItHosted.state(true);
      }, { ...subscription, ...state });
      await controls.evaluate(() => refresh());
      assert.equal(await controls.locator('#upgradePlan').isHidden(), true);
      assert.equal(await controls.locator('#manageSubscription').isVisible(), true);
      assert.match(await controls.locator('#manageSubscription').textContent(), /Resolve payment/);
    }
  } finally { await controls.close(); }
});

test('checkout failures clear pending feedback and do not allow duplicate checkout clicks', async () => {
  await worker.evaluate(async () => {
    hostedMock.subscription = null; hostedMock.checkoutEnabled = true; await ClickItHosted.state(true);
  });
  const controls = await popup();
  try {
    await controls.locator('#accountEntry').click();
    await controls.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.checkoutAttempts = 0;
      chrome.runtime.sendMessage = async message => {
        if (message.type !== 'checkout') return original(message);
        checkoutAttempts++;
        await new Promise(resolve => { globalThis.finishCheckout = resolve; });
        return { ok: false, error: 'Cannot open checkout. Try again.' };
      };
    });
    await controls.locator('#buyCredits').click();
    assert.equal(await controls.locator('#buyCredits').isDisabled(), true);
    assert.equal(await controls.locator('#subscriptionPlan').isDisabled(), true);
    assert.match(await controls.locator('#message').textContent(), /Opening secure checkout/);
    await controls.evaluate(() => { document.getElementById('buyCredits').click(); finishCheckout(); });
    await controls.waitForFunction(() => document.getElementById('message').textContent.includes('Cannot open checkout'));
    assert.doesNotMatch(await controls.locator('#message').textContent(), /Opening/);
    assert.equal(await controls.locator('#message').getAttribute('role'), 'alert');
    assert.equal(await controls.locator('#buyCredits').isEnabled(), true);
    assert.equal(await controls.evaluate(() => checkoutAttempts), 1);
  } finally { await controls.close(); }
});

test('unavailable balances show their status without offering another subscription', async () => {
  const controls = await popup();
  try {
    await controls.locator('#accountEntry').click();
    await controls.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      globalThis.balanceUnavailable = true;
      chrome.runtime.sendMessage = async message => {
        const reply = await original(message);
        if (message.type === 'inspect' && balanceUnavailable) {
          reply.data.hosted.balance = null;
          reply.data.hosted.error = 'Offline. Try Refresh.';
        }
        return reply;
      };
      return refresh();
    });
    assert.equal(await controls.locator('#creditBalance').textContent(), 'Balance unavailable');
    assert.equal(await controls.locator('#subscribeOptions').isHidden(), true);
    assert.match(await controls.locator('#creditError').textContent(), /Offline/);
    assert.equal(await controls.locator('#refreshBalance').count(), 0);
    assert.equal(await controls.locator('.credit-heading').count(), 0);
    assert.equal(await controls.locator('#creditBalance').isVisible(), true);
    await controls.evaluate(() => { balanceUnavailable = false; return refresh(); });
    await until(async () => (await controls.locator('#creditBalance').textContent()).includes('credits left'));
  } finally { await controls.close(); }
});

async function finishEditing(controls) {
  await controls.evaluate(async () => {
    document.activeElement?.blur();
    await settingsSave;
  });
  if (await controls.locator('#settingsPanel').isVisible()) await controls.locator('#settingsToggle').click();
}
