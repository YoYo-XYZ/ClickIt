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
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'Extension unavailable.');
  return reply.data;
}
function controls() {
  $('answerNow').disabled = !loaded || sending || running;
  const label = running ? 'Answering…' : 'Answer';
  $('answerLabel').textContent = label;
  $('answerNow').setAttribute('aria-label', label);
  $('answerNow').setAttribute('aria-busy', String(running));
  $('saveSettings').disabled = !loaded || sending || running;
  $('mode').disabled = !loaded || sending || running;
  $('resetPrompt').disabled = !loaded || sending || running;
  for (const id of ['refreshBalance', 'buyCredits', 'restoreAccess', 'subscriptionPlan', 'upgradePlan', 'downgradePlan', 'keepPlan', 'manageSubscription', 'cancelSubscription', 'resumeSubscription', 'confirmUpgrade', 'dismissUpgrade', 'retryBilling']) $(id).disabled = !loaded || sending || running;
  $('startTrial').disabled = !loaded || sending || running || !hosted?.configured || !$('adultConsent').checked || !$('dataConsent').checked;
  $('buyCredits').disabled ||= !hosted?.balance?.checkoutEnabled;
  $('upgradePlan').disabled ||= !hosted?.balance?.checkoutEnabled;
  $('downgradePlan').disabled ||= !hosted?.balance?.checkoutEnabled;
  $('manageSubscription').disabled ||= !hosted?.balance?.billingManagementAvailable;
  $('confirmUpgrade').disabled ||= !upgradeQuote || Date.now() >= upgradeQuote.expiresAt;
}
function showBilling() {
  const byok = $('billingMode').value === 'byok';
  $('byokSettings').hidden = !byok;
  $('promptSettings').hidden = !byok;
  $('hostedPanel').hidden = byok;
}
function showCredits() {
  if (!hosted) return;
  const value = hosted.balance;
  const sub = value?.subscription;
  const live = sub && !['canceled', 'incomplete_expired'].includes(sub.status);
  $('retryBilling').hidden = !hosted.billingOperationPending;
  $('trialConsent').hidden = hosted.registered;
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
  ) : '10 free suggestions, then Basic $4.99/month or Plus $9.99/month. No card required to try.';
  $('creditError').textContent = hosted.error || (value?.billingSyncError ? 'Billing sync needs attention. Refresh later or contact support.' : !hosted.configured ? 'Hosted AI is not connected in this build. Advanced settings supports your own API key.' : '');
}
function showProvider() {
  $('keyLabel').textContent = `${ClickIt.providers[$('provider').value].name} API key`;
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
}
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
    const data = await send({ type: 'inspect' });
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
        else if ($(key)) $(key).value = data.settings[key];
      }
      loaded = true;
      showProvider();
      showPrompt();
      showBilling();
      $('hostedAccessKey').value = hosted?.credential || '';
    }
    controls();
  } catch (error) { $('message').textContent = error.message; }
}
$('provider').addEventListener('change', showProvider);
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
  sending = true; controls();
  try {
    await modeSave;
    const settings = ClickIt.validateSettings(Object.fromEntries(Object.keys(ClickIt.defaults).map(key => [key, key === 'mode' ? selectedMode() : ($(key)?.value ?? saved[key])])));
    await send({ type: 'save', settings });
    saved = settings;
    $('apiKey').value = settings.apiKey;
    $('message').textContent = 'Saved.';
    showSettings(false);
    showBilling();
  } catch (error) { $('message').textContent = error.message; }
  finally { sending = false; controls(); }
});
$('answerNow').addEventListener('click', async () => {
  if (sending || running) return;
  sending = true; controls();
  $('message').textContent = '';
  try {
    await modeSave;
    await send({ type: 'answer' });
    await refresh();
  } catch (error) {
    $('message').textContent = error.message;
    if (error.message.includes('API key')) { showSettings(true); $('apiKey').focus(); }
  } finally { sending = false; controls(); }
});
for (const id of ['adultConsent', 'dataConsent']) $(id).addEventListener('change', controls);
async function accountAction(message) {
  if (sending || running) return;
  sending = true; controls();
  try {
    await modeSave;
    await send(message);
    $('message').textContent = message.type === 'restoreAccess' ? 'Credit access restored.' : '';
    await refresh();
    if (message.type === 'startTrial') $('hostedAccessKey').value = hosted.credential;
  } catch (error) { $('message').textContent = error.message; }
  finally { sending = false; controls(); }
}
$('startTrial').addEventListener('click', () => accountAction({ type: 'startTrial', adultConsent: $('adultConsent').checked, dataConsent: $('dataConsent').checked }));
$('refreshBalance').addEventListener('click', () => accountAction({ type: 'refreshBalance' }));
$('buyCredits').addEventListener('click', () => accountAction({ type: 'checkout', planId: $('subscriptionPlan').value }));
$('manageSubscription').addEventListener('click', () => accountAction({ type: 'billingPortal' }));
$('retryBilling').addEventListener('click', () => accountAction({ type: 'retryBilling' }));
for (const [id, action] of Object.entries({ downgradePlan: 'downgrade', keepPlan: 'keep_plan', cancelSubscription: 'cancel', resumeSubscription: 'resume' })) {
  $(id).addEventListener('click', () => accountAction({ type: 'changeSubscription', action }));
}
$('upgradePlan').addEventListener('click', async () => {
  if (sending || running) return;
  sending = true; controls();
  try {
    upgradeQuote = await send({ type: 'previewUpgrade' });
    const price = new Intl.NumberFormat(undefined, { style: 'currency', currency: upgradeQuote.currency }).format(upgradeQuote.amount / 100);
    $('upgradeQuoteText').textContent = `Pay ${price} now to upgrade. Add ${upgradeQuote.additionalCredits} credits until ${new Date(upgradeQuote.periodEnd * 1000).toLocaleDateString()}. Then Plus renews at $9.99/month plus applicable tax. Quote valid for five minutes.`;
    $('upgradeQuote').hidden = false;
  } catch (error) { $('message').textContent = error.message; }
  finally { sending = false; controls(); }
});
$('confirmUpgrade').addEventListener('click', async () => {
  if (!upgradeQuote || Date.now() >= upgradeQuote.expiresAt) return;
  await accountAction({ type: 'changeSubscription', action: 'upgrade', quoteId: upgradeQuote.quoteId });
  $('upgradeQuote').hidden = true; upgradeQuote = null;
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
setInterval(() => { if (!sending) void refresh(); }, 500);
