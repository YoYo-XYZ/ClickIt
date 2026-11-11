importScripts('core.js', 'vision.js', 'config.js', 'hosted.js');
const C = ClickIt;
const V = ClickItVision;
const jobs = new Map();
const statuses = new Map();
const suggestions = new Map();
let settings;
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  settings = C.validateSettings((await chrome.storage.local.get('settings')).settings || {});
  // Drop settings from the former automatic/typed-answer modes on upgrade.
  await chrome.storage.local.set({ settings });
})();

async function clearSuggestion(tabId) {
  const target = suggestions.get(tabId)?.target;
  suggestions.delete(tabId);
  if (target) await chrome.scripting.executeScript({ target, func: () => globalThis.ClickItPage?.cancel() }).catch(() => {});
}

function toolbar(tabId, badge = '', text = 'ClickIt') {
  void Promise.all([
    chrome.action.setBadgeText({ tabId, text: badge }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge === 'ERR' ? '#a83232' : '#285b49' }),
    chrome.action.setTitle({ tabId, title: text === 'ClickIt' ? text : `ClickIt: ${text}` })
  ]).catch(() => {}); // The tab may have closed.
}

function reportStatus(tabId, value, badge) {
  const previous = statuses.get(tabId);
  statuses.set(tabId, { ...value, lastAction: value.answer ? value : previous?.lastAction });
  if (statuses.size > 64) statuses.delete(statuses.keys().next().value);
  toolbar(tabId, badge, value.text);
}

async function startAnswer(tab) {
  await ready;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open a regular webpage and press Answer or use the answer hotkey.');
  if (jobs.has(tab.id)) throw new Error('Already answering this tab.');
  if (settings.billingMode === 'hosted' && jobs.size) {
    const text = 'Another answer is active. Please wait.';
    reportStatus(tab.id, { text }, 'ERR');
    throw new Error(text);
  }
  const config = settings;
  const job = { controller: new AbortController(), windowId: tab.windowId, vision: config.mode === 'vision' };
  // Reserve before async setup checks so repeated commands cannot start or charge twice.
  jobs.set(tab.id, job);
  reportStatus(tab.id, { text: 'Preparing answer…' }, '…');
  try {
    if (tab.url && !/^https?:\/\//.test(tab.url)) throw new Error('Open a regular webpage and press Answer or use the answer hotkey.');
    if (config.billingMode === 'byok' && !config.apiKey) throw new Error('Add your API key in Settings first.');
    if (config.billingMode === 'byok' && !config.byokConsent) throw new Error('Review and accept the data sharing disclosure in Settings before answering.');
    if (config.billingMode === 'hosted') {
      const hosted = await ClickItHosted.state();
      if (!hosted.configured) throw new Error('Hosted service is not configured in this build. Use your own API key in Advanced settings.');
      if (!hosted.registered) throw new Error('Start your free trial first.');
      if (!hosted.consented) throw new Error('Review and accept the data sharing disclosure in the popup before answering.');
      if (config.mode === 'vision' && !hosted.balance?.visionEnabled) throw new Error('Hosted Vision is awaiting compatibility validation. Use Text or your own API key.');
    }
    job.controller.signal.throwIfAborted();
    void run(tab.id, job, config);
    return { started: true };
  } catch (error) {
    if (jobs.get(tab.id) === job) {
      if (!job.navigated) reportStatus(tab.id, { text: error.message }, 'ERR');
      jobs.delete(tab.id);
    }
    throw error;
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'answer-question') void startAnswer(tab).catch(() => {});
});

async function decide(q, config, signal) {
  const provider = C.providers[config.provider];
  const vision = config.mode === 'vision';
  const started = performance.now();
  const response = await fetch(provider.endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
      ...(vision && config.provider === 'typesafe' ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}) },
    body: JSON.stringify(vision ? C.visionRequest(q.data, config.provider, config.visionPrompt) : C.requestBody(q, config.provider, config.textPrompt)), signal, credentials: 'omit'
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error(`${provider.name} rejected the API key (HTTP 401). Select the provider that issued your key and save its key in Settings.`);
    const descriptions = { 402: 'Check provider credits or spending limits', 403: 'API access denied', 429: 'API rate limit reached', 529: 'Jev is temporarily overloaded' };
    throw new Error(`${descriptions[response.status] || 'Request failed'} (HTTP ${response.status}). Press Answer to retry.`);
  }
  const body = await response.json();
  return { ...(vision ? C.parseVision(body, config.provider) : C.parseAnswer(body, q.options.length, config.provider)),
    apiMs: Math.round(performance.now() - started) };
}

async function run(tabId, job, config) {
  let target, suggested = false, delivered = false;
  const vision = config.mode === 'vision';
  const pageCall = async (method, ...args) => {
    const [action] = await chrome.scripting.executeScript({
      target,
      func: (method, args) => {
        try {
          if (!globalThis.ClickItPage) throw new Error('The page changed. Press Answer again.');
          return globalThis.ClickItPage[method](...args);
        } catch (error) { return { error: error.message }; }
      },
      args: [method, args]
    }).catch(() => { throw new Error('The page changed or access was lost. Press Answer again.'); });
    if (action?.result?.error) throw new Error(action.result.error);
    if (!action?.result) throw new Error('The page changed. Press Answer again.');
    return action.result;
  };
  const started = performance.now();
  const report = (value, badge = '…') => {
    if (jobs.get(tabId) !== job || job.navigated) return;
    reportStatus(tabId, value, badge);
  };
  try {
    await clearSuggestion(tabId);
    job.controller.signal.throwIfAborted();
    report({ text: vision ? 'Capturing visible tab…' : 'Reading question…' });
    let snapshot;
    try {
      [snapshot] = await chrome.scripting.executeScript({ target: { tabId },
        ...(vision ? { func: V.install } : { files: ['content.js'] }) });
    } catch { throw new Error('Cannot access this page. Open a regular webpage and press Answer or use the answer hotkey.'); }
    if (snapshot?.result?.error) throw new Error(snapshot.result.error);
    if (!snapshot?.result) throw new Error('No unambiguous single-choice text question found. This layout is unsupported.');
    target = { tabId, documentIds: [snapshot.documentId] };
    const q = vision ? await V.prepare(await V.capture(tabId, job.windowId, job.controller.signal)) : C.validateQuestion(snapshot.result);
    report({ text: 'Jev is choosing…' });
    const timeout = setTimeout(() => job.controller.abort(new Error('Request expired or was cancelled. Press Answer to retry.')), config.timeoutMs);
    let result;
    try { result = config.billingMode === 'hosted' ? await ClickItHosted.answer(q, config, job) : await decide(q, config, job.controller.signal); }
    finally { clearTimeout(timeout); }
    if (job.controller.signal.aborted) throw new Error('Request cancelled.');
    if (result.confidence < config.minConfidence) throw new Error(`Skipped: answer confidence ${Math.round(result.confidence * 100)}% is below your ${Math.round(config.minConfidence * 100)}% threshold.`);
    let clickTarget = result.index, targetRegion;
    if (vision) {
      const { target: answerBox, choices } = result.boxes;
      const x = (answerBox.left + answerBox.right) / 2, y = (answerBox.top + answerBox.bottom) / 2;
      if (x < choices.left || x > choices.right || y < choices.top || y > choices.bottom) {
        throw new Error('The answer target is outside the answer choices. No click made.');
      }
      targetRegion = V.region(q, answerBox, snapshot.result);
      clickTarget = { x: targetRegion.x + targetRegion.width / 2, y: targetRegion.y + targetRegion.height / 2 };
      const regions = [result.boxes.question, choices, answerBox];
      await pageCall('watch', clickTarget, regions.map(box => V.region(q, box, snapshot.result)));
      job.controller.signal.throwIfAborted();
    }
    const action = await pageCall('click', clickTarget, targetRegion);
    if (action.suggested) job.controller.signal.throwIfAborted();
    suggested = action.suggested === true;
    delivered = true;
    if (suggested) suggestions.set(tabId, { target, windowId: job.windowId });
    const status = { text: suggested ? 'Click the highlighted answer manually. No automatic click made.' :
      action.clicked ? 'Answer clicked. Submit it yourself if needed.' : 'Answer already selected. No click needed.',
      answer: vision ? action.answer : q.options[result.index], confidence: result.confidence, apiMs: result.apiMs, totalMs: Math.round(performance.now() - started) };
    report(status, suggested ? '!' : '✓');
    if (config.billingMode === 'hosted') {
      const synced = await ClickItHosted.complete(job, true).catch(() => false);
      if (!synced) report({ ...status, text: `${status.text} Balance update pending.` }, '!');
    }
  } catch (error) {
    report({ text: job.controller.signal.aborted ? job.controller.signal.reason?.message || 'Request expired or was cancelled. Press Answer to retry.' :
      error instanceof TypeError ? `Cannot reach ${config.billingMode === 'hosted' ? 'ClickIt' : C.providers[config.provider].name}. Check your connection and press Answer.` : error.message }, 'ERR');
  } finally {
    if (!delivered && job.hostedRequestId) await ClickItHosted.complete(job, false).catch(() => {});
    if (target && !suggested) await chrome.scripting.executeScript({ target, func: () => globalThis.ClickItPage?.cancel() }).catch(() => {});
    if (jobs.get(tabId) === job) jobs.delete(tabId);
  }
}

const accountActions = {
  startTrial: message => ClickItHosted.register(message),
  refreshBalance: () => ClickItHosted.state(true),
  checkout: message => ClickItHosted.checkout(message.planId),
  restoreAccess: message => ClickItHosted.restore(message.credential),
  billingPortal: () => ClickItHosted.portal(),
  previewUpgrade: () => ClickItHosted.preview(),
  changeSubscription: message => ClickItHosted.change(message.action, message.quoteId),
  retryBilling: () => ClickItHosted.retryChange()
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Page scripts have no API or settings access. Messages must come from the popup.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  (async () => {
    await ready;
    if (message.type === 'inspect') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (message.opened && tab?.id && !jobs.has(tab.id)) toolbar(tab.id);
      return { settings, hosted: await ClickItHosted.state(), busy: jobs.has(tab?.id) || (settings.billingMode === 'hosted' && jobs.size > 0), status: statuses.get(tab?.id) || { text: 'Ready. Press Answer for this question.' } };
    }
    if (Object.hasOwn(accountActions, message.type)) {
      if (jobs.size) throw new Error('Wait for the current answer before changing credits or access.');
      return accountActions[message.type](message);
    }
    if (message.type === 'save') {
      if (jobs.size) throw new Error('Wait for the current answer before saving settings.');
      settings = C.validateSettings(message.settings);
      await chrome.storage.local.set({ settings });
      return { saved: true };
    }
    if (message.type === 'answer') return startAnswer();
    throw new Error('Unknown request.');
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { jobs.get(tabId)?.controller.abort(); jobs.delete(tabId); statuses.delete(tabId); suggestions.delete(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && !change.url) return;
  const job = jobs.get(tabId);
  if (job) {
    job.navigated = true;
    job.controller.abort(new Error('The page changed. Press Answer again.'));
  }
  statuses.delete(tabId);
  void clearSuggestion(tabId);
  toolbar(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const [id, suggestion] of suggestions) if (suggestion.windowId === windowId && id !== tabId) void clearSuggestion(id);
  for (const [id, job] of jobs) if (job.vision && job.windowId === windowId && id !== tabId) {
    job.controller.abort(new Error('The active tab changed. Press Answer again.'));
  }
});
