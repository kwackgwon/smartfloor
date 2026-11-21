// SmartFloor 이미지 분석: 도면 이미지의 픽셀만으로 벽 도면을 만든다 (AI 없이 동작, 무료·한도 없음)
// 결과 plan (단위 cm): { width, height, wallThickness,
//   walls: [[x1,y1,x2,y2,두께?]]          선으로 된 벽 (두께가 없으면 wallThickness)
//   shapes: [[고리, 고리, ...]] }           칠해진 벽 모양. 고리 = [[x,y],...], 구멍 포함 evenodd 로 채운다
//
// 벽 모양은 업로드한 도면 이미지의 벽 픽셀을 그대로 다각형으로 옮긴다 (벽 색은 도면에서 자동으로 고른다).
// AI(Gemini·OpenRouter)를 쓰면 건물 영역·벽 위치(0~1000 정규화 좌표)·치수를 받아 글자·표제란을 더 잘 걸러 내고
// 얇은 칸막이를 메운다 (traceToPlan 의 w). AI 없이는 autoExtent 가 건물 영역을 추정한다.
// ── 이미지 픽셀 분석 ──
// 읽으면서 고르게 맞춘다: ① 긴 변이 1600px 보다 작으면 키운다 (벽이 몇 px 밖에 안 되면 얇은 선 지우기에 벽까지 지워진다)
// ② 배경(가장 흔한 밝기)이 어두우면 반전, ③ 배경이 회색·잡음이 있거나 대비가 낮으면 배경 → 흰색, 가장 진한 선 → 검정으로 늘린다
// photo: 배경색 픽셀이 30% 도 안 되거나 유채색이 40% 를 넘으면 도면이 아닌 사진·그림으로 본다
const MIN_SIDE = 1600;
async function readPixels(dataURL) {
  const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = dataURL; });
  const up = Math.max(1, MIN_SIDE / Math.max(im.width, im.height)), W = Math.round(im.width * up), H = Math.round(im.height * up);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, N = W * H;
  const stats = () => {
    const hist = new Float64Array(256); let colorful = 0;
    for (let i = 0; i < N; i++) {
      const r = d[4 * i], gg = d[4 * i + 1], b = d[4 * i + 2];
      hist[(r + gg + b) / 3 | 0]++; if (Math.max(r, gg, b) - Math.min(r, gg, b) > 40) colorful++;
    }
    let bg = 0; for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
    return { hist, colorful, bg };
  };
  let { hist, colorful, bg } = stats();
  // 스캔 잡음: 이웃 픽셀 밝기 차이의 중앙값(깨끗한 도면은 0)이 2 를 넘으면 5x5 중앙값 필터 (선 가장자리는 지키고 잡음만 지운다)
  { const diffs = new Uint32Array(256);
    for (let i = 0; i < N - 1; i += 7) { const a = (d[4 * i] + d[4 * i + 1] + d[4 * i + 2]) / 3, b = (d[4 * i + 4] + d[4 * i + 5] + d[4 * i + 6]) / 3; diffs[Math.min(255, Math.abs(a - b) | 0)]++; }
    let cum = 0, med = 0, tot = 0; for (const v of diffs) tot += v; for (; med < 255; med++) { cum += diffs[med]; if (cum >= tot / 2) break; }
    if (med > 2 && colorful < N * 0.05) {
      const L = new Uint8Array(N); for (let i = 0; i < N; i++) L[i] = (d[4 * i] + d[4 * i + 1] + d[4 * i + 2]) / 3;
      const win = new Uint8Array(25);
      for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        let n = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) win[n++] = L[(y + dy) * W + x + dx];
        win.sort(); const v = win[12], k = 4 * (y * W + x); d[k] = d[k + 1] = d[k + 2] = v;
      }
      ({ hist, colorful, bg } = stats());
    } }
  const invert = bg < 128;
  if (invert) { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } hist.reverse(); bg = 255 - bg; }
  // 배경 봉우리의 퍼짐 (잡음): 배경보다 어두운 쪽 절반 높이까지의 폭
  let lo = bg; while (lo > 0 && hist[lo - 1] > hist[bg] * 0.1) lo--;
  let near = 0; for (let v = Math.max(0, lo - 4); v <= Math.min(255, 2 * bg - lo + 4); v++) near += hist[v];
  let dark = 0, acc = 0; for (; dark < 255; dark++) { acc += hist[dark]; if (acc > N * 0.002) break; } // 가장 진한 0.2%
  const white = lo - 4;
  if (white < 240 && white - dark >= 60) { // 회색 배경·잡음·낮은 대비일 때만 (깨끗한 도면은 그대로)
    const k = 255 / Math.max(1, white - dark), lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - dark) * k;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  return { W, H, d, up, photo: near < N * 0.3 || colorful > N * 0.4 };
}

// 벽 색 고르기: 도면마다 벽 색이 다르다 (검게 칠한 CAD 도면, 연회색 #D9D9D9 로 칠한 디자인 도면 등).
// 무채색 밝기 분포의 봉우리마다 그 밝기의 두꺼운 픽셀을 모아 보고, 가장 크게 이어진 덩어리가
// 가장 넓은 범위를 감싸는 밝기를 벽 색으로 고른다 (벽은 건물을 감싸는 하나의 그물, 좌석은 흩어진 작은 상자)
// 반환: { dark: true } (진한 벽 + 빨간 칸막이) 또는 { dark: false, lo, hi } (그 밝기 범위)
function pickWallTone({ W, H, d }) {
  const f = 4, w = Math.floor(W / f), h = Math.floor(H / f), av = new Uint8Array(w * h), gray = new Uint8Array(w * h), red = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // 1/4 로 줄여서 빠르게
    const k = 4 * ((y * f + 2) * W + x * f + 2), r = d[k], g = d[k + 1], b = d[k + 2], i = y * w + x;
    av[i] = (r + g + b) / 3; gray[i] = Math.max(r, g, b) - Math.min(r, g, b) < 40 && av[i] < 245 ? 1 : 0;
    red[i] = r > 150 && r - g > 45 && r - b > 45 ? 1 : 0;
  }
  const hist = new Float64Array(32);
  for (let i = 0; i < w * h; i++) if (gray[i]) hist[av[i] >> 3]++;
  const cands = [{ dark: true }];
  for (let k = 18; k < 31; k++) // 밝은 쪽 봉우리 (144 이상): 전체의 0.5% 넘게 차지하는 밝기
    if (hist[k] > w * h * 0.005 && hist[k] >= hist[k - 1] && hist[k] >= hist[k + 1]) cands.push({ dark: false, lo: k * 8 - 18, hi: k * 8 + 26 });
  let best = cands[0], bestScore = -1;
  for (const c of cands) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = c.dark ? ((gray[i] && av[i] < 140) || red[i] ? 1 : 0) : (gray[i] && av[i] >= c.lo && av[i] <= c.hi ? 1 : 0);
    const { list } = components(morph(morph(m, w, h, 1, true), w, h, 1, false), w, h);
    const score = Math.max(0, ...list.map(q => (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1)));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// raw: 벽 색 픽셀 (벽·칸막이 후보, 같은 색 글자·선 포함), light: 연한 회색 선까지 포함 (창문 선 확인용)
// wall: raw 에서 5px 보다 얇은 것(치수선·글자·집기 선)을 지운 것 = 칠해진 벽
function wallMasks(P) {
  const { W, H, d } = P, tone = pickWallTone(P), raw = new Uint8Array(W * H), light = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], av = (r + g + b) / 3, ch = Math.max(r, g, b) - Math.min(r, g, b);
    raw[i] = tone.dark ? ((av < 140 && ch < 50) || (r > 150 && r - g > 45 && r - b > 45) ? 1 : 0) : (ch < 40 && av >= tone.lo && av <= tone.hi ? 1 : 0);
    light[i] = raw[i] || (av < 200 && ch < 50) ? 1 : 0;
  }
  const wall = morph(morph(raw, W, H, 2, true), W, H, 2, false);
  return { W, H, raw, light, tone, photo: P.photo, wall: hatchWalls(light, wall, W, H) };
}

// 해치(빗금)·여러 줄로 그린 벽: 두 선 사이를 촘촘한 빗금으로 채운 벽, 창문처럼 2~3줄로 그린 벽은 칠해진 면이 아니라서 빠진다.
// 촘촘한 무늬(간격 4px 이하)를 메워 면으로 만든 뒤, 길고 곧으며 긴 두 변이 곧은 선으로 이어진 막대만 벽으로 더한다
// (의자 그림은 짧아서, 글자는 가장자리가 들쭉날쭉해서 빠진다)
function hatchWalls(lines, wall, W, H) { // lines: 연한 선까지 포함한 마스크 (빗금은 연회색인 경우가 많다)
  const S = Math.max(W, H), N = W * H;
  const C = morph(morph(lines, W, H, 3, false), W, H, 3, true); // 닫힘: 촘촘한 무늬(간격 6px 이하) 메우기
  const O = morph(morph(C, W, H, 2, true), W, H, 2, false);     // 열림: 5px 보다 얇은 것 지우기
  const I = new Uint8Array(N); for (let i = 0; i < N; i++) I[i] = O[i] && !wall[i] ? 1 : 0;
  const runH = new Int32Array(N), runV = new Int32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W;) { if (!I[y * W + x]) { x++; continue; } let e = x; while (e < W && I[y * W + e]) e++; for (let k = x; k < e; k++) runH[y * W + k] = e - x; x = e; }
  for (let x = 0; x < W; x++) for (let y = 0; y < H;) { if (!I[y * W + x]) { y++; continue; } let e = y; while (e < H && I[e * W + x]) e++; for (let k = y; k < e; k++) runV[k * W + x] = e - y; y = e; }
  const maxT = Math.round(S * 0.02), minL = Math.round(S * 0.02);
  // 덩어리를 길이 방향 한 칸씩 잘라 두께를 잰다: 곧고 두께가 고른 칸만 벽 (곡선 가구 등이 붙어 있어도 곧은 부분은 살린다)
  const cand = [], hollow = [];
  for (const horiz of [true, false]) {
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (I[i] && (horiz ? runH[i] >= runV[i] * 2 : runV[i] >= runH[i] * 2)) m[i] = 1;
    const { lab, list } = components(m, W, H);
    for (const c of list) {
      const [a0, a1, b0, b1] = horiz ? [c.x0, c.x1, c.y0, c.y1] : [c.y0, c.y1, c.x0, c.x1]; // a: 길이 방향, b: 두께 방향
      const at = (a, b) => horiz ? b * W + a : a * W + b, lo = [], hi = [];
      for (let a = a0; a <= a1; a++) { let l = -1, h = -1; for (let b = b0; b <= b1; b++) if (lab[at(a, b)] === c.id) { if (l < 0) l = b; h = b; } lo.push(l); hi.push(h); }
      const th = lo.map((l, k) => l < 0 ? 0 : hi[k] - l + 1), ts = th.filter(Boolean).sort((x, y) => x - y);
      if (!ts.length) continue;
      const tm = ts[ts.length >> 1], good = th.map(t => t > 0 && t <= maxT && Math.abs(t - tm) <= Math.max(2, tm * 0.5));
      const n = good.filter(Boolean).length;
      if (tm < 4 || tm > maxT || n < Math.max(tm * 4, minL)) continue;
      let eTop = 0, eBot = 0; // 긴 두 변에 원래 선이 이어져 있는지
      const on = (a, b) => { for (let d = -1; d <= 1; d++) { const i = at(a, b + d); if (b + d >= 0 && b + d < (horiz ? H : W) && lines[i]) return 1; } return 0; };
      good.forEach((g, k) => { if (g) { eTop += on(a0 + k, lo[k]); eBot += on(a0 + k, hi[k]); } });
      if (eTop < n * 0.8 || eBot < n * 0.8) continue;
      // 두 변 사이 속: 빗금·점무늬·가운데 줄이 있어야 벽. 속이 빈 두 줄 선(책상·부스 칸막이 외곽, 계단 난간)은 가구
      let ink = 0, tot = 0;
      good.forEach((g, k) => { if (g) for (let b = lo[k] + 2; b <= hi[k] - 2; b++) { tot++; if (lines[at(a0 + k, b)]) ink++; } });
      if (tot >= n && ink < tot * 0.08) { hollow.push({ horiz, a0, a1, mid: (lo[0] + hi[0]) / 2 }); continue; }
      const cells = good.map((g, k) => g ? [a0 + k, lo[k], hi[k]] : null).filter(Boolean);
      const mid = cells.reduce((q, c) => q + (c[1] + c[2]) / 2, 0) / cells.length; // 중심선 위치 (두께 방향)
      cand.push({ id: c.id, lab, cells, horiz, mid, a0: cells[0][0], a1: cells[cells.length - 1][0] });
    }
  }
  // 벽에 닿은 것부터, 받아들인 해치 벽을 거쳐 이어지는 것까지 (떨어져 있는 짧은 계단 난간·가구는 빠진다)
  const idx = (c, a, b) => c.horiz ? b * W + a : a * W + b;
  const out = wall.slice(), acc = new Set(), paint = (c, m) => {
    for (const [a, l, h] of c.cells) for (let b = l; b <= h; b++) m[idx(c, a, b)] = 1; };
  const touches = (c, m) => {
    for (const [a, l, h] of c.cells) for (let b = l; b <= h; b++) if (m[idx(c, a, b)]) return true;
    return false; };
  // 같은 줄에서 문 폭 이하의 틈을 두고 이어지는 받아들인 벽이 있으면 이어진 것으로 본다 (벽 - 문 - 벽)
  // 단, 건물 안에 있을 때만: 가운데에서 위·아래·왼쪽·오른쪽으로 가면 모두 칠해진 벽을 만나야 한다 (건물 밖 치수선 제외)
  const enclosed = (c, M = wall) => {
    const k0 = Math.max(6, Math.ceil(Math.max(...c.cells.map(e => e[2] - e[1])) / 2) + 3); // 자기 두께 밖에서부터
    const am = Math.round((c.a0 + c.a1) / 2), bm = Math.round(c.mid), [x, y] = c.horiz ? [am, bm] : [bm, am];
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
      for (let k = k0; k < S; k++) { const xx = x + dx * k, yy = y + dy * k; if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false; if (M[yy * W + xx]) return true; }
      return false; }); };
  const withHatch = wall.slice(); cand.forEach(c => paint(c, withHatch)); // 빗금 외벽도 벽으로 본 마스크
  // 책상 줄: 건물 안에서 속 빈 칸막이(가구)가 3개 이상 수직으로 붙은 긴 막대는 책상 줄의 테두리 (벽이 아니다. 외벽은 창가 칸막이가 붙어도 둔다)
  for (let i = cand.length - 1; i >= 0; i--) {
    const c = cand[i], half = (c.cells.reduce((q, e) => q + e[2] - e[1], 0) / c.cells.length) / 2 + 5;
    const n = hollow.filter(h => h.horiz !== c.horiz && h.mid >= c.a0 - 3 && h.mid <= c.a1 + 3 && (Math.abs(h.a0 - c.mid) <= half || Math.abs(h.a1 - c.mid) <= half)).length;
    if (n >= 3 && enclosed(c, withHatch)) cand.splice(i, 1);
  }
  const gapMax = S * 0.08, inLine = c => enclosed(c) && [...acc].some(d => d.horiz === c.horiz && Math.abs(d.mid - c.mid) <= 3 && Math.max(d.a0 - c.a1, c.a0 - d.a1) <= gapMax);
  for (let pass = 0; pass < 6; pass++) {
    const near = morph(out, W, H, 3, false);
    let grew = false;
    for (const c of cand) if (!acc.has(c) && (touches(c, near) || inLine(c))) { acc.add(c); paint(c, out); grew = true; }
    if (!grew) break;
  }
  return out;
}

// 정사각형(2r+1) 침식/팽창. 가로·세로로 나눠 창 안의 1 개수를 세서 빠르게 계산
// edgeFilled: 침식할 때 이미지 바깥을 채워진 것으로 본다 (닫힘 연산에서 이미지 가장자리 가까운 벽이 깎이지 않게)
function morph(m, W, H, r, erode, edgeFilled = false) {
  const pass = (src, len, count, at) => {
    const out = new Uint8Array(W * H), k = 2 * r + 1;
    for (let a = 0; a < count; a++) {
      let s = 0;
      for (let b = -r; b < len + r; b++) {
        if (b + r < len) s += src[at(a, b + r)]; // 창 오른쪽 끝 추가
        if (b - r - 1 >= 0) s -= src[at(a, b - r - 1)]; // 창 왼쪽 끝 제거
        const need = edgeFilled ? Math.min(b + r, len - 1) - Math.max(b - r, 0) + 1 : k; // 창 안에서 이미지 안쪽 칸 수
        if (b >= 0 && b < len) out[at(a, b)] = erode ? (s === need ? 1 : 0) : (s > 0 ? 1 : 0);
      }
    }
    return out;
  };
  const h = pass(m, W, H, (y, x) => y * W + x);
  return pass(h, H, W, (x, y) => y * W + x);
}

// 4방향으로 이어진 덩어리 찾기
function components(m, W, H) {
  const lab = new Int32Array(W * H), list = [], stack = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || lab[i]) continue;
    const id = list.length + 1, c = { id, area: 0, x0: W, y0: H, x1: 0, y1: 0 };
    let sp = 0; stack[sp++] = i; lab[i] = id;
    while (sp) {
      const j = stack[--sp], x = j % W, y = (j - x) / W;
      c.area++; if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      for (const q of nb) if (q >= 0 && m[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; }
    }
    list.push(c);
  }
  return { lab, list };
}

// 마스크의 경계를 픽셀 모서리를 따라 닫힌 고리들로 추적 (바깥 경계 + 구멍). 채울 때 evenodd 규칙을 쓴다
function traceLoops(m, W, H) {
  const V = W + 1, from = [], to = [], out = new Map();
  const add = (ax, ay, bx, by) => {
    const e = from.length, k = ay * V + ax; from.push(k); to.push(by * V + bx);
    const l = out.get(k); if (l) l.push(e); else out.set(k, [e]);
  };
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  const used = new Uint8Array(from.length), loops = [];
  for (let s = 0; s < from.length; s++) {
    if (used[s]) continue;
    const loop = []; let e = s;
    while (e >= 0 && !used[e]) {
      used[e] = 1; loop.push([from[e] % V, Math.floor(from[e] / V)]);
      const next = (out.get(to[e]) || []).find(q => !used[q]);
      e = next === undefined ? -1 : next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// 닫힌 고리 단순화 (Douglas–Peucker): 픽셀 계단을 직선·사선으로 편다
function simplifyLoop(pts, eps) {
  const n = pts.length;
  if (n < 4) return pts;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    return l ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / l : Math.hypot(p[0] - a[0], p[1] - a[1]);
  };
  const dp = (seg) => {
    const keep = new Uint8Array(seg.length); keep[0] = keep[seg.length - 1] = 1;
    const st = [[0, seg.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let mi = -1, md = eps;
      for (let i = a + 1; i < b; i++) { const d = dist(seg[i], seg[a], seg[b]); if (d > md) { md = d; mi = i; } }
      if (mi >= 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return seg.filter((_, i) => keep[i]);
  };
  let far = 0, fd = -1; // 시작점에서 가장 먼 점으로 고리를 둘로 나눠 단순화
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
  const a = dp(pts.slice(0, far + 1)), b = dp([...pts.slice(far), pts[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// 수평·수직에 가까운(4° 이내) 변을 똑바로 펴고, 두 변이 만나는 꼭짓점을 정확히 맞춘다. 일직선 위의 점은 뺀다
function orthogonalize(pts) {
  const n = pts.length, next = i => pts[(i + 1) % n];
  const kind = pts.map((a, i) => { const b = next(i), dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return dy <= dx * 0.07 ? 'h' : dx <= dy * 0.07 ? 'v' : ''; });
  const val = pts.map((a, i) => kind[i] === 'h' ? (a[1] + next(i)[1]) / 2 : kind[i] === 'v' ? (a[0] + next(i)[0]) / 2 : 0);
  const out = pts.map((p, i) => { // 꼭짓점 i 는 변 i-1 과 변 i 사이
    let [x, y] = p;
    for (const e of [(i - 1 + n) % n, i]) { if (kind[e] === 'h') y = val[e]; else if (kind[e] === 'v') x = val[e]; }
    return [x, y];
  });
  return out.filter((p, i) => {
    const a = out[(i - 1 + n) % n], b = out[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return Math.hypot(p[0] - a[0], p[1] - a[1]) >= 0.5 && Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 0.5 * L;
  });
}

// Gemini 가 준 벽 선분을 마스크의 실제 벽 중심선에 맞춘다 (평행 이동 + 기울기 보정), 끝점은 벽이 끝나는 곳까지.
// 반환 { seg, t: 두께(px), cov: 선분 중 벽 픽셀 위에 있는 비율 }
function snapWall([x1, y1, x2, y2], mask, W, H) {
  const L = Math.hypot(x2 - x1, y2 - y1), none = { seg: [x1, y1, x2, y2], t: 0, cov: 0 };
  if (L < 4) return none;
  const ux = (x2 - x1) / L, uy = (y2 - y1) / L, nx = -uy, ny = ux;
  const R = Math.max(6, Math.round(Math.max(W, H) * 0.015)), N = Math.max(10, Math.round(L / 4));
  const on = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1; };

  // 1. 선분을 따라 N 곳에서, 법선 방향 ±R 안의 벽 픽셀 구간 중 선에 가장 가까운 구간의 중심을 찾는다
  const samples = [];
  for (let i = 0; i <= N; i++) {
    const s = 0.05 + 0.9 * i / N, px = x1 + (x2 - x1) * s, py = y1 + (y2 - y1) * s;
    let best = null;
    for (let d = -R; d <= R; d++) {
      if (!on(px + nx * d, py + ny * d) || (d > -R && on(px + nx * (d - 1), py + ny * (d - 1)))) continue; // 구간 시작점만
      let e = d; while (e < R && on(px + nx * (e + 1), py + ny * (e + 1))) e++;
      const c = (d + e) / 2;
      if (!best || Math.abs(c) < Math.abs(best.c)) best = { c, len: e - d + 1 };
      d = e;
    }
    if (best) samples.push({ s, ...best });
  }
  if (samples.length < 3) return none;

  // 2. 가로지르는 다른 벽(구간이 유난히 긴 곳)과 튀는 값을 빼고, 오프셋 = a + b·s 로 직선 맞춤 (최소제곱)
  const med = a => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
  const tLen = med(samples.map(x => x.len)), cMed = med(samples.map(x => x.c));
  const ok = samples.filter(x => x.len <= tLen * 1.8 + 2 && Math.abs(x.c - cMed) <= Math.max(4, tLen * 1.5));
  if (ok.length < 3) return none;
  const ms = ok.reduce((a, x) => a + x.s, 0) / ok.length, mc = ok.reduce((a, x) => a + x.c, 0) / ok.length;
  const vs = ok.reduce((a, x) => a + (x.s - ms) ** 2, 0), b = vs > 1e-6 ? ok.reduce((a, x) => a + (x.s - ms) * (x.c - mc), 0) / vs : 0, a = mc - b * ms;
  let ax = x1 + nx * a, ay = y1 + ny * a, bx = x2 + nx * (a + b), by = y2 + ny * (a + b);

  // 3. 끝점: 벽 위면 벽이 끝날 때까지 늘리고, 벽 밖이면 벽이 시작할 때까지 줄인다
  const L2 = Math.hypot(bx - ax, by - ay), vx = (bx - ax) / L2, vy = (by - ay) / L2, E = R * 2;
  const fit = (px, py, dx, dy) => {
    if (on(px, py)) { let k = 0; while (k < E && on(px + dx * (k + 1), py + dy * (k + 1))) k++; return [px + dx * k, py + dy * k]; }
    let k = 0; while (k < E && !on(px - dx * k, py - dy * k)) k++;
    return k < E ? [px - dx * k, py - dy * k] : [px, py];
  };
  [ax, ay] = fit(ax, ay, -vx, -vy);
  [bx, by] = fit(bx, by, vx, vy);
  return { seg: [ax, ay, bx, by], t: tLen, cov: ok.length / (N + 1) };
}

// 창문 메우기 (Gemini 없이): 외벽의 창문 구간은 칠해진 벽 사이가 얇은 선 두 줄로 그려져 비어 보인다.
// 같은 줄에 있는 칠해진 벽 사이 틈(긴 변의 10% 이하)을, 그 틈을 따라 얇은 선이 거의(80%) 이어져 있으면 후보로 메우고,
// 그중 ① 건물 바깥과 맞닿고 ② 긴 변이 벽에 붙어 있지 않은 것(= 벽 옆을 두껍게 만드는 가짜가 아닌 것)만 받아들인다
function bridgeWindows(K, light, W, H) {
  const S = Math.max(W, H), L = Math.round(S * 0.1), R = Math.round(S * 0.012), C = new Uint8Array(W * H);
  const pass = (vertical) => { // vertical=false: 행마다 가로 틈, true: 열마다 세로 틈
    const n = vertical ? W : H, len = vertical ? H : W, at = (a, b) => vertical ? b * W + a : a * W + b;
    const sup = morph1(light, W, H, R, !vertical); // 틈과 수직 방향으로 R 만큼 번진 선
    for (let a = 0; a < n; a++) {
      let last = -1;
      for (let b = 0; b < len; b++) {
        if (!K[at(a, b)]) continue;
        if (last >= 0 && b - last > 1 && b - last - 1 <= L) {
          let c = 0; for (let k = last + 1; k < b; k++) c += sup[at(a, k)];
          if (c >= (b - last - 1) * 0.8) for (let k = last + 1; k < b; k++) C[at(a, k)] = 1;
        }
        last = b;
      }
    }
  };
  pass(false); pass(true);
  // 바깥: 이미지 테두리에서 (벽·후보가 아닌 곳으로) 번지는 영역
  const out = new Uint8Array(W * H), st = new Int32Array(W * H); let sp = 0;
  const push = i => { if (!out[i] && !K[i] && !C[i]) { out[i] = 1; st[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) { const i = st[--sp], x = i % W; if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (i >= W) push(i - W); if (i < W * (H - 1)) push(i + W); }
  const near = morph(out, W, H, 3, false), { lab, list } = components(C, W, H), res = K.slice();
  list.forEach(c => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, horiz = bw >= bh;
    let touchOut = false, side = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const i = y * W + x; if (lab[i] !== c.id) continue;
      if (near[i]) touchOut = true;
      if (horiz ? (y > 0 && K[i - W]) || (y < H - 1 && K[i + W]) : (x > 0 && K[i - 1]) || (x < W - 1 && K[i + 1])) side++;
    }
    if (touchOut && side < (horiz ? bw : bh) * 2 * 0.3)
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * W + x] === c.id) res[y * W + x] = 1;
  });
  return res;
}

// 바깥(F=0)까지 거리 (체스판 거리, 2번 훑기). 바깥은 0, 이미지 테두리 밖도 바깥으로 본다
function distOut(F, W, H) {
  const N = W * H, D = new Int32Array(N), INF = 1 << 29;
  for (let i = 0; i < N; i++) D[i] = F[i] ? INF : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!D[i]) continue;
    let m = D[i];
    if (x > 0) m = Math.min(m, D[i - 1] + 1); else m = 1;
    if (y > 0) { m = Math.min(m, D[i - W] + 1); if (x > 0) m = Math.min(m, D[i - W - 1] + 1); if (x < W - 1) m = Math.min(m, D[i - W + 1] + 1); } else m = 1;
    D[i] = m;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!D[i]) continue;
    let m = D[i];
    if (x < W - 1) m = Math.min(m, D[i + 1] + 1); else m = 1;
    if (y < H - 1) { m = Math.min(m, D[i + W] + 1); if (x < W - 1) m = Math.min(m, D[i + W + 1] + 1); if (x > 0) m = Math.min(m, D[i + W - 1] + 1); } else m = 1;
    D[i] = m;
  }
  return D;
}

// 외벽 닫기: 건물 윤곽(발자국)을 구해, 그 윤곽을 따라 외벽 두께만큼 고른 띠로 벽을 깐다 → 입구·문·창문 틈까지 외벽을 모두 닫는다
// · 발자국: 벽을 닫힘 연산(긴 변의 10% 이하 틈 메우기)한 뒤, 이미지 테두리에서 닿지 않는 곳 전부
// · 외벽 두께: 윤곽에서 안쪽으로 1px 씩 들어가며, 원래 벽이 덮는 비율이 바깥 몇 겹의 절반 아래로 떨어지기 직전까지
function closeExterior(K, W, H) {
  const S = Math.max(W, H), r = Math.round(S * 0.05), N = W * H;
  const closed = morph(morph(K, W, H, r, false), W, H, r, true, true);
  const F = new Uint8Array(N).fill(1), st = new Int32Array(N); let sp = 0;
  const push = i => { if (F[i] && !closed[i]) { F[i] = 0; st[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp) { const i = st[--sp], x = i % W; if (x > 0) push(i - 1); if (x < W - 1) push(i + 1); if (i >= W) push(i - W); if (i < N - W) push(i + W); }
  const D = distOut(F, W, H), INF = 1 << 29;
  const MAX = Math.round(S * 0.03), tot = new Float64Array(MAX + 2), hit = new Float64Array(MAX + 2);
  for (let i = 0; i < N; i++) if (D[i] && D[i] <= MAX + 1) { tot[D[i]]++; if (K[i]) hit[D[i]]++; }
  const cov = d => tot[d] ? hit[d] / tot[d] : 0, base = (cov(1) + cov(2) + cov(3)) / 3;
  let t = 3;
  while (t < MAX && cov(t + 1) >= base * 0.5) t++;
  const out = K.slice();
  for (let i = 0; i < N; i++) if (D[i] && D[i] <= t) out[i] = 1;
  // 외벽 띠 안쪽으로 얕게 튀어나온 덩어리(기둥 돌출·문틀·자동문 등)는 지워 외벽 안쪽 면을 고르게 한다.
  // 외벽에서 깊게 들어가는 내부 벽과, 외벽에 붙지 않은 기둥은 그대로 둔다
  const inner = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (out[i] && D[i] > t) inner[i] = 1;
  // 외벽에 붙은 덩어리에서, 외벽 안쪽 얕은 층(깊이 P 이내)은 깊이 들어가는 벽의 뿌리(그 벽에서 P 이내)만 남긴다
  const P = Math.max(t * 2, Math.round(S * 0.015)), { lab, list } = components(inner, W, H), attached = new Uint8Array(list.length + 1);
  for (let i = 0; i < N; i++) if (lab[i] && D[i] === t + 1) attached[lab[i]] = 1;
  const deep = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (inner[i] && D[i] > t + P) deep[i] = 1;
  const rv = morph1(deep, W, H, P, true), rh = morph1(deep, W, H, P, false); // 뿌리는 벽 방향(위아래·좌우)으로만, 옆으로 넓히지 않는다
  const root = new Uint8Array(N); for (let i = 0; i < N; i++) root[i] = rv[i] | rh[i];
  for (let i = 0; i < N; i++) if (inner[i] && D[i] <= t + P && attached[lab[i]] && !root[i]) out[i] = 0;
  out.F = F; out.t = t; // 건물 발자국·외벽 두께 (얇은 벽 찾기·단순화에서 쓴다)
  return out;
}

// 얇은 벽 찾기 (AI 없이): 칠해진 벽 마스크는 5px 보다 얇은 것을 지우므로, 얇은 선으로 그린 칸막이가 빠진다. 그중 벽인 것만 되살린다
// ① 칠해진 벽을 뺀 벽 색 선 중 곧은 가로·세로 선 (이미지 긴 변의 4% 이상) ② 건물 안 ③ 한쪽 끝이 벽(또는 이미 찾은 얇은 벽)에 닿음
// ④ 짧은 선이 촘촘히 반복되는 무리(계단 디딤판 등)는 뺀다 ⑤ 두 줄로 그린 벽은 사이를 메워 한 벽으로 만들고, 잘 보이게 조금 두껍게 한다
function thinWalls(K, raw, F, W, H) {
  const S = Math.max(W, H), N = W * H, Lr = Math.round(S * 0.02), near = morph(K, W, H, 2, false);
  const thin = new Uint8Array(N);
  for (let i = 0; i < N; i++) thin[i] = raw[i] && !near[i] && F && F[i] ? 1 : 0;
  // 가로·세로로 Lr*2+1 이상 이어진 선만 (한 방향 열림)
  const open1 = vertical => { const e = new Uint8Array(N), n = vertical ? W : H, len = vertical ? H : W, at = (a, b) => vertical ? b * W + a : a * W + b;
    for (let a = 0; a < n; a++) { let run = 0; for (let b = 0; b <= len; b++) { if (b < len && thin[at(a, b)]) { run++; continue; }
      if (run >= 2 * Lr + 1) for (let k = b - run; k < b; k++) e[at(a, k)] = 1; run = 0; } }
    return e; };
  // 가로선·세로선은 따로 덩어리로 묶는다 (ㄱ자로 만나면 한 덩어리가 되어 '얇은 선' 판정에서 빠지므로)
  const maxT = Math.max(6, Math.round(S * 0.004)), cand = [];
  for (const vertical of [false, true]) {
    const { lab, list } = components(open1(vertical), W, H);
    for (const c of list) if ((vertical ? c.x1 - c.x0 : c.y1 - c.y0) + 1 <= maxT) cand.push({ ...c, lab, h: !vertical }); // 곧은 얇은 선만
  }
  // ④ 계단 같은 무리: 길이가 비슷하고 서로 겹치게 나란한 선이 4개 이상이고, 간격이 길이의 35% 보다 좁으면 뺀다
  const len = c => c.h ? c.x1 - c.x0 : c.y1 - c.y0, pos = c => c.h ? (c.y0 + c.y1) / 2 : (c.x0 + c.x1) / 2;
  const span = c => c.h ? [c.x0, c.x1] : [c.y0, c.y1], drop = new Set();
  for (const c of cand) {
    const grp = cand.filter(d => d.h === c.h && Math.abs(len(d) - len(c)) <= len(c) * 0.15
      && Math.min(span(c)[1], span(d)[1]) - Math.max(span(c)[0], span(d)[0]) >= len(c) * 0.8).sort((a, b) => pos(a) - pos(b));
    if (grp.length < 4) continue;
    const gaps = grp.slice(1).map((d, i) => pos(d) - pos(grp[i])).sort((a, b) => a - b);
    if (gaps[gaps.length >> 1] < len(c) * 0.35) grp.forEach(d => drop.add(d));
  }
  // ③ 벽에 닿은 것부터, 닿은 얇은 벽을 거쳐 이어지는 것까지 (최대 3번)
  const nearK = morph(K, W, H, 3, false), acc = new Set(), paint = (c, m) => {
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (c.lab[y * W + x] === c.id) m[y * W + x] = 1; };
  const touches = (c, m) => {
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (c.lab[y * W + x] === c.id && m[y * W + x]) return true;
    return false; };
  let M = nearK;
  for (let pass = 0; pass < 3; pass++) {
    let grew = false;
    for (const c of cand) if (!acc.has(c) && !drop.has(c) && touches(c, M)) { acc.add(c); grew = true; }
    if (!grew) break;
    const got = new Uint8Array(N); acc.forEach(c => paint(c, got));
    const g2 = morph(got, W, H, 3, false); M = new Uint8Array(N); for (let i = 0; i < N; i++) M[i] = nearK[i] | g2[i];
  }
  const A = new Uint8Array(N); acc.forEach(c => paint(c, A));
  // ⑤ 두 줄 벽 메우기(닫힘) + 최소 두께
  const r = Math.max(4, Math.round(S * 0.005)), thick = Math.max(1, Math.round(S * 0.0015));
  const closedA = morph(morph(A, W, H, r, false), W, H, r, true), wide = morph(closedA, W, H, thick, false), out = K.slice();
  for (let i = 0; i < N; i++) if (wide[i] && F[i]) out[i] = 1;
  out.F = F;
  return out;
}

// 다각형 채우기 (짝홀 규칙, 픽셀 중심 기준)
function fillPolygon(loop, W, H) {
  const m = new Uint8Array(W * H), n = loop.length;
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = loop[i], [xj, yj] = loop[j];
      if ((yi > yc) !== (yj > yc)) xs.push(xi + (yc - yi) * (xj - xi) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * W + x] = 1;
  }
  return m;
}

// 좌석 도면처럼 벽을 단순화한다 (건축 디테일 없이, 같은 두께·직각)
// · 외벽: 건물 윤곽을 크게 단순화(직선·직각)한 다각형을 따라 고른 두께의 띠
// · 내부 벽: 가로·세로 막대로 나눠 모두 같은 두께(중앙값)로, 거의 한 줄인 벽은 한 줄로 맞춘다
// · 외벽에 붙지 않은 작은 덩어리(기둥)는 네모로, 막대로 나뉘지 않는 덩어리(사선 벽 등)는 모양 그대로
// 반환: { ring: 외벽 마스크, bars: [{ seg: [x1,y1,x2,y2], t }], blobs: 마스크, F2: 단순화한 발자국 }
function schematize(K, F, tExt, W, H) {
  const S = Math.max(W, H), N = W * H;
  // 1. 발자국 윤곽 단순화 → 다시 채우기
  const loops = traceLoops(F, W, H).sort((a, b) => b.length - a.length);
  const outline = orthogonalize(simplifyLoop(loops[0], Math.max(3, S * 0.006)));
  const F2 = fillPolygon(outline, W, H), D = distOut(F2, W, H);
  const ring = new Uint8Array(N), I = new Uint8Array(N);
  for (let i = 0; i < N; i++) { if (F2[i] && D[i] <= tExt) ring[i] = 1; else if (K[i] && F2[i]) I[i] = 1; }
  // 2. 내부 벽: 픽셀마다 가로·세로로 이어진 길이를 재서 더 긴 쪽(2배 이상) 막대로 나눈다
  const runH = new Int32Array(N), runV = new Int32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W;) { if (!I[y * W + x]) { x++; continue; } let e = x; while (e < W && I[y * W + e]) e++; for (let k = x; k < e; k++) runH[y * W + k] = e - x; x = e; }
  for (let x = 0; x < W; x++) for (let y = 0; y < H;) { if (!I[y * W + x]) { y++; continue; } let e = y; while (e < H && I[e * W + x]) e++; for (let k = y; k < e; k++) runV[k * W + x] = e - y; y = e; }
  const hb = new Uint8Array(N), vb = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (I[i]) { if (runH[i] >= runV[i] * 2) hb[i] = 1; else if (runV[i] >= runH[i] * 2) vb[i] = 1; }
  const bars = [];
  for (const [m, horiz] of [[hb, true], [vb, false]]) {
    const { lab, list } = components(m, W, H);
    for (const c of list) {
      const len = horiz ? c.x1 - c.x0 + 1 : c.y1 - c.y0 + 1, t = horiz ? c.y1 - c.y0 + 1 : c.x1 - c.x0 + 1;
      if (len < t * 2 || len < S * 0.01) continue; // 뭉툭한 조각(돌출·문틀)은 벽이 아니다
      let sum = 0, n = 0; // 중심선: 픽셀 평균 위치
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * W + x] === c.id) { sum += horiz ? y : x; n++; }
      const mid = sum / n + 0.5;
      bars.push({ seg: horiz ? [c.x0, mid, c.x1 + 1, mid] : [mid, c.y0, mid, c.y1 + 1], t, t0: t, horiz }); // t0: 원래 두께
    }
  }
  // 3. 같은 두께 (길이 가중 중앙값), 거의 한 줄인 막대는 한 줄로
  const ts = bars.flatMap(b => Array(Math.max(1, Math.round(Math.hypot(b.seg[2] - b.seg[0], b.seg[3] - b.seg[1]) / 10))).fill(b.t)).sort((a, b) => a - b);
  const tInt = Math.min(tExt, Math.max(3, Math.round(S * 0.004), ts.length ? ts[ts.length >> 1] : tExt * 0.6));
  bars.forEach(b => { b.t = tInt; });
  // 외벽은 내벽보다 확실히 두껍게 (좌석 도면: 외벽 ≈ 내벽의 1.8배 이상). 얇게 그린 도면이면 안쪽으로 띠를 넓힌다
  const tE = Math.max(tExt, Math.round(tInt * 1.8));
  if (tE > tExt) for (let i = 0; i < N; i++) if (F2[i] && D[i] <= tE) ring[i] = 1;
  for (const horiz of [true, false]) {
    const k = horiz ? 1 : 0, grp = bars.filter(b => b.horiz === horiz).sort((a, b) => a.seg[k] - b.seg[k]);
    for (let i = 0; i < grp.length;) {
      let j = i; while (j + 1 < grp.length && grp[j + 1].seg[k] - grp[j].seg[k] <= tInt * 0.75) j++;
      const v = grp.slice(i, j + 1).reduce((a, b) => a + b.seg[k], 0) / (j - i + 1);
      for (let q = i; q <= j; q++) { grp[q].seg[k] = v; grp[q].seg[k + 2] = v; }
      i = j + 1;
    }
  }
  joinEnds(bars); // 막대 끝을 만나는 벽의 바깥 면에 맞춘다 (외벽 띠와는 이미 맞닿아 있다)
  // 4. 막대로 덮이지 않은 덩어리: 작고 꽉 찬 것은 기둥(네모), 큰 것은 모양 그대로 (사선 벽 등)
  const cover = new Uint8Array(N); // 막대가 원래 차지하던 자리 (원래 두께 기준: 얇게 다시 그린 벽의 양옆 띠가 찌꺼기로 남지 않게)
  for (const b of bars) {
    const [x1, y1, x2, y2] = b.seg, r = Math.ceil(Math.max(b.t0, b.t) / 2) + 2;
    for (let y = Math.floor(Math.min(y1, y2) - r); y <= Math.ceil(Math.max(y1, y2) + r); y++) for (let x = Math.floor(Math.min(x1, x2) - r); x <= Math.ceil(Math.max(x1, x2) + r); x++)
      if (x >= 0 && y >= 0 && x < W && y < H) cover[y * W + x] = 1;
  }
  const rest = new Uint8Array(N); for (let i = 0; i < N; i++) rest[i] = I[i] && !cover[i] ? 1 : 0;
  // 벽(외벽 띠·막대)에 붙은 것만 남긴다: 떨어져 있는 기둥·화분·가구는 벽이 아니다
  const wallNear = new Uint8Array(N); for (let i = 0; i < N; i++) wallNear[i] = ring[i] | cover[i];
  const touch = morph(wallNear, W, H, 3, false);
  const blobs = new Uint8Array(N), R = components(rest, W, H);
  for (const c of R.list) {
    if (c.area < (tInt * 1.5) ** 2) continue; // 작은 찌꺼기
    let attached = false;
    for (let y = c.y0; y <= c.y1 && !attached; y++) for (let x = c.x0; x <= c.x1; x++) if (R.lab[y * W + x] === c.id && touch[y * W + x]) { attached = true; break; }
    // 꽉 찬 네모(벽에 붙은 기둥·벽 끝)나 큰 덩어리(사선 벽)만: 화분·가구처럼 들쭉날쭉한 작은 것은 뺀다
    const solid = c.area >= (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) * 0.75;
    let big = c.area >= (tInt * 5) ** 2;
    if (solid) big = false; // 꽉 찬 덩어리는 아래 기둥 크기 검사로만
    if (big) { // 큰 덩어리는 벽처럼 가늘 때만 (사선 벽). 두툼한 톱니 덩어리는 벽에 붙은 책상 줄 같은 가구
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, sub = new Uint8Array(bw * bh);
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (R.lab[y * W + x] === c.id) sub[(y - c.y0) * bw + x - c.x0] = 1;
      const Dd = distOut(sub, bw, bh); let mx = 0; for (let i = 0; i < bw * bh; i++) if (Dd[i] > mx) mx = Dd[i];
      big = mx <= Math.max(tExt, tInt * 1.5) / 2 + 2 && c.area < bw * bh * 0.5; // 사선 벽은 바운딩 박스의 절반도 안 채운다
    }
    // 꽉 찬 덩어리도 기둥만 한 크기까지 (외벽 두께의 6배 넘게 긴 것은 벽에 붙은 탁자·카운터)
    const pillar = solid && Math.max(c.x1 - c.x0, c.y1 - c.y0) + 1 <= Math.max(tExt, tInt * 2) * 6;
    if (!attached || !(pillar || big)) continue;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (R.lab[y * W + x] === c.id) blobs[y * W + x] = 1;
  }
  return { ring, bars, blobs, F2 };
}

// 벽 잇기: ① 같은 줄(가로·세로)의 막대가 gapMax 이하 틈으로 떨어져 있으면 하나로 합친다 (문 자리·끊긴 벽)
// ② 다른 벽에 닿지 않은 막대 끝은, 그 방향으로 reachMax 안에 벽(다른 막대·외벽 띠)이 있으면 그 벽까지 늘린다
// ③ 양 끝이 모두 떠 있는 짧은 막대(4m 미만)는 지운다. 마지막에 joinEnds 로 끝을 만나는 벽의 바깥 면에 맞춘다
function connectWalls(bars, ring, W, H, gapMax, reachMax, light = null) {
  const axis = b => Math.abs(b.seg[1] - b.seg[3]) < 0.5 ? 'h' : Math.abs(b.seg[0] - b.seg[2]) < 0.5 ? 'v' : '';
  const line = b => axis(b) === 'h' ? b.seg[1] : b.seg[0], span = b => axis(b) === 'h' ? [Math.min(b.seg[0], b.seg[2]), Math.max(b.seg[0], b.seg[2])] : [Math.min(b.seg[1], b.seg[3]), Math.max(b.seg[1], b.seg[3])];
  // ① 같은 줄 합치기
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < bars.length && !merged; i++) for (let j = i + 1; j < bars.length && !merged; j++) {
      const a = bars[i], b = bars[j], ax = axis(a);
      if (!ax || ax !== axis(b) || Math.abs(line(a) - line(b)) > Math.max(a.t, b.t)) continue;
      const [a0, a1] = span(a), [b0, b1] = span(b);
      if (Math.max(a0, b0) - Math.min(a1, b1) > gapMax) continue;
      const la = a1 - a0, lb = b1 - b0, ln = (line(a) * la + line(b) * lb) / Math.max(1e-6, la + lb), lo = Math.min(a0, b0), hi = Math.max(a1, b1);
      bars[i] = { ...a, t: Math.max(a.t, b.t), seg: ax === 'h' ? [lo, ln, hi, ln] : [ln, lo, ln, hi] };
      bars.splice(j, 1); merged = true;
    }
  }
  // ② 모자란 끝 늘리기
  const onRing = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < W && y < H && ring[y * W + x] === 1; };
  const onBar = (x, y, self) => bars.some(o => {
    if (o === self) return false;
    const [x1, y1, x2, y2] = o.seg, dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy, k = l ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l)) : 0;
    return Math.hypot(x - (x1 + k * dx), y - (y1 + k * dy)) <= o.t / 2 + 1; });
  const hitWall = (x, y, self) => onRing(x, y) || onBar(x, y, self);
  const touchesEnd = (b, end) => {
    const [x1, y1, x2, y2] = b.seg, ex = end ? x2 : x1, ey = end ? y2 : y1, L = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (end ? x2 - x1 : x1 - x2) / L, uy = (end ? y2 - y1 : y1 - y2) / L;
    for (let k = -b.t; k <= b.t / 2 + 3; k++) if (hitWall(ex + ux * k, ey + uy * k, b)) return true;
    return false; };
  for (const b of bars) {
    const ax = axis(b); if (!ax) continue;
    for (const end of [0, 1]) {
      const [x1, y1, x2, y2] = b.seg, ex = end ? x2 : x1, ey = end ? y2 : y1, ox = end ? x1 : x2, oy = end ? y1 : y2;
      const L = Math.hypot(ex - ox, ey - oy) || 1, ux = (ex - ox) / L, uy = (ey - oy) / L, gap = b.t / 2 + 2;
      if (touchesEnd(b, end)) continue; // 이미 닿아 있다 (모서리에서 바깥 면에 맞춘 끝도)
      // 긴 벽(1.5m 이상)은 늘릴 길을 따라 원래 도면에 선(벽 흔적)이 절반 넘게 있으면 문 폭(1.1m)까지 늘린다 (빈 통로는 0.4m 까지만)
      const inked = k => { const cx = ex + ux * k, cy = ey + uy * k, px = -uy, py = ux;
        for (let o = -b.t / 2; o <= b.t / 2; o++) { const x = Math.round(cx + px * o), y = Math.round(cy + py * o); if (x >= 0 && y >= 0 && x < W && y < H && light[y * W + x]) return true; }
        return false; };
      let reach = reachMax;
      if (light && L >= reachMax * 3.75) { let hit = 0, tot = 0, far = reachMax * 2.75;
        for (let k = gap; k <= far; k++) { if (hitWall(ex + ux * k, ey + uy * k, b)) break; tot++; if (inked(k)) hit++; }
        if (tot && hit >= tot * 0.5) reach = far; }
      for (let k = gap; k <= reach; k += 1) if (hitWall(ex + ux * k, ey + uy * k, b)) {
        if (end) { b.seg[2] = ex + ux * k; b.seg[3] = ey + uy * k; } else { b.seg[0] = ex + ux * k; b.seg[1] = ey + uy * k; }
        break;
      }
    }
  }
  // ③ 떠 있는 막대 지우기: 양 끝 모두 어떤 벽에도 닿지 않으면 좌석 구분선·가구 선이다 (벽은 다른 벽에 이어진다)
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i], L = Math.hypot(b.seg[2] - b.seg[0], b.seg[3] - b.seg[1]);
    // 옆으로 붙은 벽(중간에서 다른 막대가 닿음)도 이어진 것으로 본다
    const mid = [0.25, 0.5, 0.75].some(f => { const x = b.seg[0] + (b.seg[2] - b.seg[0]) * f, y = b.seg[1] + (b.seg[3] - b.seg[1]) * f;
      return bars.some(o => o !== b && Math.min(Math.hypot(o.seg[0] - x, o.seg[1] - y), Math.hypot(o.seg[2] - x, o.seg[3] - y)) <= b.t + o.t); });
    if (!touchesEnd(b, 0) && !touchesEnd(b, 1) && !mid && L < gapMax * 3) bars.splice(i, 1);
  }
  joinEnds(bars);
  return bars;
}

// 한 방향(가로 또는 세로)으로만 팽창: vertical=true 면 위아래로 r 만큼
function morph1(m, W, H, r, vertical) {
  const out = new Uint8Array(W * H), n = vertical ? W : H, len = vertical ? H : W, at = (a, b) => vertical ? b * W + a : a * W + b;
  for (let a = 0; a < n; a++) {
    let s = 0;
    for (let b = -r; b < len + r; b++) {
      if (b + r < len) s += m[at(a, b + r)];
      if (b - r - 1 >= 0) s -= m[at(a, b - r - 1)];
      if (b >= 0 && b < len) out[at(a, b)] = s > 0 ? 1 : 0;
    }
  }
  return out;
}

// 벽 선분의 끝이 다른 벽 가까이에서 끝나면(모서리·T자), 그 벽의 바깥 면에 정확히 닿게 맞춘다
// → 끝이 모자라 생기는 틈도, 넘쳐서 튀어나오는 부분도 없앤다. 다른 벽과 만나지 않는 끝은 그대로 둔다
function joinEnds(segs) {
  const fixed = segs.map(r => r.seg.slice());
  segs.forEach((r, i) => {
    const [x1, y1, x2, y2] = r.seg, L = Math.hypot(x2 - x1, y2 - y1);
    if (L < 1) return;
    const ux = (x2 - x1) / L, uy = (y2 - y1) / L;
    [[x1, y1, -1], [x2, y2, 1]].forEach(([px, py, dir]) => {
      let best = null;
      segs.forEach((o, j) => {
        if (j === i) return;
        const [a, b, c, d] = o.seg, M = Math.hypot(c - a, d - b);
        if (M < 1) return;
        const vx = (c - a) / M, vy = (d - b) / M, cross = ux * vy - uy * vx;
        if (Math.abs(cross) < 0.5) return; // 30° 보다 비슷한 방향이면 모서리가 아니다
        const t = ((a - px) * vy - (b - py) * vx) / cross; // 이 선분 방향으로 t 만큼 가면 다른 벽 중심선
        const q = ((px + ux * t - a) * vx + (py + uy * t - b) * vy); // 다른 벽 위의 위치 (0~M)
        const reach = Math.max(r.t, o.t) * 1.5 + 3;
        if (Math.abs(t) > reach || q < -reach || q > M + reach) return; // 교점이 두 벽 모두에서 가까워야 모서리·T자
        if (!best || Math.abs(t) < Math.abs(best.t)) best = { t, o, sin: Math.abs(cross) };
      });
      if (!best) return;
      // 중심선 교점에서 바깥쪽으로 다른 벽 두께의 절반(사선이면 /sin)만큼 더 나가면 바깥 면 → 끝을 평평하게 그려도 모서리가 꽉 찬다
      const go = best.t + dir * best.o.t / 2 / best.sin, nx = px + ux * go, ny = py + uy * go;
      if (dir < 0) { fixed[i][0] = nx; fixed[i][1] = ny; } else { fixed[i][2] = nx; fixed[i][3] = ny; }
    });
  });
  segs.forEach((r, i) => { r.seg = fixed[i]; });
}

// Gemini 없이 건물 영역 추정 (미리보기용): 가장 큰 벽 덩어리에서 시작해, 가까이(긴 변의 5% 이내) 있는 덩어리를 차례로 붙인다
function autoExtent(P) {
  const { W, H } = P, S = Math.max(W, H), minArea = (S * 0.007) ** 2, gap = S * 0.05;
  P.comp = P.comp || components(P.wall, W, H);
  const cs = P.comp.list.filter(c => c.area >= minArea).sort((a, b) => b.area - a.area);
  if (P.photo) throw new Error('도면이 아닌 것 같습니다. 벽이 그려진 평면도 이미지를 올려 주세요');
  if (!cs.length) throw new Error('벽을 찾지 못했습니다');
  let box = [cs[0].x0, cs[0].y0, cs[0].x1, cs[0].y1], grew = true;
  const used = new Set([cs[0]]);
  while (grew) {
    grew = false;
    for (const c of cs) if (!used.has(c) && c.x0 <= box[2] + gap && c.x1 >= box[0] - gap && c.y0 <= box[3] + gap && c.y1 >= box[1] - gap) {
      used.add(c); box = [Math.min(box[0], c.x0), Math.min(box[1], c.y0), Math.max(box[2], c.x1), Math.max(box[3], c.y1)]; grew = true;
    }
  }
  return { extent: [box[1] / H * 1000, box[0] / W * 1000, box[3] / H * 1000, box[2] / W * 1000], walls: [], width_mm: 0 };
}

// Gemini 결과 + 픽셀 → cm 도면
// w: AI 결과 또는 autoExtent 결과, P: wallMasks 결과, widthM: 사용자가 입력한 건물 가로 길이(m, 없으면 0)
function traceToPlan(w, P, widthM = 0) {
  const { W, H, raw, wall } = P, S = Math.max(W, H);
  const ok4 = a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);
  const lines = (w.walls || []).filter(ok4).map(([y1, x1, y2, x2]) => [x1 / 1000 * W, y1 / 1000 * H, x2 / 1000 * W, y2 / 1000 * H]);
  // 건물 영역: Gemini 가 준 extent (없으면 벽 선분 범위), 3% 여유
  let ex = ok4(w.extent) ? [w.extent[1] / 1000 * W, w.extent[0] / 1000 * H, w.extent[3] / 1000 * W, w.extent[2] / 1000 * H] : null;
  if (!ex && lines.length) ex = [Math.min(...lines.flatMap(l => [l[0], l[2]])), Math.min(...lines.flatMap(l => [l[1], l[3]])), Math.max(...lines.flatMap(l => [l[0], l[2]])), Math.max(...lines.flatMap(l => [l[1], l[3]]))];
  if (!ex) throw Object.assign(new Error('도면에서 건물을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });
  const pad = S * 0.03, inEx = (x, y) => x >= ex[0] - pad && x <= ex[2] + pad && y >= ex[1] - pad && y <= ex[3] + pad;

  // 1. 칠해진 벽 덩어리 중 건물 영역 안에 있고 충분히 큰 것만 남긴다 (글자·기호 조각 제거)
  P.comp = P.comp || components(wall, W, H);
  const { lab, list } = P.comp, keepId = new Uint8Array(list.length + 1);
  const minArea = (S * 0.007) ** 2, minDim = S * 0.008;
  list.forEach(c => { if (c.area >= minArea && Math.max(c.x1 - c.x0, c.y1 - c.y0) >= minDim && inEx((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)) keepId[c.id] = 1; });
  const K0 = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lab[i] && keepId[lab[i]]) K0[i] = 1;
  const KE = closeExterior(bridgeWindows(K0, P.light, W, H), W, H); // 외벽 창문 구간 메우기 → 외벽 전부 닫기
  // 얇은 칸막이 벽 더하기 (AI 없이): 벽을 연한 색으로 칠한 디자인 도면에서만.
  // 진한 벽의 CAD 도면은 벽을 칠하거나 빗금으로 그리고(hatchWalls), 얇은 한 줄 선은 대부분 가구라서 쓰지 않는다
  const K = P.tone && !P.tone.dark ? thinWalls(KE, P.raw, KE.F, W, H) : KE;

  // 2. 좌석 도면처럼 단순화: 외벽 띠 + 같은 두께의 내부 벽 막대 + 기둥
  const SC = schematize(K, KE.F, KE.t, W, H), tInt = SC.bars.length ? SC.bars[0].t : Math.max(3, Math.round(KE.t * 0.6));

  // 3. AI 벽 선분: 실제 벽 픽셀에 맞추고, 이미 있는 벽이 덮고 있으면 버린다. 남은 것(빠진 칸막이)만 같은 두께 막대로 더한다
  const segs = [];
  for (const l of lines) {
    if (!inEx((l[0] + l[2]) / 2, (l[1] + l[3]) / 2)) continue;
    let r = snapWall(l, K, W, H);
    if (r.cov >= 0.85) continue;
    if (r.cov < 0.35) { r = snapWall(l, raw, W, H); if (r.cov < 0.5) continue; }
    segs.push({ seg: r.seg, t: tInt });
  }
  let bars = SC.bars.concat(segs);
  if (segs.length) joinEnds(bars);

  // 벽 잇기: 좌석 도면은 문을 그리지 않고 벽이 서로 이어진다 (문 자리·끊긴 틈을 막고, 모자란 벽 끝을 이웃 벽까지)
  // 잇는 거리: 같은 줄 틈은 문 폭(1.3m)까지, 모자란 끝은 0.4m 까지 (축척 모르면 가로 15m 가정). 끝 늘리기를 길게 하면 책상 칸막이까지 이어져 버린다
  let fx0 = W, fx1 = 0;
  for (let i = 0; i < W * H; i++) if (SC.F2[i]) { const x = i % W; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; }
  const knownW = +widthM > 0 ? +widthM : +w.width_mm > 500 ? +w.width_mm / 1000 : 15, pxPerM = fx1 > fx0 ? (fx1 - fx0 + 1) / knownW : S / 15;
  bars = connectWalls(bars, SC.ring, W, H, pxPerM * 1.3, pxPerM * 0.4, P.light);

  // 4. 범위·축척: 단순화한 건물 발자국 = 건물 외곽
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < W * H; i++) if (SC.F2[i]) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) throw Object.assign(new Error('도면에서 벽을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });
  // 축척: 입력한 가로 길이(m) > AI 가 읽은 도면 치수(mm) > 가로 15m 가정
  const realW = +widthM > 0 ? +widthM * 100 : +w.width_mm > 500 ? +w.width_mm / 10 : 1500, k = realW / (x1 - x0 + 1);
  const cx = v => Math.round((v - x0) * k * 10) / 10, cy = v => Math.round((v - y0) * k * 10) / 10;

  // 5. 외벽 띠·기둥·사선 벽 → 다각형 (구멍 포함), 내부 벽 막대 → 선 벽
  const shapes = [];
  for (const m of [SC.ring, SC.blobs]) {
    const C = components(m, W, H);
    C.list.forEach(c => {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, sub = new Uint8Array(bw * bh);
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (C.lab[y * W + x] === c.id) sub[(y - c.y0) * bw + x - c.x0] = 1;
      const loops = traceLoops(sub, bw, bh).map(l => orthogonalize(simplifyLoop(l, 2))).filter(l => l.length >= 3)
        .map(l => l.map(([x, y]) => [cx(x + c.x0), cy(y + c.y0)]));
      if (loops.length) shapes.push(loops);
    });
  }
  const walls = bars.map(({ seg, t }) => straighten([cx(seg[0]), cy(seg[1]), cx(seg[2]), cy(seg[3]), Math.max(4, Math.round(t * k))]));
  return finalize({ width: Math.round((x1 - x0 + 1) * k), height: Math.round((y1 - y0 + 1) * k), wallThickness: 15, walls, shapes,
    src: { x0, y0, k } }); // src: 원본 이미지 px ↔ cm 변환 (px = cm / k + x0), 채점·겹쳐 보기용
}

// 형식·범위 정리 (Gemini 응답을 그대로 믿지 않는다)
function finalize(p) {
  const W = Math.min(10000, Math.max(200, p.width || 1000)), H = Math.min(10000, Math.max(200, p.height || 1000));
  const cx = v => Math.min(W, Math.max(0, v)), cy = v => Math.min(H, Math.max(0, v));
  const walls = p.walls.map(w => [cx(w[0]), cy(w[1]), cx(w[2]), cy(w[3]), ...w.slice(4, 5)])
    .filter(w => w.every(Number.isFinite) && (w[0] !== w[2] || w[1] !== w[3]));
  const shapes = (p.shapes || []).map(sh => sh.map(l => l.map(([x, y]) => [cx(x), cy(y)])));
  return { width: W, height: H, wallThickness: p.wallThickness, walls, shapes, ...(p.src ? { src: p.src } : {}) };
}

// 거의 수평·수직인(4° 이내) 벽 선분을 똑바로 편다
const straighten = ([x1, y1, x2, y2, ...t]) => { // t: 두께 (있으면 그대로 유지)
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dy) <= Math.abs(dx) * 0.07) { const y = Math.round((y1 + y2) / 2); return [x1, y, x2, y, ...t]; }
  if (Math.abs(dx) <= Math.abs(dy) * 0.07) { const x = Math.round((x1 + x2) / 2); return [x, y1, x, y2, ...t]; }
  return [x1, y1, x2, y2, ...t];
};
