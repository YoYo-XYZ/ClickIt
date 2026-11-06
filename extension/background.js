importScripts('core.js', 'vision.js');
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
  let target, suggested = false;
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
  const report = value => {
    if (jobs.get(tabId) !== job) return;
    const previous = statuses.get(tabId);
    statuses.set(tabId, { ...value, lastAction: value.answer ? value : previous?.lastAction });
    if (statuses.size > 64) statuses.delete(statuses.keys().next().value);
  };
  try {
    await clearSuggestion(tabId);
    report({ text: vision ? 'Capturing visible tab…' : 'Reading question…' });
    let snapshot;
    try {
      [snapshot] = await chrome.scripting.executeScript({ target: { tabId },
        ...(vision ? { func: V.install } : { files: ['content.js'] }) });
    } catch { throw new Error('Cannot access this page. Open a regular webpage and invoke ClickIt from its toolbar icon.'); }
    if (snapshot?.result?.error) throw new Error(snapshot.result.error);
    if (!snapshot?.result) throw new Error('No unambiguous single-choice text question found. This layout is unsupported.');
    target = { tabId, documentIds: [snapshot.documentId] };
    const q = vision ? await V.prepare(await V.capture(tabId, job.windowId, job.controller.signal)) : C.validateQuestion(snapshot.result);
    report({ text: 'Jev is choosing…' });
    const timeout = setTimeout(() => job.controller.abort(new Error('Request expired or was cancelled. Press Answer to retry.')), config.timeoutMs);
    let result;
    try { result = await decide(q, config, job.controller.signal); }
    finally { clearTimeout(timeout); }
    if (job.controller.signal.aborted) throw new Error('Request cancelled.');
    if (result.confidence < config.minConfidence) throw new Error(`Skipped: answer confidence ${Math.round(result.confidence * 100)}% is below your ${Math.round(config.minConfidence * 100)}% threshold.`);
    let clickTarget = result.index, targetRegion;
    if (vision) {
      clickTarget = V.point(q, result.boxes.target, snapshot.result);
      targetRegion = V.region(q, result.boxes.target, snapshot.result);
      const regions = [result.boxes.question, result.boxes.choices, result.boxes.target];
      await pageCall('watch', clickTarget, regions.map(box => V.region(q, box, snapshot.result)));
      job.controller.signal.throwIfAborted();
    }
    const action = await pageCall('click', clickTarget, targetRegion);
    if (action.suggested) job.controller.signal.throwIfAborted();
    suggested = action.suggested === true;
    if (suggested) suggestions.set(tabId, { target, windowId: job.windowId });
    report({ text: suggested ? 'Click the highlighted answer manually. No automatic click made.' :
      action.clicked ? 'Answer clicked. Submit it yourself if needed.' : 'Answer already selected. No click needed.',
      answer: vision ? action.answer : q.options[result.index], confidence: result.confidence, apiMs: result.apiMs, totalMs: Math.round(performance.now() - started) });
  } catch (error) {
    report({ text: job.controller.signal.aborted ? job.controller.signal.reason?.message || 'Request expired or was cancelled. Press Answer to retry.' :
      error instanceof TypeError ? `Cannot reach ${C.providers[config.provider].name}. Check your connection and press Answer.` : error.message });
  } finally {
    if (target && !suggested) await chrome.scripting.executeScript({ target, func: () => globalThis.ClickItPage?.cancel() }).catch(() => {});
    if (jobs.get(tabId) === job) jobs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Page scripts have no API or settings access. Only the extension popup can start a run.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  (async () => {
    await ready;
    if (message.type === 'inspect') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { settings, busy: jobs.has(tab?.id), status: statuses.get(tab?.id) || { text: 'Ready. Press Answer for this question.' } };
    }
    if (message.type === 'save') {
      if (jobs.size) throw new Error('Wait for the current answer before saving settings.');
      settings = C.validateSettings(message.settings);
      await chrome.storage.local.set({ settings });
      return { saved: true };
    }
    if (message.type === 'answer') {
      if (!settings.apiKey) throw new Error('Add your API key in Settings first.');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || (tab.url && !/^https?:\/\//.test(tab.url))) throw new Error('Open a regular webpage and invoke ClickIt from its toolbar icon.');
      if (jobs.has(tab.id)) throw new Error('Already answering this tab.');
      const job = { controller: new AbortController(), windowId: tab.windowId, vision: settings.mode === 'vision' };
      jobs.set(tab.id, job);
      void run(tab.id, job, settings);
      return { started: true };
    }
    throw new Error('Unknown request.');
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { jobs.get(tabId)?.controller.abort(); jobs.delete(tabId); statuses.delete(tabId); suggestions.delete(tabId); });
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  for (const [id, suggestion] of suggestions) if (suggestion.windowId === windowId && id !== tabId) void clearSuggestion(id);
  for (const [id, job] of jobs) if (job.vision && job.windowId === windowId && id !== tabId) {
    job.controller.abort(new Error('The active tab changed. Press Answer again.'));
  }
});
