// 사이트를 브라우저에서 그대로 돌려 보는 개발용 스크립트
// 사용: node tools/real-run.js <도면 이미지> [결과 폴더] [가로 m]
//   "도면 생성" → base.png (화면 캔버스), plan.json, log.txt
// 필요: playwright (PLAYWRIGHT_PATH 로 위치 지정 가능)
const path = require('path'), fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const [img, outDir = 'real-run-out', widthM = ''] = process.argv.slice(2);
if (!img) { console.error('사용: node tools/real-run.js <도면 이미지> [결과 폴더] [가로 m]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => { const t = a.join(' '); console.log(t); fs.appendFileSync(path.join(outDir, 'log.txt'), t + '\n'); };

(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  p.on('pageerror', e => log('PAGEERR', e.message));
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await p.evaluate(() => localStorage.clear()); await p.reload();
  await p.setInputFiles('#file', path.resolve(img));
  await p.waitForFunction(() => !document.querySelector('#preview').hidden);
  if (widthM) await p.fill('[name=widthM]', String(widthM));

  const t0 = Date.now();
  await p.click('#gen'); await p.waitForFunction(() => !document.querySelector('#gen').disabled);
  log('도면 생성:', Date.now() - t0, 'ms |', await p.textContent('#msg'));
  const base = await p.evaluate(() => ({ plan, tone: pxCache && pxCache.px.tone }));
  log('  벽 색', JSON.stringify(base.tone), '· 벽 모양', base.plan.shapes.length, '· 선 벽', base.plan.walls.length,
    '· 문', base.plan.doors.length, '· 좌석', base.plan.seats.length, '· 크기', base.plan.width, 'x', base.plan.height, 'cm');
  await p.locator('canvas').screenshot({ path: path.join(outDir, 'base.png') });
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(base.plan));
  await b.close();
})();
