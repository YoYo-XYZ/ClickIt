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
    let regions, appearance, highlight, expiry, monitor, changed = [];
    const invalidate = () => {
      invalid = true;
      if (highlight) cancel();
    };
    const intersects = rect => rect && rect.width > 0 && rect.height > 0 && regions.some(region => rect.left < region.x + region.width && rect.right > region.x &&
      rect.top < region.y + region.height && rect.bottom > region.y);
    const bounds = node => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element || element.closest('style,script')) return null;
      if (node.nodeType === Node.ELEMENT_NODE) return node.getBoundingClientRect();
      if (node.nodeType !== Node.TEXT_NODE) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    // Removed nodes have no layout by the time MutationObserver runs. Keep their
    // previous bounds so replacing a timer does not implicate its whole container.
    const rectangles = new WeakMap();
    const walk = (root, visit) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node = root;
      do {
        visit(node);
      } while ((node = walker.nextNode()));
    };
    const remember = node => {
      const rect = bounds(node);
      if (rect) rectangles.set(node, rect);
      return rect;
    };
    walk(document.documentElement, remember);
    const recordChange = rect => {
      if (!rect || !rect.width || !rect.height) return;
      if (regions ? intersects(rect) : changed.length >= 1000) invalidate();
      else if (!regions) changed.push(rect);
    };
    const regionAppearance = () => JSON.stringify([...document.querySelectorAll('body,body *')].flatMap(node => {
      if (node === highlight) return [];
      const rect = node.getBoundingClientRect();
      if (!intersects(rect)) return [];
      const style = getComputedStyle(node);
      return [[rect.x, rect.y, rect.width, rect.height,
        [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE && intersects(bounds(child))).map(child => child.textContent).join(''),
        style.display, style.visibility, style.opacity, style.color, style.backgroundColor,
        style.font, style.letterSpacing, style.transform, style.filter, style.border, style.boxShadow]];
    }));
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node === highlight)) continue;
        const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!node) continue;
        if (['data-question-id', 'data-slide-id'].includes(record.attributeName)) invalidate();
        // Styles and container attributes can update for unrelated widgets. Their actual
        // effect on the watched regions is checked visually, rather than rejecting every mutation.
        if (node.closest('style,script') || record.type === 'attributes') continue;
        if (record.type === 'childList') {
          for (const removed of record.removedNodes) walk(removed, child => recordChange(rectangles.get(child)));
          for (const added of record.addedNodes) {
            walk(added, child => recordChange(remember(child)));
          }
        } else {
          recordChange(rectangles.get(record.target));
          recordChange(bounds(record.target));
          remember(record.target);
        }
      }
      if (highlight && appearance !== regionAppearance()) invalidate();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    const events = ['scroll', 'resize', 'pagehide', 'popstate', 'hashchange', 'pointerdown', 'click', 'keydown'];
    for (const event of events) window.addEventListener(event, invalidate, true);
    const visibility = () => { if (document.visibilityState !== 'visible') invalidate(); };
    document.addEventListener('visibilitychange', visibility);

    function check(point) {
      if (invalid || geometry() !== original || location.href !== url ||
        (appearance && regionAppearance() !== appearance)) throw new Error('The page or viewport changed. Press Answer again.');
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || hit.closest('[hidden],[aria-hidden="true"],[inert],[disabled],[aria-disabled="true"],nav,input:not([type="radio"]),[role="checkbox"]')) {
        throw new Error('No supported, enabled answer button at that position. No click made.');
      }
      let node = hit.closest(selector);
      if (node?.matches('label')) node = node.control;
      const answerNode = node || hit;
      const answer = (answerNode.innerText || answerNode.getAttribute('aria-label') || [...answerNode.labels || []].map(label => label.innerText).join(' ')).replace(/\s+/g, ' ').trim();
      if (/^(submit|send|vote|confirm|next|back|previous|join|continue|start|close|skip|menu|settings|save|cancel|reset)(\b|$)/i.test(answer)) {
        throw new Error('The target is a navigation or submission button. No click made.');
      }
      if (!node) return null;
      if (!candidates.has(node)) throw new Error('The answer button changed. Press Answer again.');
      if (node.matches('input:not([type="radio"])') ||
        node.closest('[hidden],[aria-hidden="true"],[inert],[disabled],[aria-disabled="true"],nav') ||
        node.matches(':disabled') || node.querySelector('input[type="checkbox"],[role="checkbox"]')) {
        throw new Error('No supported, enabled answer button at that position. No click made.');
      }
      if (describe(node) !== candidates.get(node)) throw new Error('The answer button changed. Press Answer again.');
      return { node, answer: answer || 'Visual answer' };
    }
    function cancel() {
      invalid = true;
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, invalidate, true);
      document.removeEventListener('visibilitychange', visibility);
      clearTimeout(expiry);
      clearInterval(monitor);
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
      monitor = setInterval(() => {
        if (geometry() !== original || location.href !== url || appearance !== regionAppearance()) invalidate();
      }, 100);
      return { suggested: true, answer: 'Highlighted area' };
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
