// 실제 Gemini 로 사이트를 돌려 보는 개발용 스크립트 (사이트 코드를 그대로 브라우저에서 실행)
// 사용: GEMINI_API_KEY=... node tools/real-run.js <도면 이미지> [결과 폴더]
//   키가 없으면 Gemini 없이 미리보기(이미지 픽셀만)까지만 실행한다.
// 결과: <폴더>/result.png (최종 도면), preview.png (미리보기), plan.json, gemini.json (Gemini 원본 응답), log.txt
// 필요: playwright (npm i -g playwright 또는 PLAYWRIGHT_PATH 로 위치 지정)
const path = require('path'), fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const [img, outDir = 'real-run-out'] = process.argv.slice(2);
if (!img) { console.error('사용: GEMINI_API_KEY=... node tools/real-run.js <도면 이미지> [결과 폴더]'); process.exit(1); }
const KEY = process.env.GEMINI_API_KEY || '';
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => { const t = a.join(' '); console.log(t); fs.appendFileSync(path.join(outDir, 'log.txt'), t + '\n'); };

(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  p.on('pageerror', e => log('PAGEERR', e.message));
  p.on('console', m => m.type() === 'error' && log('CONSOLE', m.text()));
  // Gemini 원본 응답을 그대로 남긴다 (스트림 이벤트에서 결과 텍스트만 모음)
  p.on('response', async r => {
    if (!r.url().includes(':streamGenerateContent')) return;
    try {
      const body = await r.text(), text = body.split('\n').filter(l => l.startsWith('data:'))
        .map(l => { try { return JSON.parse(l.slice(5)); } catch (e) { return null; } })
        .flatMap(e => e?.candidates?.[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
      fs.writeFileSync(path.join(outDir, 'gemini.json'), text || body);
      log('Gemini HTTP', r.status(), '응답 길이', (text || body).length);
    } catch (e) { log('응답 저장 실패', e.message); }
  });
  await p.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await p.evaluate(k => { localStorage.clear(); if (k) localStorage.setItem('smartfloor-key', k); }, KEY);
  await p.reload(); await p.waitForTimeout(KEY ? 3000 : 300); // 키가 있으면 모델 목록 조회 대기
  log('모델:', await p.inputValue('#model'));
  await p.setInputFiles('#file', path.resolve(img));
  await p.waitForFunction(() => !document.querySelector('#preview').hidden);

  if (!KEY) { // Gemini 없이 미리보기만
    const t0 = Date.now();
    const plan = await p.evaluate(async () => { const px = wallMasks(await readPixels(image)); const pl = traceToPlan(autoExtent(px), px); show(pl); return pl; });
    log('미리보기만 (키 없음):', Date.now() - t0, 'ms · 벽 모양', plan.shapes.length, '· 크기', plan.width, 'x', plan.height);
    await p.locator('canvas').screenshot({ path: path.join(outDir, 'preview.png') });
    fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan));
    return b.close();
  }

  const t0 = Date.now(); let shot = false;
  await p.click('#gen');
  while (await p.isDisabled('#gen')) { // 진행 상황 기록 + 미리보기 캡처
    await p.waitForTimeout(1000);
    log(`${((Date.now() - t0) / 1000).toFixed(0)}s`, await p.textContent('#msg'));
    if (!shot && await p.isVisible('#c')) { await p.locator('canvas').screenshot({ path: path.join(outDir, 'preview.png') }); shot = true; }
    if (Date.now() - t0 > 900000) { log('15분 초과, 중단'); break; }
  }
  log('끝:', ((Date.now() - t0) / 1000).toFixed(1), '초 |', await p.textContent('#msg'));
  if (await p.isVisible('#c')) {
    await p.locator('canvas').screenshot({ path: path.join(outDir, 'result.png') });
    fs.writeFileSync(path.join(outDir, 'plan.json'), await p.evaluate(() => JSON.stringify(plan)));
  }
  await b.close();
})();
