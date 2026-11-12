const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const output = path.resolve(__dirname, '../dist/store');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    for (const [name, title, detail] of [
      ['hosted-answer', 'One question. One click.', 'Get a selected answer or a highlight to click yourself. You stay in control of submission.'],
      ['hosted-subscription', 'Manage your monthly plan.', 'Check credits, change plans, and cancel renewal. Basic: US$4.99 / month for 500 credits. Plus: US$9.99 / month for 1,200 credits. Renews until canceled; monthly credits expire.'],
      ['hosted-settings', 'Control your setup.', 'Choose Text or Vision, manage your answer hotkey, and back up your credit access. Advanced settings also support your own TypeSafe or OpenRouter API key.']
    ]) {
      const source = path.resolve(__dirname, `../test-results/${name}.png`);
      if (!fs.existsSync(source)) throw new Error(`Run npm test first. Missing ${source}`);
      const data = fs.readFileSync(source).toString('base64');
      await page.setContent(`<!doctype html><html><head><style>body{margin:0;padding:64px;box-sizing:border-box;width:1280px;height:800px;background:#101815;color:#e9f0ed;font-family:system-ui}main{display:grid;grid-template-columns:1fr 390px;gap:90px;align-items:center;height:610px}h1{font-size:64px;line-height:1.05;letter-spacing:-2px;font-weight:600}p{font-size:22px;line-height:1.6;color:#afc0b5}strong{font-size:26px;color:#a4e8c6}img{max-width:360px;max-height:610px;border-radius:16px;border:1px solid #354d40}footer{font-size:14px;color:#afc0b5;margin-top:24px}</style></head><body><main><section><strong>↗ Clickit</strong><h1>${title}</h1><p>${detail}</p><p>Single-choice questions on supported pages.<br>Suggestions can be wrong.</p></section><img src="data:image/png;base64,${data}" alt="Actual Clickit interface with sample data"></main><footer>Sample response · Interface captured in an automated test · No accuracy or compatibility claim</footer></body></html>`);
      await page.locator('img').evaluate(image => image.decode());
      await page.screenshot({ path: path.join(output, `${name}-1280x800.png`) });
    }
    console.log(`Created labeled draft store screenshots in ${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode=1; });
