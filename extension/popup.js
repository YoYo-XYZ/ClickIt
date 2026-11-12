const $ = id => document.getElementById(id);
let loaded = false, sending = false, running = false;
let saved;
let hosted;
let upgradeQuote = null;
let modeSave = null;
let settingsSave = Promise.resolve();
let focusAfterAction = null;
function setText(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
}
function notice(text, error = false) {
  setText('message', text);
  $('message').classList.toggle('error', error);
  $('message').setAttribute('role', error ? 'alert' : 'status');
  if (error) $('message').scrollIntoView({ block: 'nearest' });
}
function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}
function selectMode(value) {
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === value;
  for (const input of document.querySelectorAll('input[name="promptMode"]')) input.checked = input.value === value;
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
  for (const control of document.querySelectorAll('#answerNow, #accountEntry, #mode, #settings button, #settings input, #settings select, #settings textarea, #restoreAccess, #hostedAccessKey')) control.disabled = busy;
  const label = running ? 'Answering…' : 'Answer';
  $('answerLabel').textContent = label;
  $('answerNow').setAttribute('aria-label', label);
  $('answerNow').setAttribute('aria-busy', String(running));
  $('startTrial').disabled ||= !$('adultConsent').checked || !$('dataConsent').checked;
  const billingBlocked = Boolean(hosted?.billingOperationPending);
  $('buyCredits').disabled ||= !hosted?.balance?.checkoutEnabled || billingBlocked;
  $('upgradePlan').disabled ||= !hosted?.balance?.checkoutEnabled || billingBlocked;
  $('downgradePlan').disabled ||= !hosted?.balance?.checkoutEnabled || billingBlocked;
  for (const id of ['cancelSubscription', 'resumeSubscription', 'keepPlan']) $(id).disabled ||= billingBlocked;
  $('manageSubscription').disabled ||= !hosted?.balance?.billingManagementAvailable;
  $('confirmUpgrade').disabled ||= !upgradeQuote || billingBlocked;
  if (upgradeQuote) {
    const expired = Date.now() >= upgradeQuote.expiresAt;
    $('confirmUpgrade').textContent = expired ? 'Get a new quote' : upgradeQuote.confirmLabel;
  }
}
async function withAction(action) {
  if (!loaded || sending || running) return false;
  sending = true;
  controls();
  notice('');
  try {
    await modeSave;
    await action();
    return true;
  } catch (error) {
    notice(error.message, true);
    return false;
  } finally {
    sending = false;
    controls();
    focusAfterAction?.focus();
    focusAfterAction = null;
  }
}
function showBilling() {
  const byok = selectedBillingMode() === 'byok';
  $('byokSettings').hidden = !byok;
  $('hostedPanel').hidden = byok;
}
function showCredits() {
  if (!hosted) return;
  const value = hosted.balance;
  const sub = value?.subscription;
  const live = sub && !['canceled', 'incomplete_expired'].includes(sub.status);
  const paymentDue = Boolean(sub?.pendingUpgrade || sub?.paymentActionRequired);
  $('retryBilling').hidden = !hosted.billingOperationPending;
  $('trialConsent').hidden = hosted.registered && hosted.consented;
  $('startTrial').textContent = hosted.registered ? 'Accept and continue' : 'Try 15 free answers';
  $('subscribeOptions').hidden = !hosted.registered || !hosted.consented || !value || live;
  $('subscriptionActions').hidden = !$('upgradeQuote').hidden || !hosted.registered || (!live && !value?.billingManagementAvailable);
  $('upgradePlan').hidden = !live || sub.planId !== 'basic' || sub.status !== 'active' || sub.cancelAtPeriodEnd || paymentDue;
  $('downgradePlan').hidden = !live || sub.planId !== 'plus' || sub.status !== 'active' || sub.cancelAtPeriodEnd || paymentDue || Boolean(sub.scheduledPlan);
  $('keepPlan').hidden = !live || !sub.scheduledPlan;
  $('cancelSubscription').hidden = !live || sub.cancelAtPeriodEnd;
  $('resumeSubscription').hidden = !live || !sub.cancelAtPeriodEnd;
  $('creditBalance').textContent = hosted.registered ? value ? `${value.credits} credits left` : 'Balance unavailable' : '15 free answers';
  const date = sub ? new Date(sub.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const planName = sub?.planId === 'plus' ? 'Plus' : 'Basic';
  $('creditNote').textContent = hosted.registered ? (
    hosted.pending ? 'Credits are syncing. Reopen the popup to check again.' :
    value?.reserved ? `${value.reserved} credit reserved for an active request.` :
    sub?.pendingUpgrade ? 'Upgrade awaiting payment. Finish payment on Stripe to receive the extra credits.' :
    sub?.paymentActionRequired ? 'Payment needs attention. Update your payment on Stripe to receive monthly credits.' :
    live && sub.cancelAtPeriodEnd ? `Automatic renewal is off. ${planName} and remaining monthly credits end ${date}.` :
    live && sub.scheduledPlan ? `${planName} renews on Basic for $4.99/month on ${date}. Current monthly credits expire then.` :
    live ? `${planName} · US$${sub.planId === 'plus' ? '9.99' : '4.99'}/month. Renews ${date}. ${value.monthlyCredits === 0 ? 'Your monthly credits refill then.' : 'Unused monthly credits expire then.'}` :
    !value ? 'Reopen the popup to check your credits and plan.' :
    !value.checkoutEnabled ? 'Subscriptions are currently unavailable. Your credits are preserved.' :
    value.credits === 0 ? 'Choose a plan to continue.' : ''
  ) : 'No card required. No automatic subscription.';
  $('creditNote').classList.toggle('attention', paymentDue);
  $('manageSubscription').textContent = paymentDue ? 'Resolve payment on Stripe' : 'Manage billing';
  $('manageSubscription').classList.toggle('primary', paymentDue);
  setText('creditError', hosted.error || (value?.billingSyncError ? 'Billing could not sync. Reopen the popup or contact support.' : ''));
  const ownKey = saved?.billingMode === 'byok';
  $('accountSummary').textContent = ownKey ? 'Using your API key' : $('creditBalance').textContent;
  $('accountAction').textContent = ownKey ? 'Settings →' : !hosted.registered || !hosted.consented ? 'Get started →' : paymentDue ? 'Fix payment →' : live ? 'Manage plan →' : 'View plans →';
}
function showPrompt() {
  $('modeHint').textContent = selectedMode() === 'vision' ? 'Uses a screenshot of the visible tab.' : 'Reads the question and choices on this page.';
  const vision = document.querySelector('input[name="promptMode"]:checked').value === 'vision';
  $('textPrompt').hidden = vision;
  $('visionPrompt').hidden = !vision;
  $('promptLabel').textContent = vision ? 'Vision prompt' : 'Text prompt';
  $('promptLabel').htmlFor = vision ? 'visionPrompt' : 'textPrompt';
}
$('resetPrompt').addEventListener('click', () => {
  const key = `${document.querySelector('input[name="promptMode"]:checked').value}Prompt`;
  $(key).value = ClickIt.defaults[key];
  void saveSettings();
});
function showSettings(open) {
  $('settingsPanel').hidden = !open;
  $('settingsToggle').setAttribute('aria-expanded', String(open));
  $('settingsToggle').setAttribute('aria-label', open ? 'Close settings' : 'Settings');
  $('settingsToggle').title = open ? 'Close settings' : 'Settings';
  $('viewTitle').textContent = open ? 'Settings' : 'Clickit';
  window.scrollTo(0, 0);
  if (open) void refreshShortcut();
  else $('settingsToggle').focus();
}
async function refreshShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find(command => command.name === 'answer-question')?.shortcut;
    $('hotkeyValue').textContent = shortcut || 'Not assigned';
    $('answerShortcut').textContent = shortcut || '';
    $('hotkeyError').textContent = '';
  } catch {
    $('hotkeyValue').textContent = 'Unavailable';
    $('answerShortcut').textContent = '';
    $('hotkeyError').textContent = 'Cannot read the shortcut. Open Chrome’s shortcut settings to check it.';
  }
}
$('changeShortcut').addEventListener('click', async () => {
  try { await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); }
  catch { $('hotkeyError').textContent = 'Open chrome://extensions/shortcuts to change or remove the hotkey.'; }
});
$('settingsToggle').addEventListener('click', () => showSettings($('settingsPanel').hidden));
$('accountEntry').addEventListener('click', () => {
  showSettings(true);
  document.querySelector('input[name="billingMode"]:checked').focus();
});
$('promptMode').addEventListener('change', showPrompt);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('settingsPanel').hidden) {
    event.preventDefault();
    showSettings(false);
  }
});
async function refresh(initial = false) {
  try {
    const data = await send({ type: 'inspect', opened: initial });
    running = data.busy;
    hosted = data.hosted;
    $('status').closest('.status').dataset.kind = data.status.kind || '';
    $('status').setAttribute('role', data.status.kind === 'error' ? 'alert' : 'status');
    setText('status', data.status.text);
    const action = data.status.lastAction;
    $('timing').textContent = action ? `${(action.totalMs / 1000).toFixed(1)} s` : '';
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
    showCredits();
    controls();
  } catch (error) { notice(error.message, true); }
}
$('provider').addEventListener('change', () => { $('byokConsent').checked = false; });
$('billingMode').addEventListener('change', showBilling);
async function saveMode() {
  await settingsSave;
  while (selectedMode() !== saved.mode) {
    const mode = selectedMode();
    try {
      const next = { ...saved, mode };
      await send({ type: 'save', settings: next });
      saved = next;
      notice('');
    } catch (error) {
      if (selectedMode() !== mode) continue;
      selectMode(saved.mode);
      showPrompt();
      notice(error.message, true);
      return;
    }
  }
}
$('mode').addEventListener('change', () => {
  for (const input of document.querySelectorAll('input[name="promptMode"]')) input.checked = input.value === selectedMode();
  showPrompt();
  if (!modeSave) modeSave = saveMode().finally(() => { modeSave = null; });
});
function saveSettings() {
  if (!loaded) return settingsSave;
  const values = Object.fromEntries(Object.keys(ClickIt.defaults).map(key => [key,
    key === 'mode' ? selectedMode() : key === 'billingMode' ? selectedBillingMode() : $(key)?.type === 'checkbox' ? $(key).checked : ($(key)?.value ?? saved[key])]));
  const pendingMode = modeSave;
  settingsSave = settingsSave.then(async () => {
    await pendingMode;
    const settings = ClickIt.validateSettings({ ...values, mode: saved.mode });
    await send({ type: 'save', settings });
    saved = settings;
    notice('');
    showBilling();
    showCredits();
  }).catch(error => notice(error.message, true));
  return settingsSave;
}
$('settings').addEventListener('change', event => {
  if (Object.hasOwn(ClickIt.defaults, event.target.id) || event.target.name === 'billingMode') void saveSettings();
});
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  void saveSettings();
});
$('answerNow').addEventListener('click', async () => {
  await withAction(async () => {
    try {
      await send({ type: 'answer' });
      await refresh();
    } catch (error) {
      if (error.message.includes('API key')) { showSettings(true); focusAfterAction = $('apiKey'); }
      if (error.message.includes('free trial')) { showSettings(true); focusAfterAction = $('adultConsent'); }
      if (error.message.includes('data sharing')) {
        if (saved.billingMode === 'byok') { showSettings(true); focusAfterAction = $('byokConsent'); }
        else { showSettings(true); focusAfterAction = $('dataConsent'); }
      }
      throw error;
    }
  });
});
for (const id of ['adultConsent', 'dataConsent']) $(id).addEventListener('change', controls);
function accountAction(message) {
  return withAction(async () => {
    notice(message.type === 'checkout' ? 'Opening secure checkout…' : message.type === 'billingPortal' ? 'Opening Stripe billing…' : '');
    await send(message);
    if (message.type === 'startTrial' && saved.billingMode !== 'hosted') {
      const next = { ...saved, billingMode: 'hosted' };
      await send({ type: 'save', settings: next });
      saved = next;
    }
    if (message.type === 'restoreAccess') $('message').textContent = 'Credit access restored.';
    await refresh();
    if (message.type === 'startTrial' || message.type === 'restoreAccess') {
      $('hostedAccessKey').value = hosted.credential;
      $('hostedAccessKey').type = 'password';
      $('showAccessKey').textContent = 'Show key';
      $('showAccessKey').setAttribute('aria-pressed', 'false');
    }
    if (message.type === 'startTrial') showSettings(false);
    if (message.type === 'retryBilling') { $('upgradeQuote').hidden = true; upgradeQuote = null; showCredits(); }
    const notices = { checkout: 'Checkout opened on Stripe. Return here after payment.', billingPortal: 'Billing opened on Stripe. Return here when finished.' };
    if (notices[message.type]) notice(notices[message.type]);
  });
}
$('startTrial').addEventListener('click', () => accountAction({ type: 'startTrial', adultConsent: $('adultConsent').checked, dataConsent: $('dataConsent').checked }));
$('buyCredits').addEventListener('click', () => accountAction({ type: 'checkout', planId: $('subscriptionPlan').value }));
$('manageSubscription').addEventListener('click', () => accountAction({ type: 'billingPortal' }));
$('retryBilling').addEventListener('click', () => accountAction({ type: 'retryBilling' }));
for (const [id, action] of Object.entries({ downgradePlan: 'downgrade', keepPlan: 'keep_plan', cancelSubscription: 'cancel', resumeSubscription: 'resume' })) {
  $(id).addEventListener('click', () => accountAction({ type: 'changeSubscription', action }));
}
async function previewUpgrade() {
  upgradeQuote = await send({ type: 'previewUpgrade' });
  const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: upgradeQuote.currency }).format(upgradeQuote.amount / 100);
  upgradeQuote.confirmLabel = `Pay ${price} and upgrade`;
  $('upgradeQuoteText').textContent = `${price} due now\n+${upgradeQuote.additionalCredits} credits until ${new Date(upgradeQuote.periodEnd * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}\nThen US$9.99/month at renewal. Quote valid for five minutes.`;
  $('upgradeQuote').hidden = false;
  showCredits();
  focusAfterAction = $('confirmUpgrade');
}
$('upgradePlan').addEventListener('click', () => withAction(previewUpgrade));
$('confirmUpgrade').addEventListener('click', async () => {
  if (!upgradeQuote) return;
  if (Date.now() >= upgradeQuote.expiresAt) { await withAction(previewUpgrade); return; }
  if (await accountAction({ type: 'changeSubscription', action: 'upgrade', quoteId: upgradeQuote.quoteId })) {
    $('upgradeQuote').hidden = true;
    upgradeQuote = null;
    showCredits();
    $('manageSubscription').focus();
  }
});
$('dismissUpgrade').addEventListener('click', () => { $('upgradeQuote').hidden = true; upgradeQuote = null; showCredits(); $('upgradePlan').focus(); });
$('restoreAccess').addEventListener('click', () => accountAction({ type: 'restoreAccess', credential: $('hostedAccessKey').value.trim() }));
$('showAccessKey').addEventListener('click', () => {
  const show = $('hostedAccessKey').type === 'password';
  $('hostedAccessKey').type = show ? 'text' : 'password';
  $('showAccessKey').textContent = show ? 'Hide key' : 'Show key';
  $('showAccessKey').setAttribute('aria-pressed', String(show));
});
$('privacyLink').href = `${ClickItConfig.apiUrl}/privacy.html`;
$('privacyLink').hidden = false;
$('termsLink').href = `${ClickItConfig.apiUrl}/terms.html`;
$('termsLink').hidden = false;
$('supportLink').href = ClickItConfig.supportUrl;
void refresh(true);
void refreshShortcut();
setInterval(() => { if (!sending) void refresh(); }, 500);
