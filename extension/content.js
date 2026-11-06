(() => {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const text = node => {
    const labelled = normalize(node.getAttribute('aria-labelledby')).split(' ').filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || '').join(' ');
    return normalize(labelled || node.getAttribute('aria-label') ||
      (node.matches('input') ? [...node.labels || []].map(label => label.innerText).join(' ') : node.innerText));
  };
  const visible = node => Boolean(node && !node.closest('[hidden],[aria-hidden="true"],[inert],nav,header,footer') &&
    node.getClientRects().length && getComputedStyle(node).visibility === 'visible');
  const enabled = node => !node.matches(':disabled') && !node.closest('[aria-disabled="true"],[disabled]');
  const controls = 'input[type="radio"],[role="radio"],button,[role="button"]';
  const headings = 'legend,h1,h2,h3,h4,h5,h6,[role="heading"]';
  const navigation = /^(submit|send|vote|confirm|next|back|previous|join|continue|start|ok|close|skip|menu|settings|help|accept|reject|save|retry|reset|cancel|change answer|show results)(\b|$)/i;

  function read() {
    const nodes = [...document.querySelectorAll(controls)].filter(node => visible(node) && text(node) &&
      !navigation.test(text(node)) && !node.closest('[role="checkbox"]') &&
      !node.querySelector('input[type="checkbox"],[role="checkbox"]'));
    // Keep the actual radio/button when an answer wrapper contains it.
    const options = nodes.filter(node => !nodes.some(child => child !== node && node.contains(child)));
    const groups = new Map();
    for (const node of options) {
      const radio = node.matches('input[type="radio"]');
      const root = node.closest('[role="radiogroup"],fieldset') ||
        (radio && node.name ? node.form || document.body : node.parentElement);
      if (!groups.has(root)) groups.set(root, new Map());
      const key = radio ? `radio:${node.name}` : 'choices';
      const named = groups.get(root);
      if (!named.has(key)) named.set(key, []);
      named.get(key).push(node);
    }
    const questions = [];
    let groupCount = 0;
    for (const [root, named] of groups) for (const group of named.values()) {
      if (group.length < 2 || group.length > 255) continue;
      groupCount++;
      let scope = root, questionNode;
      while (scope) {
        if (scope.matches('[aria-multiselectable="true"]') || scope.querySelector('input[type="checkbox"],[role="checkbox"]')) break;
        const labelled = normalize(scope.getAttribute('aria-labelledby')).split(' ').filter(Boolean)
          .map(id => document.getElementById(id)).filter(visible);
        const candidates = labelled.length ? labelled : [...scope.querySelectorAll(headings)]
          .filter(node => visible(node) && text(node) && !group.some(option => option.contains(node)));
        // Nested markers describing the same heading count as one question.
        const unique = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node)));
        if (unique.length === 1) { questionNode = unique[0]; break; }
        if (unique.length > 1) break;
        scope = scope.parentElement;
      }
      if (questionNode) {
        const round = questionNode.closest('[data-question-id],[data-slide-id]');
        questions.push({ question: text(questionNode), options: group.map(text), nodes: group, questionNode,
          round: [round?.getAttribute('data-question-id'), round?.getAttribute('data-slide-id')] });
      }
    }
    if (groupCount > 1 || questions.length !== 1) throw new Error(groupCount > 1
      ? 'Multiple question or answer groups found. Open one question at a time.'
      : 'No unambiguous single-choice text question found. This layout is unsupported.');
    const q = questions[0];
    if (new Set(q.options).size !== q.options.length) throw new Error('Answer labels are ambiguous. No click made.');
    if (!q.nodes.every(enabled)) throw new Error('Answer choices are disabled. Press Answer when they are ready.');
    return q;
  }

  globalThis.ClickItPage?.cancel();
  try {
    const original = read();
    const url = location.href;
    const identity = q => JSON.stringify([q.question, q.options, q.round]);
    let invalid = false, consumed = false;
    function unchanged() {
      try {
        const fresh = read();
        return location.href === url && identity(fresh) === identity(original) &&
          fresh.questionNode === original.questionNode && fresh.nodes.every((node, i) => node === original.nodes[i]);
      } catch { return false; }
    }
    const observer = new MutationObserver(() => { if (!unchanged()) invalid = true; });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    const invalidate = () => { invalid = true; };
    window.addEventListener('pagehide', invalidate, { once: true });
    globalThis.ClickItPage = {
      cancel() {
        consumed = true;
        observer.disconnect();
        window.removeEventListener('pagehide', invalidate);
        delete globalThis.ClickItPage;
      },
      click(index) {
        if (consumed || invalid || !unchanged()) throw new Error('The question or choices changed. Press Answer again.');
        const node = original.nodes[index];
        if (!node) throw new Error('Invalid answer. No click made.');
        const selected = node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true';
        this.cancel();
        if (selected) return { clicked: false };
        node.click();
        return { clicked: true };
      }
    };
    return { question: original.question, options: original.options };
  } catch (error) { return { error: error.message }; }
})();
