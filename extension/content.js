(() => {
  const C = MentiJev;
  let settings, timer, revision = 0, current = '', attempted = '', requestId, pending, waitingDecision, lastStatus = '', lastAction, manualTarget, manualId;
  const BAD_CONTROL = /^(submit|send|vote|next|back|previous|join|continue|start|ok|close|skip|menu|settings|help|accept|reject|save|retry|change answer|show results)(\b|$)/i;
  const visible = node => node && !node.closest('[hidden],[aria-hidden="true"],nav,header,footer,[role="dialog"]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => !node.disabled && !node.closest('[disabled],[aria-disabled="true"]');
  const text = node => C.normalize(node.innerText || node.textContent || node.getAttribute('aria-label'));
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'Extension unavailable. Refresh this tab.');
    return response.data;
  }
  function status(value) {
    if (value.totalMs !== undefined) lastAction = value;
    value = { ...value, lastAction };
    const signature = JSON.stringify(value);
    if (signature === lastStatus) return;
    lastStatus = signature;
    void send({ type: 'status', status: value }).catch(() => {});
  }
  function cancel() {
    revision++;
    pending = undefined;
    waitingDecision = undefined;
    manualTarget = undefined;
    manualId = undefined;
    if (requestId) void send({ type: 'cancel', requestId }).catch(() => {});
    requestId = undefined;
  }
  function readQuiz() {
    const root = document.querySelector('main,[role="main"]') || document.body;
    const questionNode = all(settings.questionSelector || '[data-testid="question-title"],[data-testid="question-text"],[data-testid="question-heading"],h1,h2,[role="heading"]', root)
      .find(n => visible(n) && text(n));
    if (!questionNode) return null;
    const question = text(questionNode);
    const explicit = settings.optionSelector || '[data-testid="answer-option"],[data-testid="quiz-answer-option"],[data-testid="choice-option"],[role="radio"],input[type="radio"]';
    let nodes = all(explicit, root).filter(visible);
    if (!nodes.length && !settings.optionSelector) {
      // Semantic fallback: a group of sibling answer buttons, excluding navigation.
      const buttons = all('button,[role="button"]', root).filter(n => visible(n) && !BAD_CONTROL.test(text(n)) && text(n));
      const groups = new Map();
      for (const n of buttons) {
        const group = n.closest('[role="radiogroup"],fieldset,[data-testid="answer-options"]') || n.parentElement;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(n);
      }
      nodes = [...groups.values()].filter(g => g.length >= 2 && g.length <= 255).sort((a, b) => b.length - a.length)[0] || [];
    }
    nodes = nodes.filter(n => !nodes.some(parent => parent !== n && parent.contains(n)));
    const options = nodes.map(n => n.matches('input') ? C.normalize(n.labels?.[0]?.innerText || n.getAttribute('aria-label') || n.value) : text(n));
    const input = all(settings.inputSelector || 'textarea,input[type="text"],input:not([type])', root)
      .find(n => visible(n) && enabled(n) && !/name|nickname|code|email|search/i.test(`${n.name} ${n.id} ${n.placeholder} ${n.getAttribute('aria-label') || ''}`));
    const kind = nodes.length >= 2 && options.every(Boolean) ? 'choice' : input ? 'text' : null;
    if (!kind) return null;
    const round = questionNode.closest('[data-question-id],[data-slide-id]');
    const identity = round?.getAttribute('data-question-id') || round?.getAttribute('data-slide-id') || '';
    const fingerprint = JSON.stringify([location.href, identity, kind, question, kind === 'choice' ? options : []]);
    return { question, options, nodes, input, root, kind, fingerprint };
  }
  function submitButton(root) {
    return all(settings.submitSelector || 'button,input[type="submit"],[role="button"]', root)
      .find(n => visible(n) && enabled(n) && (settings.submitSelector || /^(submit|send|vote|confirm)(\b|$)/i.test(text(n) || n.value)));
  }
  function finishPending(q) {
    if (!pending || pending.fingerprint !== q.fingerprint) return;
    const p = pending;
    const submit = submitButton(q.root);
    if (submit && !p.submitted) {
      p.submitted = true;
      submit.click();
      status({ ...p.status, text: 'Answer submitted', totalMs: Math.round(performance.now() - p.started) });
      pending = undefined;
    } else if (performance.now() - p.selectedAt > settings.timeoutMs) {
      pending = undefined;
    }
  }
  function act(q, result, started) {
    if (result.confidence < settings.minConfidence) {
      status({ text: 'Skipped: confidence below your threshold', confidence: result.confidence }); return;
    }
    if (q.kind === 'choice' && !enabled(q.nodes[result.index])) return false;
    const report = { text: 'Answer selected', question: q.question, answer: q.kind === 'choice' ? q.options[result.index] : result.answer,
      confidence: result.confidence, apiMs: result.apiMs, cached: result.cached, totalMs: Math.round(performance.now() - started) };
    pending = { fingerprint: q.fingerprint, started, selectedAt: performance.now(), status: report, submitted: false };
    if (q.kind === 'choice') {
      const option = q.nodes[result.index];
      if (option.getAttribute('aria-checked') !== 'true' && !option.checked) option.click();
    } else {
      const proto = q.input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(q.input, result.answer);
      q.input.dispatchEvent(new Event('input', { bubbles: true }));
      q.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    status(report);
    const fresh = readQuiz();
    if (fresh?.fingerprint === q.fingerprint) finishPending(fresh);
    return true;
  }
  async function scan() {
    if (!settings) return;
    if (!settings.enabled && !manualTarget) { if (current) cancel(); current = ''; attempted = ''; status({ text: 'Ready. Press Answer for this question.' }); return; }
    let q;
    try { q = readQuiz(); } catch (e) { status({ text: `Check your selectors: ${e.message}` }); return; }
    if (!q) {
      if (current) { cancel(); current = ''; attempted = ''; }
      status({ text: 'Waiting for a visible question and answer controls' }); return;
    }
    if (current !== q.fingerprint) {
      cancel(); current = q.fingerprint; attempted = '';
      if (!settings.enabled) { status({ text: 'Question changed. Press Answer for this question.' }); return; }
    }
    finishPending(q);
    if (waitingDecision && enabled(q.nodes[waitingDecision.result.index])) {
      const saved = waitingDecision;
      waitingDecision = undefined;
      act(q, saved.result, saved.started);
    }
    if (attempted === current) return;
    // Read disabled options to allow inference during a countdown; click only once enabled.
    const started = performance.now(), version = revision;
    attempted = current;
    const bankEntry = Object.entries(settings.answerBank).find(([key]) => C.normalize(key) === q.question);
    if (q.kind === 'text') {
      if (!bankEntry) { status({ text: 'Typed question needs an exact answer-bank entry', question: q.question }); return; }
      act(q, { answer: bankEntry[1], confidence: 1, apiMs: 0, cached: true }, started); return;
    }
    try {
      let result;
      const bankIndex = bankEntry ? q.options.findIndex(o => C.normalize(o) === C.normalize(bankEntry[1])) : -1;
      if (bankIndex >= 0) result = { index: bankIndex, confidence: 1, apiMs: 0, cached: true };
      else {
        requestId = crypto.randomUUID();
        status({ text: 'Jev is choosing', question: q.question });
        result = await send({ type: 'decide', requestId, manualId, quiz: { question: q.question, options: q.options } });
      }
      const fresh = readQuiz();
      if ((!settings.enabled && manualTarget !== q.fingerprint) || version !== revision || fresh?.fingerprint !== q.fingerprint) return;
      if (act(fresh, result, started) === false) {
        // An inference deadline does not expire an already completed decision.
        // The observer wakes scan as soon as answer controls unlock.
        waitingDecision = { result, started };
        status({ text: 'Answer ready; waiting for choices to unlock', question: q.question });
      }
    } catch (e) { if (version === revision) status({ text: e.message, question: q.question }); }
  }
  function schedule() {
    if (timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void scan(); }, settings?.settleMs ?? 8);
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'settingsChanged') { cancel(); settings = message.settings; attempted = ''; schedule(); }
    if (message.type === 'answer' || message.type === 'retry') {
      try {
        if (!settings) throw new Error('Still loading. Press Answer again in a moment.');
        const q = readQuiz();
        if (!q) throw new Error('No readable question on this screen.');
        cancel();
        current = q.fingerprint; attempted = ''; manualTarget = q.fingerprint; manualId = message.manualId;
        schedule();
        respond({ ok: true });
      } catch (e) { respond({ ok: false, error: e.message }); }
    }
  });
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['disabled', 'aria-disabled', 'aria-hidden', 'hidden', 'class', 'style', 'data-question-id', 'data-slide-id']
  });
  setInterval(schedule, 500);
  document.addEventListener('visibilitychange', schedule);
  void send({ type: 'settings' }).then(value => { settings = value; schedule(); }).catch(e => status({ text: e.message }));
})();
