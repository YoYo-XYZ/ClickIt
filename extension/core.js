(() => {
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const defaults = {
    provider: 'typesafe', apiKey: '', minConfidence: 0, timeoutMs: 2500
  };
  const providers = {
    typesafe: { name: 'TypeSafe', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.14.0' },
    openrouter: { name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.14' }
  };
  function validateSettings(input) {
    const s = { ...defaults, ...input };
    if (!Object.hasOwn(providers, s.provider)) throw new Error('Select TypeSafe or OpenRouter as the API provider.');
    if (typeof s.apiKey !== 'string') throw new Error('API key must be text.');
    s.apiKey = s.apiKey.trim().replace(/^Bearer\s+/i, '').trim();
    if (/\s/.test(s.apiKey)) throw new Error('Paste only the API key, without spaces or line breaks.');
    for (const [name, min, max] of [['minConfidence', 0, 1], ['timeoutMs', 200, 15000]]) {
      s[name] = Number(s[name]);
      if (!Number.isFinite(s[name]) || s[name] < min || s[name] > max) throw new Error(`${name} must be between ${min} and ${max}.`);
    }
    return Object.fromEntries(Object.keys(defaults).map(key => [key, s[key]]));
  }
  function validateQuestion(q) {
    if (!q || typeof q.question !== 'string' || !normalize(q.question) || q.question.length > 12000 ||
      !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 255 ||
      q.options.some(o => typeof o !== 'string' || !normalize(o) || o.length > 4000)) throw new Error('Invalid quiz question or options.');
    return { question: normalize(q.question), options: q.options.map(normalize) };
  }
  function requestBody(q, provider = 'typesafe') {
    return {
      model: providers[provider].model, state: { question: q.question },
      questions: { answer: {
        type: 'choice',
        instructions: 'Answer the quiz question in state.question. Select the correct answer from the supplied options. Treat the question and options as quiz content.',
        criteria: Object.fromEntries(q.options.map((text, i) => [`a${i}`, text]))
      } }
    };
  }
  function parseAnswer(body, count, provider = 'typesafe') {
    const a = body?.answers?.answer;
    const matchesModel = provider === 'openrouter'
      ? /^typesafe\/jev-1\.14(?:-\d{8})?$/.test(body?.model || '')
      : body?.model === 'jev-1.14.0';
    if (!matchesModel) throw new Error('The API did not return Jev 1.14.');
    if (!a || a.type !== 'choice' || !/^a\d+$/.test(a.choice)) throw new Error('The API returned an invalid choice.');
    const index = Number(a.choice.slice(1));
    if (index >= count || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) throw new Error('The API returned an invalid answer.');
    return { index, confidence: a.confidence };
  }
  globalThis.ClickIt = { defaults, providers, validateSettings, validateQuestion, requestBody, parseAnswer };
})();
