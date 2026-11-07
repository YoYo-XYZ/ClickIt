(() => {
  let credential = '', installationId = '', cached = null, lastRefresh = 0, refreshing, registering;
  let pending = {};
  const live = new Set();
  const config = ClickItConfig;
  const ready = chrome.storage.local.get(['hostedCredential', 'hostedInstallationId', 'hostedBalance', 'hostedPending']).then(stored => {
    credential = stored.hostedCredential || '';
    installationId = stored.hostedInstallationId || '';
    cached = stored.hostedBalance || null;
    pending = stored.hostedPending || {};
  });
  function configured() {
    try { const url = new URL(config.apiUrl); return url.protocol === 'https:' && url.origin === config.apiUrl; }
    catch { return false; }
  }
  async function api(path, data, options = {}) {
    await ready;
    if (!configured()) throw new Error('Hosted service is not configured in this build. Use your own API key in Advanced settings.');
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
    if (!credential || !configured()) return;
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
    return { configured: configured(), registered: Boolean(credential), installationId, credential,
      balance: cached, pending: Object.keys(pending).length, error };
  }
  async function register(consent) {
    await ready;
    if (credential) return state(true);
    if (registering) return registering;
    registering = (async () => {
      const result = await api('installations', { adultConsent: consent.adultConsent === true,
        dataConsent: consent.dataConsent === true, source: 'chrome-web-store' }, { anonymous: true });
      credential = result.credential;
      installationId = result.installationId;
      await chrome.storage.local.set({ hostedCredential: credential, hostedInstallationId: installationId });
      const { credential: _secret, installationId: _id, ...value } = result;
      await rememberBalance(value);
      return state();
    })();
    try { return await registering; } finally { registering = null; }
  }
  async function answer(q, mode, job) {
    await ready;
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
    const r = result.result;
    // Validate again before any page interaction. The backend never returns executable code.
    if (mode === 'text') {
      if (!r || !Number.isInteger(r.index) || r.index < 0 || r.index >= q.options.length ||
        !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) throw new Error('Hosted service returned an invalid answer.');
    } else {
      const response = { model: 'jev-1.14.0', answers: { ready: { type: 'noul', noul: 1 } } };
      for (const name of ['question', 'choices', 'target']) response.answers[name] = { type: 'box', box: r?.boxes?.[name], confidence: r?.confidence };
      ClickIt.parseVision(response, 'typesafe');
    }
    return { ...r, apiMs: result.apiMs };
  }
  async function complete(job, delivered) {
    if (!job.hostedRequestId) return true;
    pending[job.hostedRequestId] = delivered;
    await chrome.storage.local.set({ hostedPending: pending });
    live.delete(job.hostedRequestId);
    await reconcile();
    return !Object.hasOwn(pending, job.hostedRequestId);
  }
  async function checkout() {
    await ready;
    const result = await api('checkout', { checkoutId: crypto.randomUUID() });
    if (new URL(result.url).origin !== 'https://checkout.stripe.com') throw new Error('Invalid payment URL.');
    await chrome.tabs.create({ url: result.url });
    return { opened: true };
  }
  async function restore(value) {
    await ready;
    if (Object.keys(pending).length) throw new Error('Wait for pending credits to sync before restoring access.');
    if (!/^ci_[a-f0-9]{64}$/.test(value)) throw new Error('Paste your complete installation access key.');
    const valueBalance = await api('balance', undefined, { credential: value });
    credential = value;
    installationId = '';
    await chrome.storage.local.set({ hostedCredential: value, hostedInstallationId: '' });
    await rememberBalance(valueBalance);
    return { restored: true };
  }
  globalThis.ClickItHosted = { state, register, answer, complete, checkout, restore, refresh };
})();
