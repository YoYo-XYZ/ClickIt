(() => {
  let credential = '', cached = null, lastRefresh = 0, refreshing, registering;
  let consented = false;
  let pending = {};
  let billingOperation = null;
  const live = new Set();
  const config = ClickItConfig;
  const ready = chrome.storage.local.get(['hostedCredential', 'hostedConsent', 'hostedBalance', 'hostedPending', 'hostedBillingOperation']).then(stored => {
    credential = stored.hostedCredential || '';
    consented = stored.hostedConsent === true;
    cached = stored.hostedBalance || null;
    pending = stored.hostedPending || {};
    billingOperation = stored.hostedBillingOperation || null;
  });
  const configured = (() => {
    try { const url = new URL(config.apiUrl); return url.protocol === 'https:' && url.origin === config.apiUrl; }
    catch { return false; }
  })();
  async function api(path, data, options = {}) {
    await ready;
    if (!configured) throw new Error('Hosted service is not configured in this build. Use your own API key in Advanced settings.');
    const response = await fetch(`${config.apiUrl}/v1/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(options.anonymous ? {} : { Authorization: `Bearer ${options.credential || credential}` }),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: options.signal || AbortSignal.timeout(8000), credentials: 'omit'
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(typeof result.error === 'string' ? result.error : 'Hosted service unavailable.');
      error.status = response.status;
      throw error;
    }
    return result;
  }
  async function rememberBalance(value) {
    cached = value;
    lastRefresh = Date.now();
    await chrome.storage.local.set({ hostedBalance: value });
  }
  async function reconcile() {
    for (const [requestId, delivered] of Object.entries(pending)) {
      if (live.has(requestId)) continue;
      try { await rememberBalance(await api('answers/complete', { requestId, delivered })); }
      catch (error) { if (![404, 409].includes(error.status)) continue; }
      delete pending[requestId];
      await chrome.storage.local.set({ hostedPending: pending });
    }
  }
  async function refresh(force = false) {
    await ready;
    if (!credential || !configured) return;
    if (refreshing) return refreshing;
    if (!force && Date.now() - lastRefresh < 15000) return;
    refreshing = (async () => {
      // Back off on an unavailable backend even when no balance has been returned.
      lastRefresh = Date.now();
      await reconcile();
      await rememberBalance(await api('balance'));
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  async function state(force = false) {
    let error = '';
    try { await refresh(force); } catch (e) { error = e.message; }
    await ready;
    return { configured, registered: Boolean(credential), consented, credential,
      balance: cached, pending: Object.keys(pending).length, billingOperationPending: Boolean(billingOperation), error };
  }
  async function register(consent) {
    await ready;
    if (consent.adultConsent !== true || consent.dataConsent !== true) throw new Error('Confirm age and data processing before starting.');
    if (credential) {
      await chrome.storage.local.set({ hostedConsent: true });
      consented = true;
      return state(true);
    }
    if (registering) return registering;
    registering = (async () => {
      const { credential: accessKey, installationId: _installationId, ...value } = await api('installations', { adultConsent: consent.adultConsent === true,
        dataConsent: consent.dataConsent === true, source: 'chrome-web-store' }, { anonymous: true });
      credential = accessKey;
      await chrome.storage.local.set({ hostedCredential: credential, hostedConsent: true });
      consented = true;
      await rememberBalance(value);
      return state();
    })();
    try { return await registering; } finally { registering = null; }
  }
  async function answer(q, mode, job) {
    await ready;
    if (!consented) throw new Error('Review and accept the data sharing disclosure in the popup before answering.');
    await reconcile();
    if (!credential) throw new Error('Start your free trial first.');
    if (Object.keys(pending).length) throw new Error('A previous credit is still syncing. Refresh your balance before answering again.');
    job.hostedRequestId = crypto.randomUUID();
    live.add(job.hostedRequestId);
    // Persist a default release before sending so worker restarts never strand credits.
    pending[job.hostedRequestId] = false;
    await chrome.storage.local.set({ hostedPending: pending });
    const result = await api('answers', { requestId: job.hostedRequestId, mode,
      ...(mode === 'vision' ? { image: q.data } : { question: q }) }, { signal: job.controller.signal });
    // Validate again before any page interaction. The backend never returns executable code.
    const validated = mode === 'text' ? ClickIt.validateAnswer(result.result, q.options.length) : ClickIt.validateVision(result.result);
    return { ...validated, apiMs: result.apiMs };
  }
  async function complete(job, delivered) {
    if (!job.hostedRequestId) return true;
    pending[job.hostedRequestId] = delivered;
    await chrome.storage.local.set({ hostedPending: pending });
    live.delete(job.hostedRequestId);
    await reconcile();
    return !Object.hasOwn(pending, job.hostedRequestId);
  }
  async function openStripe(path, data, origin) {
    const result = await api(path, data, { signal: AbortSignal.timeout(30000) });
    if (new URL(result.url).origin !== origin) throw new Error('Invalid payment URL.');
    await chrome.tabs.create({ url: result.url });
    return { opened: true };
  }
  function checkout(planId) {
    return openStripe('checkout', { checkoutId: crypto.randomUUID(), planId }, 'https://checkout.stripe.com');
  }
  function portal() { return openStripe('billing-portal', {}, 'https://billing.stripe.com'); }
  function preview() { return api('subscription/preview', { planId: 'plus' }, { signal: AbortSignal.timeout(30000) }); }
  async function change(action, quoteId) {
    await ready;
    const stored = billingOperation;
    const data = stored && stored.action === action && stored.quoteId === quoteId ? stored : { action, quoteId, changeId: crypto.randomUUID() };
    billingOperation = data;
    await chrome.storage.local.set({ hostedBillingOperation: data });
    const result = await api('subscription/change', data, { signal: AbortSignal.timeout(30000) });
    await rememberBalance(result);
    await chrome.storage.local.remove('hostedBillingOperation');
    billingOperation = null;
    return result;
  }
  async function retryChange() {
    await ready;
    if (!billingOperation) throw new Error('There is no billing change to retry.');
    return change(billingOperation.action, billingOperation.quoteId);
  }
  async function restore(value) {
    await ready;
    if (Object.keys(pending).length) throw new Error('Wait for pending credits to sync before restoring access.');
    if (!/^ci_[a-f0-9]{64}$/.test(value)) throw new Error('Paste your complete installation access key.');
    const valueBalance = await api('balance', undefined, { credential: value });
    credential = value;
    await chrome.storage.local.set({ hostedCredential: value });
    await chrome.storage.local.remove('hostedBillingOperation');
    billingOperation = null;
    await rememberBalance(valueBalance);
    return { restored: true };
  }
  globalThis.ClickItHosted = { state, register, answer, complete, checkout, portal, preview, change, retryChange, restore };
})();
