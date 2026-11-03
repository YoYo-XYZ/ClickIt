const $ = id => document.getElementById(id);
let saved, busy = false;
function showProvider() {
  const provider = MentiJev.providers[$('provider').value];
  $('keyLabel').textContent = `${provider.name} API key`;
  $('providerHint').textContent = `Your key stays in this browser profile. Questions go to ${provider.name}.`;
}
function showControls() {
  $('autopilot').setAttribute('aria-pressed', String(Boolean(saved?.enabled)));
  $('autopilotState').textContent = saved?.enabled ? 'On' : 'Off';
  $('answerNow').disabled = !saved || busy;
  $('autopilot').disabled = !saved || busy;
}
function requireSetup() {
  if (!saved?.apiKey && !Object.keys(saved?.answerBank || {}).length) {
    $('settingsPanel').open = true;
    $('apiKey').focus();
    throw new Error('Add your API key in Settings and save it first.');
  }
}
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'Extension unavailable.');
  return reply.data;
}
function showStatus(s) {
  $('status').textContent = s.text;
  const action = s.lastAction || s;
  $('timing').textContent = action.totalMs === undefined ? '' : `${action.totalMs} ms · ${action.cached ? 'local answer' : `${action.apiMs} ms API`}`;
  $('answer').textContent = action.answer || 'No answer yet';
}
async function refresh(initial = false) {
  try {
    const data = await send({ type: 'inspect' });
    showStatus(data.status);
    if (initial) {
      saved = data.settings;
      for (const key of Object.keys(MentiJev.defaults)) {
        if (key === 'enabled') continue;
        $(key).value = key === 'answerBank' ? JSON.stringify(saved[key], null, 2) : saved[key];
      }
      showProvider();
    } else if (saved) saved.enabled = data.settings.enabled;
    showControls();
  } catch (e) { $('message').textContent = e.message; }
}
$('provider').addEventListener('change', showProvider);
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const next = { ...saved };
    for (const key of Object.keys(MentiJev.defaults)) {
      if (key === 'enabled') continue;
      next[key] = key === 'answerBank' ? JSON.parse($(key).value || '{}') : $(key).value;
      if (key.endsWith('Selector') && next[key]) document.querySelector(next[key]);
    }
    const clean = MentiJev.validateSettings(next);
    await send({ type: 'save', settings: clean });
    saved = clean;
    $('apiKey').value = clean.apiKey;
    $('message').textContent = 'Saved. Use Answer or Autopilot.';
    $('settingsPanel').open = false;
    showControls();
  } catch (e) { $('message').textContent = e.message; }
});
$('answerNow').addEventListener('click', async () => {
  busy = true; showControls();
  try {
    requireSetup();
    await send({ type: 'answer' });
    $('message').textContent = 'Answering this screen.';
    await refresh();
  } catch (e) { $('message').textContent = e.message; }
  finally { busy = false; showControls(); }
});
$('autopilot').addEventListener('click', async () => {
  busy = true; showControls();
  try {
    if (!saved.enabled) requireSetup();
    const next = { ...saved, enabled: !saved.enabled };
    await send({ type: 'save', settings: next });
    saved = next;
    $('message').textContent = next.enabled ? 'Autopilot is on. New questions will be answered automatically.' : 'Autopilot is off.';
  } catch (e) { $('message').textContent = e.message; }
  finally { busy = false; showControls(); }
});
void refresh(true);
setInterval(() => { if (!busy) void refresh(); }, 500);
