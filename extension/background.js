importScripts('core.js');
const C = MentiJev;
const cache = new Map();
const jobs = new Map();
const statuses = new Map();
const manualGrants = new Map();
let settings;
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  settings = C.validateSettings((await chrome.storage.local.get('settings')).settings || {});
})();
function isParticipant(sender) {
  try { return Boolean(sender.tab) && ['https://menti.com', 'https://www.menti.com'].includes(new URL(sender.url).origin); }
  catch { return false; }
}
function isPopup(sender) {
  return sender.url === chrome.runtime.getURL('popup.html');
}
function cancel(tabId, requestId) {
  const job = jobs.get(tabId);
  if (job && (!requestId || job.id === requestId)) {
    job.controller.abort(); jobs.delete(tabId);
  }
}
async function decide(message, sender) {
  const grant = manualGrants.get(sender.tab.id);
  const manual = Boolean(message.manualId && grant?.id === message.manualId && grant.expiresAt > Date.now());
  if (manual) manualGrants.delete(sender.tab.id);
  if (!settings.enabled && !manual) throw new Error('Press Answer or turn on Autopilot.');
  const config = settings;
  const provider = C.providers[config.provider];
  if (!config.apiKey) throw new Error(`Add a ${provider.name} API key in the extension.`);
  const q = C.validateQuestion(message.quiz);
  const key = JSON.stringify([config.provider, q]);
  cancel(sender.tab.id);
  if (cache.has(key)) return { ...cache.get(key), cached: true, apiMs: 0 };
  const controller = new AbortController();
  const job = { id: message.requestId, controller };
  jobs.set(sender.tab.id, job);
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(C.requestBody(q, config.provider)), signal: controller.signal, credentials: 'omit'
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error(`${provider.name} rejected the API key (HTTP 401). Select the provider that issued your key, paste its key, and save settings.`);
      const descriptions = { 402: `${provider.name} credits or spending limit need attention`, 403: 'API access denied', 429: 'API rate limit reached', 529: 'Jev is temporarily overloaded' };
      throw new Error(`${descriptions[response.status] || 'Jev request failed'} (HTTP ${response.status}). Press Answer to retry.`);
    }
    const result = { ...C.parseAnswer(await response.json(), q.options.length, config.provider), apiMs: Math.round(performance.now() - started), cached: false };
    if (controller.signal.aborted) throw new Error('Request cancelled.');
    cache.set(key, result);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Request expired or was cancelled. Press Answer if the question is still open.');
    if (error instanceof TypeError) throw new Error(`Cannot reach ${provider.name}. Check your connection and press Answer.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    if (jobs.get(sender.tab.id) === job) jobs.delete(sender.tab.id);
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || (!isParticipant(sender) && !isPopup(sender))) return;
  (async () => {
    await ready;
    if (message.type === 'settings') return C.publicSettings(settings);
    if (message.type === 'decide' && isParticipant(sender)) return decide(message, sender);
    if (message.type === 'cancel' && isParticipant(sender)) { cancel(sender.tab.id, message.requestId); return {}; }
    if (message.type === 'status' && isParticipant(sender)) {
      statuses.set(sender.tab.id, { ...message.status, updatedAt: Date.now() });
      if (statuses.size > 64) statuses.delete(statuses.keys().next().value);
      return {};
    }
    if (message.type === 'inspect' && isPopup(sender)) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { settings, status: statuses.get(tab?.id) || { text: 'Open a Mentimeter participant tab.' } };
    }
    if (message.type === 'save' && isPopup(sender)) {
      const next = C.validateSettings(message.settings);
      for (const id of jobs.keys()) cancel(id);
      manualGrants.clear();
      cache.clear();
      settings = next;
      await chrome.storage.local.set({ settings });
      const tabs = await chrome.tabs.query({});
      await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'settingsChanged', settings: C.publicSettings(settings) })));
      return { saved: true };
    }
    if ((message.type === 'answer' || message.type === 'retry') && isPopup(sender)) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url || !['https://menti.com', 'https://www.menti.com'].includes(new URL(tab.url).origin)) throw new Error('Open your Mentimeter participant tab, then press Answer.');
      const manualId = crypto.randomUUID();
      manualGrants.set(tab.id, { id: manualId, expiresAt: Date.now() + 15000 });
      let reply;
      try { reply = await chrome.tabs.sendMessage(tab.id, { type: 'answer', manualId }); }
      catch { manualGrants.delete(tab.id); throw new Error('Refresh the Mentimeter tab, then press Answer.'); }
      if (!reply?.ok) { manualGrants.delete(tab.id); throw new Error(reply?.error || 'No readable question on this screen.'); }
      return { started: true };
    }
    throw new Error('Unknown request.');
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { cancel(tabId); statuses.delete(tabId); manualGrants.delete(tabId); });
