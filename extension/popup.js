const $ = id => document.getElementById(id);
let loaded = false, sending = false, running = false;
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || 'Extension unavailable.');
  return reply.data;
}
function controls() {
  $('answerNow').disabled = !loaded || sending || running;
  $('answerNow').textContent = running ? 'Answering…' : 'Answer';
  $('saveSettings').disabled = !loaded || sending || running;
}
function showProvider() {
  $('keyLabel').textContent = `${ClickIt.providers[$('provider').value].name} API key`;
}
async function refresh(initial = false) {
  try {
    const data = await send({ type: 'inspect' });
    running = data.busy;
    $('status').textContent = data.status.text;
    const action = data.status.lastAction;
    $('answer').textContent = action?.answer || 'No answer yet';
    $('timing').textContent = action ? `${action.totalMs} ms · ${action.apiMs} ms API` : '';
    if (initial) {
      for (const key of Object.keys(ClickIt.defaults)) $(key).value = data.settings[key];
      loaded = true;
      showProvider();
    }
    controls();
  } catch (error) { $('message').textContent = error.message; }
}
$('provider').addEventListener('change', showProvider);
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  sending = true; controls();
  try {
    const settings = ClickIt.validateSettings(Object.fromEntries(Object.keys(ClickIt.defaults).map(key => [key, $(key).value])));
    await send({ type: 'save', settings });
    $('apiKey').value = settings.apiKey;
    $('message').textContent = 'Saved.';
    $('settingsPanel').open = false;
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
    if (error.message.includes('API key')) { $('settingsPanel').open = true; $('apiKey').focus(); }
  } finally { sending = false; controls(); }
});
void refresh(true);
setInterval(() => { if (!sending) void refresh(); }, 500);
