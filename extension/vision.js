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
      const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, left, top, drawnWidth, drawnHeight);
      const encoded = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const chunks = [];
      for (let i = 0; i < encoded.length; i += 32768) chunks.push(String.fromCharCode(...encoded.subarray(i, i + 32768)));
      return { width, height, sourceWidth: bitmap.width, sourceHeight: bitmap.height,
        content: { left, top, width: drawnWidth, height: drawnHeight },
        pixels: context.getImageData(0, 0, width, height).data, data: btoa(chunks.join('')) };
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
  function point(image, box, viewport) {
    const rect = region(image, box, viewport);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }

  function unchanged(original, fresh, regions) {
    if (original.sourceWidth !== fresh.sourceWidth || original.sourceHeight !== fresh.sourceHeight) return false;
    for (const box of regions) {
      const left = Math.max(0, Math.floor(box.left * original.width) - 1);
      const right = Math.min(original.width, Math.ceil(box.right * original.width) + 1);
      const top = Math.max(0, Math.floor(box.top * original.height) - 1);
      const bottom = Math.min(original.height, Math.ceil(box.bottom * original.height) + 1);
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const offset = (y * original.width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (Math.abs(original.pixels[offset + channel] - fresh.pixels[offset + channel]) > 24) return false;
        }
      }
    }
    return true;
  }

  // Serialized into the isolated page context. No question extraction or API settings enter the page.
  function install() {
    globalThis.ClickItPage?.cancel();
    const geometry = () => JSON.stringify([innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio,
      visualViewport?.scale, visualViewport?.offsetLeft, visualViewport?.offsetTop]);
    const original = geometry(), url = location.href;
    const selector = 'button,[role="button"],input[type="radio"],[role="radio"],label';
    const describe = node => {
      const rect = node.getBoundingClientRect();
      return JSON.stringify([rect.x, rect.y, rect.width, rect.height, node.textContent,
        node.getAttribute('aria-label'), node.getAttribute('aria-checked'), node.getAttribute('aria-pressed'), node.checked]);
    };
    const candidates = new Map([...document.querySelectorAll(selector)].map(node => [node, describe(node)]));
    let invalid = document.visibilityState !== 'visible';
    let regions, appearance, changed = [];
    const invalidate = () => { invalid = true; };
    const intersects = rect => regions.some(region => rect.left < region.x + region.width && rect.right > region.x &&
      rect.top < region.y + region.height && rect.bottom > region.y);
    const regionAppearance = () => JSON.stringify([...document.querySelectorAll('body,body *')].flatMap(node => {
      const rect = node.getBoundingClientRect();
      if (!intersects(rect)) return [];
      const style = getComputedStyle(node);
      return [[rect.x, rect.y, rect.width, rect.height,
        [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(''),
        style.display, style.visibility, style.opacity, style.color, style.backgroundColor,
        style.font, style.letterSpacing, style.transform, style.filter, style.border, style.boxShadow]];
    }));
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!node) continue;
        if (['data-question-id', 'data-slide-id'].includes(record.attributeName)) invalidate();
        // Styles and container attributes can update for unrelated widgets. Their actual
        // effect on the watched regions is checked visually, rather than rejecting every mutation.
        if (node.closest('style,script') || record.type === 'attributes') continue;
        const rect = node.getBoundingClientRect();
        if (regions ? intersects(rect) : changed.length >= 1000) invalidate();
        else if (!regions) changed.push(rect);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    const events = ['scroll', 'resize', 'pagehide', 'popstate', 'hashchange', 'pointerdown', 'keydown'];
    for (const event of events) window.addEventListener(event, invalidate, true);
    const visibility = () => { if (document.visibilityState !== 'visible') invalidate(); };
    document.addEventListener('visibilitychange', visibility);

    function check(point) {
      if (invalid || geometry() !== original || location.href !== url ||
        (appearance && regionAppearance() !== appearance)) throw new Error('The page or viewport changed. Press Answer again.');
      let node = document.elementFromPoint(point.x, point.y)?.closest(selector);
      if (node?.matches('label')) node = node.control;
      if (!node || !candidates.has(node) || node.matches('input:not([type="radio"])') ||
        node.closest('[hidden],[aria-hidden="true"],[inert],[disabled],[aria-disabled="true"],nav') ||
        node.matches(':disabled') || node.querySelector('input[type="checkbox"],[role="checkbox"]')) {
        throw new Error('No supported, enabled answer button at that position. No click made.');
      }
      if (describe(node) !== candidates.get(node)) throw new Error('The answer button changed. Press Answer again.');
      const answer = (node.innerText || node.getAttribute('aria-label') || [...node.labels || []].map(label => label.innerText).join(' ')).replace(/\s+/g, ' ').trim();
      if (/^(submit|send|vote|confirm|next|back|previous|join|continue|start|close|skip|menu|settings|save|cancel|reset)(\b|$)/i.test(answer)) {
        throw new Error('The target is a navigation or submission button. No click made.');
      }
      return { node, answer: answer || 'Visual answer' };
    }
    globalThis.ClickItPage = {
      watch(point, watchedRegions) {
        regions = watchedRegions;
        if (changed.some(intersects)) invalidate();
        changed = [];
        check(point);
        appearance = regionAppearance();
        return true;
      },
      click(point) {
        const { node, answer } = check(point);
        const selected = node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true';
        this.cancel();
        if (!selected) node.click();
        return { clicked: !selected, answer };
      },
      cancel() {
        invalid = true;
        observer.disconnect();
        for (const event of events) window.removeEventListener(event, invalidate, true);
        document.removeEventListener('visibilitychange', visibility);
        delete globalThis.ClickItPage;
      }
    };
    return { width: innerWidth, height: innerHeight };
  }
  globalThis.ClickItVision = { capture, prepare, region, point, unchanged, install };
})();
