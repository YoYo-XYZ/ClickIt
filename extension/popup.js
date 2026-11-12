const $ = id => document.getElementById(id);
let loaded = false, sending = false, running = false;
let saved;
let hosted;
let upgradeQuote = null;
let modeSave = null;
function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}
function selectMode(value) {
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === value;
}
function selectedBillingMode() {
  return document.querySelector('input[name="billingMode"]:checked').value;
}
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'Extension unavailable.');
  return reply.data;
}
function controls() {
  const busy = !loaded || sending || running;
  for (const control of document.querySelectorAll('#answerNow, #mode, #settings button, #hostedPanel button, #restoreAccess, #subscriptionPlan')) control.disabled = busy;
  const label = running ? 'Answering…' : 'Answer';
  $('answerLabel').textContent = label;
  $('answerNow').setAttribute('aria-label', label);
  $('answerNow').setAttribute('aria-busy', String(running));
  $('startTrial').disabled ||= !hosted?.configured || !$('adultConsent').checked || !$('dataConsent').checked;
  $('buyCredits').disabled ||= !hosted?.balance?.checkoutEnabled;
  $('upgradePlan').disabled ||= !hosted?.balance?.checkoutEnabled;
  $('downgradePlan').disabled ||= !hosted?.balance?.checkoutEnabled;
  $('manageSubscription').disabled ||= !hosted?.balance?.billingManagementAvailable;
  $('confirmUpgrade').disabled ||= !upgradeQuote || Date.now() >= upgradeQuote.expiresAt;
}
async function withAction(action) {
  if (!loaded || sending || running) return false;
  sending = true;
  controls();
  $('message').textContent = '';
  try {
    await modeSave;
    await action();
    return true;
  } catch (error) {
    $('message').textContent = error.message;
    return false;
  } finally { sending = false; controls(); }
}
function showBilling() {
  const byok = selectedBillingMode() === 'byok';
  $('byokSettings').hidden = !byok;
  if (byok && (!$('apiKey').value.trim() || !$('byokConsent').checked)) $('byokSettings').open = true;
  $('hostedPanel').hidden = byok;
}
function showCredits() {
  if (!hosted) return;
  const value = hosted.balance;
  const sub = value?.subscription;
  const live = sub && !['canceled', 'incomplete_expired'].includes(sub.status);
  $('retryBilling').hidden = !hosted.billingOperationPending;
  $('trialConsent').hidden = hosted.registered && hosted.consented;
  $('startTrial').textContent = hosted.registered ? 'Accept and continue' : 'Start free trial';
  $('refreshBalance').hidden = !hosted.registered;
  $('subscribeOptions').hidden = !hosted.registered || live;
  $('subscriptionActions').hidden = !hosted.registered || (!live && !value?.billingManagementAvailable);
  $('upgradePlan').hidden = !live || sub.planId !== 'basic' || sub.status !== 'active' || sub.cancelAtPeriodEnd || sub.pendingUpgrade;
  $('downgradePlan').hidden = !live || sub.planId !== 'plus' || sub.status !== 'active' || sub.cancelAtPeriodEnd || sub.pendingUpgrade || Boolean(sub.scheduledPlan);
  $('keepPlan').hidden = !live || !sub.scheduledPlan;
  $('cancelSubscription').hidden = !live || sub.cancelAtPeriodEnd;
  $('resumeSubscription').hidden = !live || !sub.cancelAtPeriodEnd;
  $('creditBalance').textContent = hosted.registered ? `${value?.credits ?? '…'} credits left` : '10 free suggestions';
  $('creditBreakdown').hidden = !hosted.registered || value?.monthlyCredits === undefined;
  $('creditBreakdown').textContent = `${value?.monthlyCredits ?? 0} monthly credits · ${value?.otherCredits ?? 0} free / legacy credits`;
  const date = sub ? new Date(sub.periodEnd).toLocaleDateString() : '';
  const planName = sub?.planId === 'plus' ? 'Plus' : 'Basic';
  $('creditNote').textContent = hosted.registered ? (
    hosted.pending ? 'Credit sync pending. Refresh if your balance does not update.' :
    value?.reserved ? `${value.reserved} credit reserved for an active request.` :
    sub?.pendingUpgrade ? 'Upgrade awaiting payment. Open Manage subscription / payment to finish paying the invoice.' :
    sub?.paymentActionRequired ? 'Payment needs attention. No new monthly credits are granted until payment succeeds.' :
    live && sub.cancelAtPeriodEnd ? `${planName} ends ${date}. Monthly credits expire then. Automatic renewal is off.` :
    live && sub.scheduledPlan ? `${planName} renews on Basic ${date}. Current monthly credits expire then.` :
    live ? `${planName} renews ${date}. ${sub.allowance} credits per month, no rollover.${value.monthlyCredits === 0 ? ' Upgrade or wait for renewal; your own API key is also available.' : ''}` :
    !value?.checkoutEnabled ? 'Subscriptions are not available yet. Your credits are preserved.' :
    'Choose Basic or Plus. Renews monthly until canceled. Monthly credits do not roll over.'
  ) : 'Then Basic $4.99/month or Plus $9.99/month. No card required to try.';
  $('creditError').textContent = hosted.error || (value?.billingSyncError ? 'Billing sync needs attention. Refresh later or contact support.' : !hosted.configured ? 'Hosted AI is not connected in this build. Advanced settings supports your own API key.' : '');
}
function showPrompt() {
  const vision = selectedMode() === 'vision';
  $('textPrompt').hidden = vision;
  $('visionPrompt').hidden = !vision;
  $('promptLabel').textContent = vision ? 'Vision prompt' : 'Text prompt';
  $('promptLabel').htmlFor = vision ? 'visionPrompt' : 'textPrompt';
}
$('resetPrompt').addEventListener('click', () => {
  const key = `${selectedMode()}Prompt`;
  $(key).value = ClickIt.defaults[key];
});
function showSettings(open) {
  $('settingsPanel').hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
  if (open) void refreshShortcut();
}
async function refreshShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find(command => command.name === 'answer-question')?.shortcut;
    $('hotkeyValue').textContent = shortcut || 'Not assigned';
    $('answerShortcut').textContent = shortcut ? `${shortcut.replace(/\bCtrl\b/g, 'Cltr')} to Clickit` : 'Set an answer hotkey in Settings';
    $('hotkeyError').textContent = '';
  } catch {
    $('hotkeyValue').textContent = 'Unavailable';
    $('answerShortcut').textContent = 'Manage your answer hotkey in Settings';
    $('hotkeyError').textContent = 'Cannot read the shortcut. Open Chrome’s shortcut settings to check it.';
  }
}
$('changeShortcut').addEventListener('click', async () => {
  try { await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); }
  catch { $('hotkeyError').textContent = 'Open chrome://extensions/shortcuts to change or remove the hotkey.'; }
});
$('settingsToggle').addEventListener('click', () => showSettings($('settingsPanel').hidden));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('settingsPanel').hidden) {
    event.preventDefault();
    showSettings(false);
    $('settingsToggle').focus();
  }
});
async function refresh(initial = false) {
  try {
    const data = await send({ type: 'inspect', opened: initial });
    running = data.busy;
    hosted = data.hosted;
    showCredits();
    $('status').textContent = data.status.text;
    const action = data.status.lastAction;
    $('answer').textContent = action?.answer || 'No answer yet';
    $('timing').textContent = action ? `${action.totalMs} ms · ${action.apiMs} ms API` : '';
    if (initial) {
      saved = data.settings;
      for (const key of Object.keys(ClickIt.defaults)) {
        if (key === 'mode') selectMode(data.settings.mode);
        else if (key === 'billingMode') {
          for (const input of document.querySelectorAll('input[name="billingMode"]')) input.checked = input.value === data.settings.billingMode;
        }
        else if ($(key)?.type === 'checkbox') $(key).checked = data.settings[key];
        else if ($(key)) $(key).value = data.settings[key];
      }
      loaded = true;
      showPrompt();
      showBilling();
      $('hostedAccessKey').value = hosted?.credential || '';
    }
    controls();
  } catch (error) { $('message').textContent = error.message; }
}
$('provider').addEventListener('change', () => { $('byokConsent').checked = false; });
$('billingMode').addEventListener('change', showBilling);
async function saveMode() {
  while (selectedMode() !== saved.mode) {
    const mode = selectedMode();
    try {
      const next = { ...saved, mode };
      await send({ type: 'save', settings: next });
      saved = next;
      $('message').textContent = '';
    } catch (error) {
      if (selectedMode() !== mode) continue;
      selectMode(saved.mode);
      showPrompt();
      $('message').textContent = error.message;
      return;
    }
  }
}
$('mode').addEventListener('change', () => {
  showPrompt();
  if (!modeSave) modeSave = saveMode().finally(() => { modeSave = null; });
});
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  await withAction(async () => {
    const settings = ClickIt.validateSettings(Object.fromEntries(Object.keys(ClickIt.defaults).map(key => [key,
      key === 'mode' ? selectedMode() : key === 'billingMode' ? selectedBillingMode() : $(key)?.type === 'checkbox' ? $(key).checked : ($(key)?.value ?? saved[key])])));
    await send({ type: 'save', settings });
    saved = settings;
    $('apiKey').value = settings.apiKey;
    $('message').textContent = 'Saved.';
    showSettings(false);
    showBilling();
  });
});
$('answerNow').addEventListener('click', async () => {
  await withAction(async () => {
    try {
      await send({ type: 'answer' });
      await refresh();
    } catch (error) {
      if (error.message.includes('API key')) { showSettings(true); $('byokSettings').open = true; $('apiKey').focus(); }
      if (error.message.includes('free trial')) { showSettings(true); $('adultConsent').focus(); }
      if (error.message.includes('data sharing')) {
        if (saved.billingMode === 'byok') { showSettings(true); $('byokSettings').open = true; $('byokConsent').focus(); }
        else { showSettings(true); $('dataConsent').focus(); }
      }
      throw error;
    }
  });
});
for (const id of ['adultConsent', 'dataConsent']) $(id).addEventListener('change', controls);
function accountAction(message) {
  return withAction(async () => {
    await send(message);
    if (message.type === 'restoreAccess') $('message').textContent = 'Credit access restored.';
    await refresh();
    if (message.type === 'startTrial') $('hostedAccessKey').value = hosted.credential;
  });
}
$('startTrial').addEventListener('click', () => accountAction({ type: 'startTrial', adultConsent: $('adultConsent').checked, dataConsent: $('dataConsent').checked }));
$('refreshBalance').addEventListener('click', () => accountAction({ type: 'refreshBalance' }));
$('buyCredits').addEventListener('click', () => accountAction({ type: 'checkout', planId: $('subscriptionPlan').value }));
$('manageSubscription').addEventListener('click', () => accountAction({ type: 'billingPortal' }));
$('retryBilling').addEventListener('click', () => accountAction({ type: 'retryBilling' }));
for (const [id, action] of Object.entries({ downgradePlan: 'downgrade', keepPlan: 'keep_plan', cancelSubscription: 'cancel', resumeSubscription: 'resume' })) {
  $(id).addEventListener('click', () => accountAction({ type: 'changeSubscription', action }));
}
$('upgradePlan').addEventListener('click', () => withAction(async () => {
  upgradeQuote = await send({ type: 'previewUpgrade' });
  const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: upgradeQuote.currency }).format(upgradeQuote.amount / 100);
  $('upgradeQuoteText').textContent = `Pay ${price} now to upgrade. Add ${upgradeQuote.additionalCredits} credits until ${new Date(upgradeQuote.periodEnd * 1000).toLocaleDateString()}. Then Plus renews at $9.99/month. Quote valid for five minutes.`;
  $('upgradeQuote').hidden = false;
}));
$('confirmUpgrade').addEventListener('click', async () => {
  if (!upgradeQuote || Date.now() >= upgradeQuote.expiresAt) return;
  if (await accountAction({ type: 'changeSubscription', action: 'upgrade', quoteId: upgradeQuote.quoteId })) {
    $('upgradeQuote').hidden = true;
    upgradeQuote = null;
  }
});
$('dismissUpgrade').addEventListener('click', () => { $('upgradeQuote').hidden = true; upgradeQuote = null; });
$('restoreAccess').addEventListener('click', () => accountAction({ type: 'restoreAccess', credential: $('hostedAccessKey').value.trim() }));
$('showAccessKey').addEventListener('click', () => {
  const show = $('hostedAccessKey').type === 'password';
  $('hostedAccessKey').type = show ? 'text' : 'password';
  $('showAccessKey').textContent = show ? 'Hide key' : 'Show key';
});
if (ClickItConfig.apiUrl) {
  $('privacyLink').href = `${ClickItConfig.apiUrl}/privacy.html`;
  $('privacyLink').hidden = false;
}
$('supportLink').href = ClickItConfig.supportUrl;
void refresh(true);
void refreshShortcut();
setInterval(() => { if (!sending) void refresh(); }, 500);
