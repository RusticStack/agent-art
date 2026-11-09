// Pixel diff of two screenshot folders (same file names): node scripts/shots-diff.mjs <dirA> <dirB> [maxRatio=0.001]
// A pixel differs when any channel differs by more than 8. Exit 1 when a file is missing or over the ratio.
import fs from 'node:fs';
import path from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= 'C:\\dev-overflow\\playwright';
const { chromium } = await import('@playwright/test');

const [a, b, maxArg] = process.argv.slice(2);
if (!a || !b) { console.error('usage: shots-diff <dirA> <dirB> [maxRatio]'); process.exit(2); }
const max = Number(maxArg ?? 0.001);
const files = fs.readdirSync(a).filter((f) => f.endsWith('.png'));
const browser = await chromium.launch();
const page = await browser.newPage();
let bad = 0;
for (const f of files) {
  const pb = path.join(b, f);
  if (!fs.existsSync(pb)) { console.log(`${f}: missing in ${b}`); bad++; continue; }
  const uri = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  const r = await page.evaluate(async ([ua, ub]) => {
    const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
    const [ia, ib] = await Promise.all([load(ua), load(ub)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const px = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
    const da = px(ia), db = px(ib);
    let n = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) > 8 || Math.abs(da[i + 1] - db[i + 1]) > 8 || Math.abs(da[i + 2] - db[i + 2]) > 8 || Math.abs(da[i + 3] - db[i + 3]) > 8) n++;
    return { n, total: da.length / 4 };
  }, [uri(path.join(a, f)), uri(pb)]);
  if (r.size) { console.log(`${f}: size differs (${r.size})`); bad++; continue; }
  const ratio = r.n / r.total;
  const ok = ratio <= max;
  if (!ok) bad++;
  console.log(`${f}: ${r.n} px differ (${(ratio * 100).toFixed(4)} %) ${ok ? 'ok' : 'OVER'}`);
}
await browser.close();
process.exit(bad ? 1 : 0);
