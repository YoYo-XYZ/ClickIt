const $ = id => document.getElementById(id);
let loaded = false, sending = false, running = false;
let saved;
let hosted;
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
  for (const id of ['refreshBalance', 'buyCredits', 'restoreAccess']) $(id).disabled = !loaded || sending || running;
  $('startTrial').disabled = !loaded || sending || running || !hosted?.configured || !$('adultConsent').checked || !$('dataConsent').checked;
  $('buyCredits').disabled ||= !hosted?.balance?.checkoutEnabled;
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
  $('trialConsent').hidden = hosted.registered;
  $('refreshBalance').hidden = !hosted.registered;
  $('buyCredits').hidden = !hosted.registered;
  $('creditBalance').textContent = hosted.registered ? `${value?.credits ?? '…'} credits left` : '10 free suggestions';
  $('creditNote').textContent = hosted.registered ? (
    hosted.pending ? 'Credit sync pending. Refresh if your balance does not update.' :
    value?.reserved ? `${value.reserved} credit reserved for an active request.` :
    !value?.checkoutEnabled ? 'Purchases are not available yet. Your credits are preserved.' :
    value.credits <= 50 ? 'Running low. Top up with 500 credits for $4.99.' : 'One credit per valid suggestion. No automatic renewal.'
  ) : 'Then $4.99 for 500 credits. No subscription.';
  $('creditError').textContent = hosted.error || (!hosted.configured ? 'Hosted AI is not connected in this build. Advanced settings supports your own API key.' : '');
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
        else $(key).value = data.settings[key];
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
$('mode').addEventListener('change', async () => {
  sending = true; controls();
  try {
    const next = { ...saved, mode: selectedMode() };
    await send({ type: 'save', settings: next });
    saved = next;
    $('message').textContent = '';
  } catch (error) { selectMode(saved.mode); $('message').textContent = error.message; }
  finally { sending = false; controls(); }
  showPrompt();
});
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  sending = true; controls();
  try {
    const settings = ClickIt.validateSettings(Object.fromEntries(Object.keys(ClickIt.defaults).map(key => [key, key === 'mode' ? selectedMode() : $(key).value])));
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
    await send(message);
    $('message').textContent = message.type === 'restoreAccess' ? 'Credit access restored.' : '';
    await refresh();
    if (message.type === 'startTrial') $('hostedAccessKey').value = hosted.credential;
  } catch (error) { $('message').textContent = error.message; }
  finally { sending = false; controls(); }
}
$('startTrial').addEventListener('click', () => accountAction({ type: 'startTrial', adultConsent: $('adultConsent').checked, dataConsent: $('dataConsent').checked }));
$('refreshBalance').addEventListener('click', () => accountAction({ type: 'refreshBalance' }));
$('buyCredits').addEventListener('click', () => accountAction({ type: 'checkout' }));
$('restoreAccess').addEventListener('click', () => accountAction({ type: 'restoreAccess', credential: $('hostedAccessKey').value.trim() }));
$('showAccessKey').addEventListener('click', () => {
  const show = $('hostedAccessKey').type === 'password';
  $('hostedAccessKey').type = show ? 'text' : 'password';
  $('showAccessKey').textContent = show ? 'Hide key' : 'Show key';
});
if (ClickItConfig.publicUrl) {
  $('privacyLink').href = `${ClickItConfig.publicUrl}/privacy.html`;
  $('privacyLink').hidden = false;
}
$('supportLink').href = ClickItConfig.supportUrl;
void refresh(true);
setInterval(() => { if (!sending) void refresh(); }, 500);
