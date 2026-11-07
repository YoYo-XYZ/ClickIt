const fs = require('node:fs');
const filename = process.argv[2];
if (!filename) throw new Error('Usage: npm run report:validation -- <validation.json>');
const samples = JSON.parse(fs.readFileSync(filename, 'utf8'));
if (!Array.isArray(samples)) throw new Error('Expected a JSON array of observations.');
for (const sample of samples) {
  if (typeof sample.tester !== 'string' || !sample.tester || !['text','vision'].includes(sample.mode) ||
    typeof sample.correct !== 'boolean' || typeof sample.safe !== 'boolean' ||
    !Number.isFinite(sample.totalMs) || sample.totalMs < 0 || sample.realSession !== true) throw new Error('Each observation needs tester, mode, correct, safe, totalMs, realSession:true. Use pseudonyms and no quiz content.');
}
function summarize(values) {
  const times = values.map(s => s.totalMs).sort((a,b) => a-b);
  return { samples: values.length, testers: new Set(values.map(s => s.tester)).size,
    safeRate: values.filter(s => s.safe).length / (values.length || 1),
    accuracy: values.filter(s => s.correct).length / (values.length || 1),
    p95Ms: times.length ? times[Math.ceil(times.length * .95)-1] : null };
}
const overall = summarize(samples);
const modes = Object.fromEntries(['text','vision'].map(mode => [mode, summarize(samples.filter(s => s.mode === mode))]));
const passes = metric => metric.samples > 0 && metric.safeRate >= .95 && metric.accuracy >= .85 && metric.p95Ms < 5000;
const report = { overall, modes,
  sampleGatePassed: overall.samples >= 100 && overall.testers >= 5,
  textPassed: passes(modes.text), visionPassed: passes(modes.vision) };
console.log(JSON.stringify(report, null, 2));
if (!report.sampleGatePassed || !report.textPassed) process.exitCode = 1;
