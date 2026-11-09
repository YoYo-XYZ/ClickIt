(() => {
  let captureQueue = Promise.resolve(), lastCapture = 0;

  async function capture(tabId, windowId, signal) {
    const task = captureQueue.then(async () => {
      const wait = 550 - (Date.now() - lastCapture);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      signal.throwIfAborted();
      const active = async () => (await chrome.tabs.query({ active: true, windowId }))[0]?.id === tabId;
      if (!await active()) throw new Error('The active tab changed. Press Answer again.');
      lastCapture = Date.now();
      const image = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      signal.throwIfAborted();
      if (!await active()) throw new Error('The active tab changed. Press Answer again.');
      return image;
    });
    captureQueue = task.then(() => {}, () => {});
    return task;
  }

  async function prepare(dataUrl) {
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), value => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
      const scale = Math.min(1, 1568 / bitmap.width, 1568 / bitmap.height);
      const drawnWidth = Math.round(bitmap.width * scale), drawnHeight = Math.round(bitmap.height * scale);
      const width = Math.max(280, drawnWidth), height = Math.max(280, drawnHeight);
      const left = Math.floor((width - drawnWidth) / 2), top = Math.floor((height - drawnHeight) / 2);
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, left, top, drawnWidth, drawnHeight);
      const encoded = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const chunks = [];
      for (let i = 0; i < encoded.length; i += 32768) chunks.push(String.fromCharCode(...encoded.subarray(i, i + 32768)));
      return { width, height,
        content: { left, top, width: drawnWidth, height: drawnHeight },
        data: btoa(chunks.join('')) };
    } finally { bitmap.close(); }
  }

  function region(image, box, viewport) {
    const { content, width, height } = image;
    if (box.left * width < content.left || box.right * width > content.left + content.width ||
      box.top * height < content.top || box.bottom * height > content.top + content.height) {
      throw new Error('The answer region is outside the captured page. No click made.');
    }
    return { x: (box.left * width - content.left) / content.width * viewport.width,
      y: (box.top * height - content.top) / content.height * viewport.height,
      width: (box.right - box.left) * width / content.width * viewport.width,
      height: (box.bottom - box.top) * height / content.height * viewport.height };
  }

  // Serialized into the isolated page context. No question extraction or API settings enter the page.
  function install() {
    globalThis.ClickItPage?.cancel();
    const selector = 'button,[role="button"],input[type="radio"],[role="radio"],label';
    let consumed = false, highlight, expiry;
    const dismissEvents = ['scroll', 'resize', 'pagehide', 'popstate', 'hashchange', 'pointerdown', 'keydown'];
    const dismiss = event => {
      if (event.type !== 'keydown' || event.key === 'Escape') cancel();
    };

    function check(point) {
      if (consumed) throw new Error('This answer was already handled. Press Answer again.');
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || hit.closest('[hidden],[aria-hidden="true"],[inert],[disabled],[aria-disabled="true"],nav,input:not([type="radio"]),[role="checkbox"]')) {
        throw new Error('No supported, enabled answer button at that position. No click made.');
      }
      let node = hit.closest(selector);
      if (node?.matches('label')) node = node.control;
      const answerNode = node || hit;
      const answer = (answerNode.innerText || answerNode.getAttribute('aria-label') || [...answerNode.labels || []].map(label => label.innerText).join(' ')).replace(/\s+/g, ' ').trim();
      if (!node) return null;
      if (node.matches('button[type="submit"],input[type="submit"]') || (node.form && node.type === 'submit')) {
        throw new Error('The target is a submission button. No click made.');
      }
      if (node.matches('input:not([type="radio"])') ||
        node.closest('[hidden],[aria-hidden="true"],[inert],[disabled],[aria-disabled="true"],nav') ||
        node.matches(':disabled') || node.querySelector('input[type="checkbox"],[role="checkbox"]')) {
        throw new Error('No supported, enabled answer button at that position. No click made.');
      }
      return { node, answer: answer || 'Visual answer' };
    }
    function cancel() {
      consumed = true;
      for (const event of dismissEvents) window.removeEventListener(event, dismiss, true);
      clearTimeout(expiry);
      highlight?.remove();
      delete globalThis.ClickItPage;
    }
    function suggest(point, rect) {
      highlight = document.createElement('div');
      highlight.setAttribute('data-clickit-highlight', '');
      highlight.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
      const shadow = highlight.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        * { box-sizing:border-box; pointer-events:none; }
        .area { position:absolute; border:3px solid #ffdf00; box-shadow:0 0 0 2px #111; }
        .marker { position:absolute; width:18px; height:18px; transform:translate(-50%,-50%); border:3px solid #ffdf00; border-radius:50%; box-shadow:0 0 0 2px #111; }
        .hint { position:absolute; max-width:calc(100vw - 16px); padding:6px 10px; background:#111; color:#fff; font:14px/20px Arial,sans-serif; border-radius:4px; }
      `;
      const area = document.createElement('div');
      area.className = 'area';
      area.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;`;
      const marker = document.createElement('div');
      marker.className = 'marker';
      marker.style.cssText = `left:${point.x}px;top:${point.y}px;`;
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.setAttribute('role', 'status');
      hint.textContent = 'Click the highlighted answer manually';
      hint.style.cssText = `left:${Math.max(8, Math.min(rect.x, innerWidth - 300))}px;top:${rect.y >= 44 ? rect.y - 40 : Math.min(innerHeight - 44, rect.y + rect.height + 8)}px;`;
      shadow.append(style, area, marker, hint);
      (document.fullscreenElement || document.documentElement).append(highlight);
      expiry = setTimeout(cancel, 8000);
      for (const event of dismissEvents) window.addEventListener(event, dismiss, true);
      return { suggested: true, answer: 'Highlighted area' };
    }
    globalThis.ClickItPage = {
      click(point, rect) {
        if (highlight) throw new Error('The answer was already suggested. Press Answer again.');
        const control = check(point);
        if (!control) return suggest(point, rect);
        const { node, answer } = control;
        const selected = node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true';
        this.cancel();
        if (!selected) node.click();
        return { clicked: !selected, answer };
      },
      cancel
    };
    return { width: innerWidth, height: innerHeight };
  }
  globalThis.ClickItVision = { capture, prepare, region, install };
})();
