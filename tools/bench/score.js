// 채점: 사이트의 이미지 분석을 그대로 돌려 정답 벽 마스크와 비교 (문 자리도 벽)
// 사용: node tools/bench/score.js <케이스 폴더> [이름...]  (이름.png, 이름-gt.png, 이름.json — gen.py 가 만든다)
// 결과: 벽 정확도(그린 벽 중 진짜 벽)·벽 찾음(진짜 벽 중 그린 것), 이름-ov.png (정답=회색, 예측=빨강, 겹침=검정)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs'), path = require('path');
const dir = path.resolve(process.argv[2]), names = process.argv.slice(3).length ? process.argv.slice(3)
  : fs.readdirSync(dir).filter(f => /\.png$/.test(f) && !/-gt\.png$|-ov\.png$/.test(f)).map(f => f.slice(0, -4)).sort();
(async () => {
  const b = await chromium.launch(), p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('file://' + path.resolve(__dirname, '../../index.html'));
  const rows = [];
  for (const n of names) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8'));
    await p.evaluate(() => { image = null; document.querySelector('#preview').hidden = true; });
    await p.setInputFiles('#file', path.join(dir, n + '.png'));
    await p.waitForFunction(() => !document.querySelector('#preview').hidden);
    const t0 = Date.now();
    const r = await p.evaluate(async ([gtPath, meta]) => {
      const R = await readPixels(image), { W, H } = R, P = wallMasks(R);
      const plan = traceToPlan(autoExtent(P), P, meta.widthM || 0), { x0, y0, k } = plan.src;
      // 예측 벽 마스크 (원본 px)
      const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.setTransform(1 / k, 0, 0, 1 / k, x0, y0);
      g.fillStyle = g.strokeStyle = '#000'; g.lineCap = 'butt';
      plan.walls.forEach(w => { g.lineWidth = w[4] || plan.wallThickness; g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke(); });
      plan.shapes.forEach(sh => { const P2 = new Path2D(); sh.forEach(l => { l.forEach(([x, y], i) => i ? P2.lineTo(x, y) : P2.moveTo(x, y)); P2.closePath(); }); g.fill(P2, 'evenodd'); });
      const pd = g.getImageData(0, 0, W, H).data, pred = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) pred[i] = pd[4 * i] < 128 ? 1 : 0;
      // 정답 마스크
      const gi = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = gtPath; });
      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H; const g2 = c2.getContext('2d'); g2.drawImage(gi, 0, 0, W, H);
      const gd = g2.getImageData(0, 0, W, H).data, gt = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) gt[i] = gd[4 * i] < 128 ? 1 : 0;
      const gtD = morph(gt, W, H, 4, false), prD = morph(pred, W, H, 6, false);
      let np = 0, tp = 0, ng = 0, tg = 0;
      for (let i = 0; i < W * H; i++) { if (pred[i]) { np++; if (gtD[i]) tp++; } if (gt[i]) { ng++; if (prD[i]) tg++; } }
      // 겹쳐 보기: 정답=회색, 예측=빨강, 겹침=검정
      const ov = g2.createImageData(W, H);
      for (let i = 0; i < W * H; i++) { const a = gt[i], q = pred[i]; const col = a && q ? [0, 0, 0] : a ? [170, 170, 170] : q ? [230, 40, 40] : [255, 255, 255]; ov.data.set([...col, 255], 4 * i); }
      g2.putImageData(ov, 0, 0);
      return { prec: tp / Math.max(1, np), rec: tg / Math.max(1, ng), ov: c2.toDataURL('image/png') };
    }, ['data:image/png;base64,' + fs.readFileSync(path.join(dir, n + '-gt.png')).toString('base64'), meta]);
    fs.writeFileSync(path.join(dir, n + '-ov.png'), Buffer.from(r.ov.split(',')[1], 'base64'));
    const f1 = 2 * r.prec * r.rec / Math.max(1e-9, r.prec + r.rec);
    rows.push({ n, f1, ...r });
    console.log(`${n.padEnd(16)} 벽 정확 ${(r.prec * 100).toFixed(1).padStart(5)}%  벽 찾음 ${(r.rec * 100).toFixed(1).padStart(5)}%  F1 ${(f1 * 100).toFixed(1).padStart(5)}  (${Date.now() - t0}ms)`);
  }
  const avg = k => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  console.log(`평균              벽 정확 ${(avg('prec') * 100).toFixed(1)}%  벽 찾음 ${(avg('rec') * 100).toFixed(1)}%  F1 ${(avg('f1') * 100).toFixed(1)}`);
  await b.close();
})();
