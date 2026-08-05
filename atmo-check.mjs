// THROWAWAY driver. Delete after use.
import { chromium } from 'playwright';

const url = 'http://127.0.0.1:5173/atmo-check.html';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader',
         '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__atmoDone === true, null, { timeout: 60000 });
} catch {
  logs.push('TIMEOUT waiting for __atmoDone');
}
const report = await page.evaluate(() => window.__atmo ?? null);
for (const n of ['atmosphere-limb', 'atmosphere-sunset']) {
  for (const [g, d, tag] of [[true, true, ''], [false, true, '-nog'], [true, false, '-nodepth']]) {
    await page.evaluate(([s, gg, dd]) => window.__shot(s, gg, dd), [n, g, d]);
    await page.screenshot({ path: `/tmp/atmo-${n}${tag}.png` });
  }
}
console.log(JSON.stringify({ report, logs: logs.slice(0, 30) }, null, 2));
await browser.close();
