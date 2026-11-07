const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

test('public pages fit desktop/mobile, show only real install links, and sample quiz submits manually', async t => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let launched = false;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://clickit.example/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/launch.json') return route.fulfill({ json: {
      storeUrl: launched ? 'https://chromewebstore.google.com/detail/clickit/abcdefghijklmnop' : '', trialEnabled: launched,
      supportUrl: 'mailto:thammatorn.j@gmail.com'
    } });
    const file = path.resolve(__dirname, '../site', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const root = path.resolve(__dirname, '../site');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(file) });
  });
  for (const width of [360,1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['','privacy.html','terms.html','purchase.html','demo.html']) {
      await page.goto(`https://clickit.example/${name}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: ${name}`);
      assert.ok((await page.title()).includes('ClickIt'));
      if (!name) assert.equal(await page.locator('[data-install]').isHidden(), true);
    }
  }
  await page.locator('.answers button').nth(1).click();
  assert.equal(await page.locator('#result').textContent(), '');
  await page.locator('#submit').click();
  assert.equal(await page.locator('#result').textContent(), 'Correct. 2 + 2 = 4.');
  launched = true;
  await page.goto('https://clickit.example/');
  await page.locator('[data-install]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-install]').getAttribute('href'), 'https://chromewebstore.google.com/detail/clickit/abcdefghijklmnop');
  assert.deepEqual(errors, []);
  fs.mkdirSync(path.resolve(__dirname, '../test-results'), { recursive: true });
  await page.screenshot({ path: path.resolve(__dirname, '../test-results/landing.png'), fullPage: true });
});
