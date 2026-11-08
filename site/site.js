fetch('/launch.json').then(response => response.ok ? response.json() : Promise.reject()).then(config => {
  if (/^https:\/\/chromewebstore\.google\.com\/detail\//.test(config.storeUrl || '')) {
    for (const link of document.querySelectorAll('[data-install]')) { link.href = config.storeUrl; link.hidden = false; }
    const status = document.getElementById('launchStatus');
    if (status) status.textContent = config.trialEnabled ? 'The free pilot is open. Try it before subscribing.' : 'The pilot is paused. Existing credits are preserved.';
  }
  if (/^(mailto:|https:\/\/)/.test(config.supportUrl || '')) for (const link of document.querySelectorAll('[data-support]')) link.href = config.supportUrl;
}).catch(() => {});
