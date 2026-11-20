// 사이트를 브라우저에서 그대로 돌려 보는 개발용 스크립트
// 사용: [GEMINI_API_KEY=...] [OPENROUTER_API_KEY=...] node tools/real-run.js <도면 이미지> [결과 폴더] [가로 m]
//   1) "도면 생성" (AI 없이) → base.png
//   2) 키가 있으면 "AI로 다듬기" → ai.png, ai-response.json (AI 원본 응답)
// 결과 폴더에 plan.json, log.txt 도 남긴다. 필요: playwright (PLAYWRIGHT_PATH 로 위치 지정 가능)
const path = require('path'), fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const [img, outDir = 'real-run-out', widthM = ''] = process.argv.slice(2);
if (!img) { console.error('사용: node tools/real-run.js <도면 이미지> [결과 폴더] [가로 m]'); process.exit(1); }
const GKEY = process.env.GEMINI_API_KEY || '', ORKEY = process.env.OPENROUTER_API_KEY || '';
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => { const t = a.join(' '); console.log(t); fs.appendFileSync(path.join(outDir, 'log.txt'), t + '\n'); };

(async () => {
  // 컨테이너의 HTTPS 프록시가 있으면 브라우저도 그 프록시를 쓴다
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const b = await chromium.launch({ proxy }), p = await b.newPage({ viewport: { width: 1400, height: 950 } });
  p.on('pageerror', e => log('PAGEERR', e.message));
  p.on('response', async r => { // AI 원본 응답을 남긴다
    if (!/streamGenerateContent|chat\/completions/.test(r.url())) return;
    try { fs.writeFileSync(path.join(outDir, 'ai-response.json'), await r.text()); log('AI HTTP', r.status(), r.url().split('?')[0]); } catch (e) { /* 스트림 중단 */ }
  });
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await p.evaluate(([g, o]) => { localStorage.clear(); if (g) localStorage.setItem('smartfloor-key', g); if (o) localStorage.setItem('smartfloor-or-key', o); }, [GKEY, ORKEY]);
  await p.reload(); await p.waitForTimeout(GKEY || ORKEY ? 3000 : 300);
  await p.setInputFiles('#file', path.resolve(img));
  await p.waitForFunction(() => !document.querySelector('#preview').hidden);
  if (widthM) await p.fill('[name=widthM]', String(widthM));

  const t0 = Date.now();
  await p.click('#gen'); await p.waitForFunction(() => !document.querySelector('#gen').disabled);
  log('도면 생성 (AI 없이):', Date.now() - t0, 'ms |', await p.textContent('#msg'));
  const base = await p.evaluate(() => ({ plan, tone: pxCache && pxCache.px.tone }));
  log('  벽 색', JSON.stringify(base.tone), '· 벽 모양', base.plan.shapes.length, '· 선 벽', base.plan.walls.length, '· 크기', base.plan.width, 'x', base.plan.height, 'cm');
  await p.locator('canvas').screenshot({ path: path.join(outDir, 'base.png') });
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(base.plan));

  if (GKEY || ORKEY) {
    const t1 = Date.now();
    await p.evaluate(() => { document.querySelector('#ai').open = true; }); await p.click('#refine');
    while (await p.isDisabled('#refine')) {
      await p.waitForTimeout(2000); log(`  ${((Date.now() - t1) / 1000).toFixed(0)}s`, await p.textContent('#msg'));
      if (Date.now() - t1 > 900000) { log('15분 초과, 중단'); break; }
    }
    log('AI로 다듬기:', ((Date.now() - t1) / 1000).toFixed(1), '초 |', await p.textContent('#msg'));
    if (!(await p.isHidden('#notice'))) log('  안내:', await p.textContent('#notice-title'), '|', await p.textContent('#notice-wait'));
    await p.locator('canvas').screenshot({ path: path.join(outDir, 'ai.png') });
    fs.writeFileSync(path.join(outDir, 'plan.json'), await p.evaluate(() => JSON.stringify(plan)));
  }
  await b.close();
})();
