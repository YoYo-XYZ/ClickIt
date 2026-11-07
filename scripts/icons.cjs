const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const directory = path.resolve(__dirname, '../extension/icons');
    fs.mkdirSync(directory, { recursive: true });
    for (const size of [16,32,48,128]) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<html><body style="margin:0"><canvas width="${size}" height="${size}"></canvas></body></html>`);
      await page.evaluate(size => {
        const c = document.querySelector('canvas').getContext('2d');
        c.scale(size/128, size/128);
        c.fillStyle = '#15372e'; c.beginPath(); c.roundRect(0,0,128,128,28); c.fill();
        c.fillStyle = '#9becce'; c.beginPath(); c.moveTo(32,23); c.lineTo(105,69); c.lineTo(70,75); c.lineTo(53,108); c.closePath(); c.fill();
      }, size);
      await page.screenshot({ path: path.join(directory, `${size}.png`), omitBackground: true });
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode=1; });
