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
  let { hist, colorful, bg } = stats(), noisy = false;

  { const diffs = new Uint32Array(256);
    for (let i = 0; i < N - 1; i += 7) { const a = (d[4 * i] + d[4 * i + 1] + d[4 * i + 2]) / 3, b = (d[4 * i + 4] + d[4 * i + 5] + d[4 * i + 6]) / 3; diffs[Math.min(255, Math.abs(a - b) | 0)]++; }
    let cum = 0, med = 0, tot = 0; for (const v of diffs) tot += v; for (; med < 255; med++) { cum += diffs[med]; if (cum >= tot / 2) break; }
    if (med > 2 && colorful < N * 0.05) {
      noisy = true;
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

  let lo = bg; while (lo > 0 && hist[lo - 1] > hist[bg] * 0.1) lo--;
  let near = 0; for (let v = Math.max(0, lo - 4); v <= Math.min(255, 2 * bg - lo + 4); v++) near += hist[v];
  let dark = 0, acc = 0; for (; dark < 255; dark++) { acc += hist[dark]; if (acc > N * 0.002) break; }
  const white = lo - 4;

  let brightPeak = false;
  if (bg < 240) for (let v = bg + 8; v < 252; v++) if (hist[v] > N * 0.005 && hist[v] >= hist[v - 1] && hist[v] >= hist[v + 1]) {

    let valley = Infinity; for (let u = bg + 2; u < v; u++) valley = Math.min(valley, hist[u]);
    if (valley < hist[v] * 0.5) { brightPeak = true; break; }
  }
  if (brightPeak) {
    const dh = new Float64Array(256); for (let v = 0; v < 256; v++) dh[Math.abs(v - bg)] += hist[v];
    let p = 0, acc2 = 0; for (; p < 255; p++) { acc2 += dh[p]; if (acc2 >= N * 0.998) break; }
    const lut = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) lut[v] = 255 - Math.abs(v - bg) * 255 / Math.max(1, p);
    for (let i = 0; i < d.length; i += 4) { const v = lut[(d[i] + d[i + 1] + d[i + 2]) / 3 | 0]; d[i] = d[i + 1] = d[i + 2] = v; }
  } else if (white < 240 && white - dark >= (noisy ? 60 : 20)) {
    const k = 255 / Math.max(1, white - dark), lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - dark) * k;
    for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  }
  return { W, H, d, up, photo: near < N * 0.3 || colorful > N * 0.4 };
}

function pickWallTone({ W, H, d }) {
  const f = 4, w = Math.floor(W / f), h = Math.floor(H / f), av = new Uint8Array(w * h), gray = new Uint8Array(w * h), red = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = 4 * ((y * f + 2) * W + x * f + 2), r = d[k], g = d[k + 1], b = d[k + 2], i = y * w + x;
    av[i] = (r + g + b) / 3; gray[i] = Math.max(r, g, b) - Math.min(r, g, b) < 40 && av[i] < 245 ? 1 : 0;
    red[i] = r > 150 && r - g > 45 && r - b > 45 ? 1 : 0;
  }
  const hist = new Float64Array(32);
  for (let i = 0; i < w * h; i++) if (gray[i]) hist[av[i] >> 3]++;
  const cands = [{ dark: true }];
  for (let k = 18; k < 31; k++)
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

function wallMasks(P) {
  const { W, H, d } = P, tone = pickWallTone(P), raw = new Uint8Array(W * H), light = new Uint8Array(W * H), fine = new Uint8Array(W * H), gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], av = (r + g + b) / 3, ch = Math.max(r, g, b) - Math.min(r, g, b);
    raw[i] = tone.dark ? ((av < 140 && ch < 50) || (r > 150 && r - g > 45 && r - b > 45) ? 1 : 0) : (ch < 40 && av >= tone.lo && av <= tone.hi ? 1 : 0);
    light[i] = raw[i] || (av < 200 && ch < 50) ? 1 : 0;
    fine[i] = av < 236 ? 1 : 0;
    gray[i] = ch < 20 && av >= 50 && av <= 215 && !raw[i] ? 1 : 0;
  }
  const wall = morph(morph(raw, W, H, 2, true), W, H, 2, false);
  return { W, H, raw, light, fine, gray: morph(morph(gray, W, H, 2, true), W, H, 2, false), tone, photo: P.photo, wall: hatchWalls(light, wall, W, H) };
}

function hatchWalls(lines, wall, W, H) {
  const S = Math.max(W, H), N = W * H;
  const C = morph(morph(lines, W, H, 3, false), W, H, 3, true);
  const O = morph(morph(C, W, H, 2, true), W, H, 2, false);
  const I = new Uint8Array(N); for (let i = 0; i < N; i++) I[i] = O[i] && !wall[i] ? 1 : 0;
  const runH = new Int32Array(N), runV = new Int32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W;) { if (!I[y * W + x]) { x++; continue; } let e = x; while (e < W && I[y * W + e]) e++; for (let k = x; k < e; k++) runH[y * W + k] = e - x; x = e; }
  for (let x = 0; x < W; x++) for (let y = 0; y < H;) { if (!I[y * W + x]) { y++; continue; } let e = y; while (e < H && I[e * W + x]) e++; for (let k = y; k < e; k++) runV[k * W + x] = e - y; y = e; }
  const maxT = Math.round(S * 0.02), minL = Math.round(S * 0.02);

  const cand = [], hollow = [];
  for (const horiz of [true, false]) {
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (I[i] && (horiz ? runH[i] >= runV[i] * 2 : runV[i] >= runH[i] * 2)) m[i] = 1;
    const { lab, list } = components(m, W, H);
    for (const c of list) {
      const [a0, a1, b0, b1] = horiz ? [c.x0, c.x1, c.y0, c.y1] : [c.y0, c.y1, c.x0, c.x1];
      const at = (a, b) => horiz ? b * W + a : a * W + b, lo = [], hi = [];
      for (let a = a0; a <= a1; a++) { let l = -1, h = -1; for (let b = b0; b <= b1; b++) if (lab[at(a, b)] === c.id) { if (l < 0) l = b; h = b; } lo.push(l); hi.push(h); }
      const th = lo.map((l, k) => l < 0 ? 0 : hi[k] - l + 1), ts = th.filter(Boolean).sort((x, y) => x - y);
      if (!ts.length) continue;
      const tm = ts[ts.length >> 1], good = th.map(t => t > 0 && t <= maxT && Math.abs(t - tm) <= Math.max(2, tm * 0.5));
      const n = good.filter(Boolean).length;
      if (tm < 4 || tm > maxT || n < Math.max(tm * 4, minL)) continue;
      let eTop = 0, eBot = 0;
      const on = (a, b) => { for (let d = -1; d <= 1; d++) { const i = at(a, b + d); if (b + d >= 0 && b + d < (horiz ? H : W) && lines[i]) return 1; } return 0; };
      good.forEach((g, k) => { if (g) { eTop += on(a0 + k, lo[k]); eBot += on(a0 + k, hi[k]); } });
      if (eTop < n * 0.8 || eBot < n * 0.8) continue;

      let ink = 0, tot = 0;
      good.forEach((g, k) => { if (g) for (let b = lo[k] + 2; b <= hi[k] - 2; b++) { tot++; if (lines[at(a0 + k, b)]) ink++; } });
      if (tot >= n && ink < tot * 0.08) { hollow.push({ horiz, a0, a1, mid: (lo[0] + hi[0]) / 2 }); continue; }
      const cells = good.map((g, k) => g ? [a0 + k, lo[k], hi[k]] : null).filter(Boolean);
      const mid = cells.reduce((q, c) => q + (c[1] + c[2]) / 2, 0) / cells.length;
      cand.push({ id: c.id, lab, cells, horiz, mid, a0: cells[0][0], a1: cells[cells.length - 1][0] });
    }
  }

  const idx = (c, a, b) => c.horiz ? b * W + a : a * W + b;
  const out = wall.slice(), acc = new Set(), paint = (c, m) => {
    for (const [a, l, h] of c.cells) for (let b = l; b <= h; b++) m[idx(c, a, b)] = 1; };
  const touches = (c, m) => {
    for (const [a, l, h] of c.cells) for (let b = l; b <= h; b++) if (m[idx(c, a, b)]) return true;
    return false; };

  const enclosed = (c, M = wall) => {
    const k0 = Math.max(6, Math.ceil(Math.max(...c.cells.map(e => e[2] - e[1])) / 2) + 3);
    const am = Math.round((c.a0 + c.a1) / 2), bm = Math.round(c.mid), [x, y] = c.horiz ? [am, bm] : [bm, am];
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => {
      for (let k = k0; k < S; k++) { const xx = x + dx * k, yy = y + dy * k; if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false; if (M[yy * W + xx]) return true; }
      return false; }); };
  const withHatch = wall.slice(); cand.forEach(c => paint(c, withHatch));

  for (let i = cand.length - 1; i >= 0; i--) {
    const c = cand[i], half = (c.cells.reduce((q, e) => q + e[2] - e[1], 0) / c.cells.length) / 2 + 5;
    const n = hollow.filter(h => h.horiz !== c.horiz && h.mid >= c.a0 - 3 && h.mid <= c.a1 + 3 && (Math.abs(h.a0 - c.mid) <= half || Math.abs(h.a1 - c.mid) <= half)).length;
    if (n >= 3 && enclosed(c, withHatch)) cand.splice(i, 1);
  }
  const gapMax = S * 0.08, inLine = c => enclosed(c) && [...acc].some(d => d.horiz === c.horiz && Math.abs(d.mid - c.mid) <= 3 && Math.max(d.a0 - c.a1, c.a0 - d.a1) <= gapMax);

  const pairs = parallelPairs(lines, W, H);
  for (let pass = 0; pass < 6; pass++) {
    const near = morph(out, W, H, 3, false);
    let grew = false;
    for (const c of cand) if (!acc.has(c) && (touches(c, near) || inLine(c))) { acc.add(c); paint(c, out); grew = true; }
    if (!grew) break;
  }
  if (pairs.length) {
    const wMax = Math.max(6, Math.round(S * 0.01)), near = morph(out, W, H, 2 * wMax, false), beside = morph(out, W, H, wMax, false);
    for (const q of pairs) {

      let cov = 0, tot = 0;
      for (let b = q.b0; b < q.b1; b += 2) { tot++; const a = (q.a0 + q.a1) >> 1; if (beside[q.horiz ? a * W + b : b * W + a]) cov++; }
      if (cov > tot * 0.5) continue;
      const ends = q.horiz ? [[q.b0, (q.a0 + q.a1) >> 1], [q.b1 - 1, (q.a0 + q.a1) >> 1]] : [[(q.a0 + q.a1) >> 1, q.b0], [(q.a0 + q.a1) >> 1, q.b1 - 1]];
      if (!ends.some(([x, y]) => near[y * W + x])) continue;
      for (let a = q.a0; a <= q.a1; a++) for (let b = q.b0; b < q.b1; b++) out[q.horiz ? a * W + b : b * W + a] = 1;
    }
  }
  return out;
}

function parallelPairs(lines, W, H) {
  const S = Math.max(W, H), minL = Math.round(S * 0.05), wMax = Math.max(6, Math.round(S * 0.01)), res = [];
  for (const horiz of [false, true]) {
    const A = horiz ? H : W, B = horiz ? W : H, at = (a, b) => horiz ? a * W + b : b * W + a;
    const segs = [];
    for (let a = 0; a < A; a++) {
      const out = []; let s = -1, e = -1, gap = 0;
      for (let b = 0; b <= B; b++) {
        const on = b < B && lines[at(a, b)];
        if (on) { if (s < 0) s = b; e = b; gap = 0; }
        else if (s >= 0 && ++gap > 2) { if (e + 1 - s >= minL) out.push([s, e + 1]); s = -1; gap = 0; }
      }
      segs.push(out);
    }
    for (let a = 0; a < A; a++) for (const [p0, p1] of segs[a]) {
      for (let d = 3; d <= wMax + 1 && a + d < A; d++) {
        const q = segs[a + d].find(([q0, q1]) => Math.min(p1, q1) - Math.max(p0, q0) >= minL); if (!q) continue;
        const o0 = Math.max(p0, q[0]), o1 = Math.min(p1, q[1]);
        let ink = 0, mid = false, rows = 0;
        for (let k = a + 1; k < a + d; k++) { let c = 0; for (let b = o0; b < o1; b++) c += lines[at(k, b)]; if (c > (o1 - o0) * 0.8) mid = true; ink += c; }
        if (mid) break;
        for (let b = o0; b < o1; b++) for (let k = a + 1; k < a + d; k++) if (lines[at(k, b)]) { rows++; break; }
        const r = ink / ((d - 1) * (o1 - o0));
        if (r >= 0.15 && r <= 0.75 && rows >= (o1 - o0) * 0.8) res.push({ horiz, a0: a, a1: a + d, b0: o0, b1: o1 });
        break;
      }
    }
  }
  return res;
}

function morph(m, W, H, r, erode, edgeFilled = false) {
  const pass = (src, len, count, at) => {
    const out = new Uint8Array(W * H), k = 2 * r + 1;
    for (let a = 0; a < count; a++) {
      let s = 0;
      for (let b = -r; b < len + r; b++) {
        if (b + r < len) s += src[at(a, b + r)];
        if (b - r - 1 >= 0) s -= src[at(a, b - r - 1)];
        const need = edgeFilled ? Math.min(b + r, len - 1) - Math.max(b - r, 0) + 1 : k;
        if (b >= 0 && b < len) out[at(a, b)] = erode ? (s === need ? 1 : 0) : (s > 0 ? 1 : 0);
      }
    }
    return out;
  };
  const h = pass(m, W, H, (y, x) => y * W + x);
  return pass(h, H, W, (x, y) => y * W + x);
}

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
  let far = 0, fd = -1;
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]); if (d > fd) { fd = d; far = i; } });
  const a = dp(pts.slice(0, far + 1)), b = dp([...pts.slice(far), pts[0]]);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function orthogonalize(pts) {
  const n = pts.length, next = i => pts[(i + 1) % n];
  const kind = pts.map((a, i) => { const b = next(i), dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return dy <= dx * 0.07 ? 'h' : dx <= dy * 0.07 ? 'v' : ''; });
  const val = pts.map((a, i) => kind[i] === 'h' ? (a[1] + next(i)[1]) / 2 : kind[i] === 'v' ? (a[0] + next(i)[0]) / 2 : 0);
  const out = pts.map((p, i) => {
    let [x, y] = p;
    for (const e of [(i - 1 + n) % n, i]) { if (kind[e] === 'h') y = val[e]; else if (kind[e] === 'v') x = val[e]; }
    return [x, y];
  });
  return out.filter((p, i) => {
    const a = out[(i - 1 + n) % n], b = out[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return Math.hypot(p[0] - a[0], p[1] - a[1]) >= 0.5 && Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 0.5 * L;
  });
}

function bridgeWindows(K, light, W, H) {
  const S = Math.max(W, H), L = Math.round(S * 0.1), R = Math.round(S * 0.012), C = new Uint8Array(W * H);
  const pass = (vertical) => {
    const n = vertical ? W : H, len = vertical ? H : W, at = (a, b) => vertical ? b * W + a : a * W + b;
    const sup = morph1(light, W, H, R, !vertical);
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

  const inner = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (out[i] && D[i] > t) inner[i] = 1;

  const P = Math.max(t * 2, Math.round(S * 0.015)), { lab, list } = components(inner, W, H), attached = new Uint8Array(list.length + 1);
  for (let i = 0; i < N; i++) if (lab[i] && D[i] === t + 1) attached[lab[i]] = 1;
  const deep = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (inner[i] && D[i] > t + P) deep[i] = 1;
  const rv = morph1(deep, W, H, P, true), rh = morph1(deep, W, H, P, false);
  const root = new Uint8Array(N); for (let i = 0; i < N; i++) root[i] = rv[i] | rh[i];
  for (let i = 0; i < N; i++) if (inner[i] && D[i] <= t + P && attached[lab[i]] && !root[i]) out[i] = 0;
  out.F = F; out.t = t;
  return out;
}

function thinWalls(K, raw, F, W, H) {
  const S = Math.max(W, H), N = W * H, Lr = Math.round(S * 0.02), near = morph(K, W, H, 2, false);
  const thin = new Uint8Array(N);
  for (let i = 0; i < N; i++) thin[i] = raw[i] && !near[i] && F && F[i] ? 1 : 0;

  const open1 = vertical => { const e = new Uint8Array(N), n = vertical ? W : H, len = vertical ? H : W, at = (a, b) => vertical ? b * W + a : a * W + b;
    for (let a = 0; a < n; a++) { let run = 0; for (let b = 0; b <= len; b++) { if (b < len && thin[at(a, b)]) { run++; continue; }
      if (run >= 2 * Lr + 1) for (let k = b - run; k < b; k++) e[at(a, k)] = 1; run = 0; } }
    return e; };

  const maxT = Math.max(6, Math.round(S * 0.004)), cand = [];
  for (const vertical of [false, true]) {
    const { lab, list } = components(open1(vertical), W, H);
    for (const c of list) if ((vertical ? c.x1 - c.x0 : c.y1 - c.y0) + 1 <= maxT) cand.push({ ...c, lab, h: !vertical });
  }

  const len = c => c.h ? c.x1 - c.x0 : c.y1 - c.y0, pos = c => c.h ? (c.y0 + c.y1) / 2 : (c.x0 + c.x1) / 2;
  const span = c => c.h ? [c.x0, c.x1] : [c.y0, c.y1], drop = new Set();
  for (const c of cand) {
    const grp = cand.filter(d => d.h === c.h && Math.abs(len(d) - len(c)) <= len(c) * 0.15
      && Math.min(span(c)[1], span(d)[1]) - Math.max(span(c)[0], span(d)[0]) >= len(c) * 0.8).sort((a, b) => pos(a) - pos(b));
    if (grp.length < 4) continue;
    const gaps = grp.slice(1).map((d, i) => pos(d) - pos(grp[i])).sort((a, b) => a - b);
    if (gaps[gaps.length >> 1] < len(c) * 0.35) grp.forEach(d => drop.add(d));
  }

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

  const r = Math.max(4, Math.round(S * 0.005)), thick = Math.max(1, Math.round(S * 0.0015));
  const closedA = morph(morph(A, W, H, r, false), W, H, r, true), wide = morph(closedA, W, H, thick, false), out = K.slice();
  for (let i = 0; i < N; i++) if (wide[i] && F[i]) out[i] = 1;
  out.F = F;
  return out;
}

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

function schematize(K, F, tExt, W, H) {
  const S = Math.max(W, H), N = W * H;

  const loops = traceLoops(F, W, H).sort((a, b) => b.length - a.length);
  const outline = orthogonalize(simplifyLoop(loops[0], Math.max(3, S * 0.006)));
  const F2 = fillPolygon(outline, W, H), D = distOut(F2, W, H);
  const ring = new Uint8Array(N), I = new Uint8Array(N);
  for (let i = 0; i < N; i++) { if (F2[i] && D[i] <= tExt) ring[i] = 1; else if (K[i] && F2[i]) I[i] = 1; }

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
      if (len < t * 2 || len < S * 0.01) continue;
      let sum = 0, n = 0;
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * W + x] === c.id) { sum += horiz ? y : x; n++; }
      const mid = sum / n + 0.5;
      bars.push({ seg: horiz ? [c.x0, mid, c.x1 + 1, mid] : [mid, c.y0, mid, c.y1 + 1], t, t0: t, horiz });
    }
  }

  const ts = bars.flatMap(b => Array(Math.max(1, Math.round(Math.hypot(b.seg[2] - b.seg[0], b.seg[3] - b.seg[1]) / 10))).fill(b.t)).sort((a, b) => a - b);
  const tInt = Math.min(tExt, Math.max(3, Math.round(S * 0.004), ts.length ? ts[ts.length >> 1] : tExt * 0.6));
  bars.forEach(b => { b.t = tInt; });

  const tE = Math.max(tExt, tInt);
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
  joinEnds(bars);

  const cover = new Uint8Array(N);
  for (const b of bars) {
    const [x1, y1, x2, y2] = b.seg, r = Math.ceil(Math.max(b.t0, b.t) / 2) + 2;
    for (let y = Math.floor(Math.min(y1, y2) - r); y <= Math.ceil(Math.max(y1, y2) + r); y++) for (let x = Math.floor(Math.min(x1, x2) - r); x <= Math.ceil(Math.max(x1, x2) + r); x++)
      if (x >= 0 && y >= 0 && x < W && y < H) cover[y * W + x] = 1;
  }
  const rest = new Uint8Array(N); for (let i = 0; i < N; i++) rest[i] = I[i] && !cover[i] ? 1 : 0;

  const wallNear = new Uint8Array(N); for (let i = 0; i < N; i++) wallNear[i] = ring[i] | cover[i];
  const touch = morph(wallNear, W, H, 3, false);
  const blobs = new Uint8Array(N), R = components(rest, W, H);
  for (const c of R.list) {
    if (c.area < (tInt * 1.5) ** 2) continue;
    let attached = false;
    for (let y = c.y0; y <= c.y1 && !attached; y++) for (let x = c.x0; x <= c.x1; x++) if (R.lab[y * W + x] === c.id && touch[y * W + x]) { attached = true; break; }

    const solid = c.area >= (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) * 0.75;
    let big = c.area >= (tInt * 5) ** 2;
    if (solid) big = false;
    if (big) {
      const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, sub = new Uint8Array(bw * bh);
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (R.lab[y * W + x] === c.id) sub[(y - c.y0) * bw + x - c.x0] = 1;
      const Dd = distOut(sub, bw, bh); let mx = 0; for (let i = 0; i < bw * bh; i++) if (Dd[i] > mx) mx = Dd[i];
      big = mx <= Math.max(tExt, tInt * 1.5) / 2 + 2 && c.area < bw * bh * 0.5 && Math.max(bw, bh) >= tInt * 8;
    }

    const pillar = c.area >= (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) * 0.9 && Math.max(c.x1 - c.x0, c.y1 - c.y0) + 1 <= Math.max(tExt, tInt * 2) * 6 && c.area >= (tInt * 2) ** 2;
    if (!attached || !(pillar || big)) continue;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (R.lab[y * W + x] === c.id) blobs[y * W + x] = 1;
  }

  const inside = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < W && y < H && F2[y * W + x] === 1; };
  const extSegs = outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    const sgn = inside((a[0] + b[0]) / 2 + nx * (tE / 2 + 1), (a[1] + b[1]) / 2 + ny * (tE / 2 + 1)) ? 1 : -1, o = sgn * tE / 2;
    return { seg: [a[0] + nx * o, a[1] + ny * o, b[0] + nx * o, b[1] + ny * o], t: tE, ext: true };
  });
  return { ring, bars, blobs, F2, extSegs };
}

function connectWalls(bars, ring, W, H, gapMax, reachMax, light = null) {
  const axis = b => Math.abs(b.seg[1] - b.seg[3]) < 0.5 ? 'h' : Math.abs(b.seg[0] - b.seg[2]) < 0.5 ? 'v' : '';
  const line = b => axis(b) === 'h' ? b.seg[1] : b.seg[0], span = b => axis(b) === 'h' ? [Math.min(b.seg[0], b.seg[2]), Math.max(b.seg[0], b.seg[2])] : [Math.min(b.seg[1], b.seg[3]), Math.max(b.seg[1], b.seg[3])];

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
      if (touchesEnd(b, end)) {
        let best = null;
        for (const o of bars) {
          if (o === b || !axis(o) || axis(o) === ax) continue;
          const [p0, p1] = span(o), lat = ax === 'h' ? ey : ex, along = ax === 'h' ? ex : ey, dir = ax === 'h' ? ux : uy;
          if (lat < p0 - o.t / 2 || lat > p1 + o.t / 2) continue;
          const dd = (line(o) - along) * dir;
          if (dd > o.t / 2 + b.t / 2 + 2 && dd <= b.t * 2.5 + o.t / 2 && (!best || dd < best.dd)) best = { o, dd };
        }
        if (best) { const k = best.dd; if (end) { b.seg[2] = ex + ux * k; b.seg[3] = ey + uy * k; } else { b.seg[0] = ex + ux * k; b.seg[1] = ey + uy * k; } }
        continue;
      }

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

  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i], L = Math.hypot(b.seg[2] - b.seg[0], b.seg[3] - b.seg[1]);

    const mid = [0.25, 0.5, 0.75].some(f => { const x = b.seg[0] + (b.seg[2] - b.seg[0]) * f, y = b.seg[1] + (b.seg[3] - b.seg[1]) * f;
      return bars.some(o => o !== b && Math.min(Math.hypot(o.seg[0] - x, o.seg[1] - y), Math.hypot(o.seg[2] - x, o.seg[3] - y)) <= b.t + o.t); });
    const e0 = touchesEnd(b, 0), e1 = touchesEnd(b, 1);
    if (!e0 && !e1 && !mid && L < gapMax * 3) bars.splice(i, 1);

    else if (e0 !== e1 && !mid && L < gapMax / 1.3 * 0.9) bars.splice(i, 1);
  }

  const pxM = gapMax / 1.3, stubs = [];
  for (const b of bars) {
    const ax = axis(b), [s0, s1] = ax ? span(b) : [0, 0];
    if (!ax || s1 - s0 >= pxM * 1.5) continue;
    const t0 = touchesEnd(b, 0), t1 = touchesEnd(b, 1);
    if (t0 === t1) continue;
    const base = (ax === 'h' ? (t0 ? b.seg[0] : b.seg[2]) : (t0 ? b.seg[1] : b.seg[3]));
    stubs.push({ b, ax, L: s1 - s0, base, side: t0 ? 0 : 1, pos: line(b) });
  }
  const drop = new Set();
  for (const s of stubs) {
    if (drop.has(s.b)) continue;
    const grp = stubs.filter(o => o.ax === s.ax && o.side === s.side && Math.abs(o.base - s.base) <= Math.max(s.b.t, o.b.t) * 2 && Math.abs(o.L - s.L) <= Math.max(s.L, o.L) * 0.25)
      .sort((p, q) => p.pos - q.pos);

    let run = [grp[0]];
    const flush = () => { if (run.length >= 3) run.forEach(o => drop.add(o.b)); };
    for (let k = 1; k < grp.length; k++) {
      const g = grp[k].pos - grp[k - 1].pos;
      if (g >= pxM * 0.5 && g <= pxM * 2.5) run.push(grp[k]); else { flush(); run = [grp[k]]; }
    }
    flush();
  }
  for (let i = bars.length - 1; i >= 0; i--) if (drop.has(bars[i])) bars.splice(i, 1);
  joinEnds(bars);
  return bars;
}

function detectDoors(segs, lines, W, H, pxPerM = 0, K = null) {
  const S = Math.max(W, H), L1 = morph(lines, W, H, 1, false), doors = [];
  const on = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < W && y < H && L1[y * W + x] === 1; };
  const isWall = (x, y) => { if (!K) return false; x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < W && y < H && K[y * W + x] === 1; };

  const rMin = Math.round(pxPerM ? pxPerM * 0.65 : S * 0.025), rMax = Math.round(pxPerM ? pxPerM * 1.25 : S * 0.08);
  const A = Array.from({ length: 18 }, (_, i) => 0.12 + i * (1.33 / 17));
  const IN = [[0.5, 0.45], [0.5, 0.8], [0.5, 1.15], [0.7, 0.6], [0.7, 1.0], [0.35, 0.8]];
  segs.forEach((sg, si) => {
    const [x1, y1, x2, y2] = sg.seg, L = Math.hypot(x2 - x1, y2 - y1);
    if (L < rMin) return;
    const ux = (x2 - x1) / L, uy = (y2 - y1) / L, nx = -uy, ny = ux, found = [];
    for (let s = -rMax; s <= L + rMax; s += 2) {
      if (found.some(f => Math.abs(f.s - s) < f.r * 0.8)) continue;
      let best = null, px = 0, py = 0;
      for (const off of [0, (sg.t || 0) / 2, -(sg.t || 0) / 2]) {
      const qx = x1 + ux * s + nx * off, qy = y1 + uy * s + ny * off;

      const sides = [1, -1].filter(dn => [0.4, 0.6, 0.85].every(q => on(qx + dn * nx * rMin * q, qy + dn * ny * rMin * q)));
      if (sides.length) for (let r = rMin; r <= rMax; r += 2) for (const du of [1, -1]) for (const dn of sides) {
        const pt = (q, a) => [qx + q * (Math.cos(a) * du * ux + Math.sin(a) * dn * nx), qy + q * (Math.cos(a) * du * uy + Math.sin(a) * dn * ny)];
        let hit = 0, arcWall = 0;
        for (const a of A) { const [ax, ay] = pt(r, a); if (on(ax, ay)) hit++; if (a > 0.35 && a < 1.22 && isWall(ax, ay)) arcWall++; }
        if (hit < A.length - 1 || arcWall > 2) continue;
        let leaf = 0, onWall = 0;
        for (let q = 0.3; q <= 0.95; q += 0.05) { const [lx, ly] = pt(r * q, Math.PI / 2); if (on(lx, ly)) leaf++; if (isWall(lx, ly)) onWall++; }
        if (leaf < 12 || onWall > 6) continue;
        let busy = 0;
        for (const [q, a] of IN) if (on(...pt(r * q, a))) busy++;
        if (busy > 1) continue;
        if (!best || hit > best.hit || (hit === best.hit && r > best.r)) { best = { hit, r, du, dn }; px = qx; py = qy; }
      }
      if (best) break;
      }
      if (best) found.push({ s, r: best.r, du: best.du, dn: best.dn, px, py });
    }
    found.forEach(f => doors.some(o => Math.hypot(o.p[0] - f.px, o.p[1] - f.py) < f.r * 0.3) || doors.push(
      { si, p: [f.px, f.py], u: [f.du * ux, f.du * uy], n: [f.dn * nx, f.dn * ny], r: f.r, ext: !!sg.ext, t: sg.t,
      lo: f.du > 0 ? f.s : f.s - f.r, hi: f.du > 0 ? f.s + f.r : f.s }));
  });
  return doors;
}

function snakeOrder(g, m) {
  const c = s => [(s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2], size = s => Math.max(s.x1 - s.x0, s.y1 - s.y0);
  let hPairs = 0, vPairs = 0;
  for (const a of g) for (const b of g) {
    if (a === b) continue;
    const [ax, ay] = c(a), [bx, by] = c(b), d = (size(a) + size(b)) / 2 * 1.15;
    if (Math.abs(ay - by) < d * 0.3 && Math.abs(ax - bx) < d) hPairs++;
    if (Math.abs(ax - bx) < d * 0.3 && Math.abs(ay - by) < d) vPairs++;
  }
  const rows = hPairs >= vPairs, key = s => rows ? c(s)[1] : -c(s)[0], along = s => rows ? -c(s)[0] : c(s)[1];
  const tol = m * 0.4, lines = [];
  for (const s of [...g].sort((a, b) => key(a) - key(b))) {
    const L = lines.find(l => Math.abs(key(l[0]) - key(s)) <= tol);
    if (L) L.push(s); else lines.push([s]);
  }
  return lines.flatMap((l, i) => l.sort((a, b) => (along(a) - along(b)) * (i % 2 ? -1 : 1)));
}

function wallRaster(ring, bars, W, H) {
  const WM = ring.slice();
  for (const b of bars) {
    const [x1, y1, x2, y2] = b.seg, r = b.t / 2 + 1, L = Math.hypot(x2 - x1, y2 - y1) || 1;
    for (let q = 0; q <= L; q += 0.7) for (let o = -r; o <= r; o += 0.7) {
      const x = Math.round(x1 + (x2 - x1) * q / L - (y2 - y1) / L * o), y = Math.round(y1 + (y2 - y1) * q / L + (x2 - x1) / L * o);
      if (x >= 0 && y >= 0 && x < W && y < H) WM[y * W + x] = 1;
    }
  }
  return WM;
}

function detectSeats(P, SC, bars, doors, pxPerM) {
  const { W, H } = P, light = P.fine || P.light, N = W * H, m = pxPerM || Math.max(W, H) / 15, F = SC.F2, WM = wallRaster(SC.ring, bars, W, H);

  const LC = components(light, W, H), small = new Uint8Array(LC.list.length + 1);
  for (const c of LC.list) if (Math.max(c.x1 - c.x0, c.y1 - c.y0) < m * 0.2) small[c.id] = 1;
  const big = new Uint8Array(N); for (let i = 0; i < N; i++) big[i] = light[i] && !small[LC.lab[i]] ? 1 : 0;
  const nearWall = morph(WM, W, H, 2, false), ink = morph(big, W, H, 1, false);
  const free = new Uint8Array(N); for (let i = 0; i < N; i++) free[i] = F[i] && !ink[i] && !nearWall[i] ? 1 : 0;
  const { list } = components(free, W, H);
  const inkAt = (x, y) => x >= 0 && y >= 0 && x < W && y < H && light[y * W + x] && !WM[y * W + x];

  const side = (c, k, d) => {
    let hit = 0, tot = 0;
    const [ax, ay, bx, by] = k === 0 ? [c.x0, c.y0 - d, c.x1, c.y0 - 3] : k === 1 ? [c.x0, c.y1 + 3, c.x1, c.y1 + d] : k === 2 ? [c.x0 - d, c.y0, c.x0 - 3, c.y1] : [c.x1 + 3, c.y0, c.x1 + d, c.y1];
    for (let y = Math.round(ay); y <= by; y += 2) for (let x = Math.round(ax); x <= bx; x += 2) { tot++; if (inkAt(x, y)) hit++; }
    return tot ? hit / tot : 0;
  };
  const seats = [], tables = [];
  for (const c of list) {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1, lo = Math.min(w, h), hi = Math.max(w, h), fill = c.area / (w * h);
    if (lo >= m * 0.45 && hi <= m * 1.7 && fill >= 0.75) {
      const dens = [0, 1, 2, 3].map(k => side(c, k, m * 0.6));
      if (Math.max(...dens) < 0.06) continue;

      const sz = Math.max(m * 0.6, Math.min(hi, m * 0.95)), cxm = (c.x0 + c.x1 + 1) / 2, cym = (c.y0 + c.y1 + 1) / 2;
      let x0 = cxm - sz / 2, y0 = cym - sz / 2;
      if (sz > h) y0 = dens[0] >= dens[1] ? c.y1 + 1 - sz : c.y0;
      if (sz > w) x0 = dens[2] >= dens[3] ? c.x1 + 1 - sz : c.x0;
      seats.push({ x0, y0, x1: x0 + sz, y1: y0 + sz, desk: true });
    } else if (hi >= m * 1.7 && hi <= m * 5 && lo >= m * 0.5 && lo <= m * 1.6 && fill >= 0.55) {
      const horiz = w >= h, sides = horiz ? [0, 1] : [2, 3], withChairs = sides.filter(k => side(c, k, m * 0.6) >= 0.06);
      if (!withChairs.length) continue;
      const bd = 3;
      const tb = { x0: c.x0 - bd, y0: c.y0 - bd, x1: c.x1 + 1 + bd, y1: c.y1 + 1 + bd }; tables.push(tb);

      const n = Math.max(1, Math.round(hi / (m * 0.8))), sz = Math.min(m * 0.95, hi / n * 0.97);
      for (const k of withChairs) for (let i = 0; i < n; i++) {
        const mid = (horiz ? c.x0 : c.y0) + hi * (i + 0.5) / n, a0 = mid - sz / 2, a1 = mid + sz / 2;
        const edge = k === 0 ? c.y0 : k === 1 ? c.y1 + 1 : k === 2 ? c.x0 : c.x1 + 1, b0 = edge - sz / 2;
        seats.push(horiz ? { x0: a0, y0: b0, x1: a1, y1: b0 + sz, tbl: { tb, k, i, n, horiz } } : { x0: b0, y0: a0, x1: b0 + sz, y1: a1, tbl: { tb, k, i, n, horiz } });
      }
    }
  }

  const desks = seats.filter(a => a.desk && !a.filled), deskSz = desks.map(a => Math.max(a.x1 - a.x0, a.y1 - a.y0)).sort((a, b) => a - b);
  if (deskSz.length >= 3) {
    const sz = deskSz[deskSz.length >> 1], gaps = [];
    for (const a of desks) for (const b of desks) {
      if (a === b) continue;
      const ax = (a.x0 + a.x1) / 2, ay = (a.y0 + a.y1) / 2, bx = (b.x0 + b.x1) / 2, by = (b.y0 + b.y1) / 2;
      const d = Math.abs(ay - by) < sz * 0.25 ? Math.abs(ax - bx) : Math.abs(ax - bx) < sz * 0.25 ? Math.abs(ay - by) : Infinity;
      if (d < sz * 1.5 && d - sz >= 0 && d - sz <= sz * 0.4) gaps.push(d - sz);
    }
    gaps.sort((a, b) => a - b);
    const gap = gaps.length ? gaps[gaps.length >> 1] : sz * 0.09, pitch = sz + gap, ovl = sz * 0.4;
    const wallAt = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < W && y < H && WM[y * W + x]; };
    for (const tb of new Set(seats.filter(a => a.tbl).map(a => a.tbl.tb))) {
      const row = seats.filter(a => a.tbl && a.tbl.tb === tb), horiz = row[0].tbl.horiz, n = row[0].tbl.n;
      const lo = horiz ? tb.x0 : tb.y0, hi = horiz ? tb.x1 : tb.y1, mid = horiz ? (tb.y0 + tb.y1) / 2 : (tb.x0 + tb.x1) / 2, len = n * pitch - gap;
      const near = v => [3, 6, 10].some(o => horiz ? wallAt(v, mid) || wallAt(v - o, mid) || wallAt(v + o, mid) : wallAt(mid, v) || wallAt(mid, v - o) || wallAt(mid, v + o));
      const start = near(lo) ? lo + gap : near(hi) ? hi - gap - len : (lo + hi) / 2 - len / 2;
      for (const a of row) {
        const { k, i } = a.tbl, s0 = start + i * pitch;
        const b0 = k === 0 ? tb.y0 + ovl - sz : k === 1 ? tb.y1 - ovl : k === 2 ? tb.x0 + ovl - sz : tb.x1 - ovl;
        Object.assign(a, horiz ? { x0: s0, y0: b0, x1: s0 + sz, y1: b0 + sz } : { x0: b0, y0: s0, x1: b0 + sz, y1: s0 + sz });
      }
      const e0 = Math.min(lo, start), e1 = Math.max(hi, start + len + (near(lo) ? gap : 0));
      if (horiz) { tb.x0 = e0; tb.x1 = e1; } else { tb.y0 = e0; tb.y1 = e1; }
    }
  }

  if (P.gray) {
    const G = components(P.gray, W, H), box = [];
    for (const c of G.list) {
      const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
      if (Math.min(w, h) >= m * 0.3 && Math.max(w, h) <= m * 2 && Math.max(w, h) <= Math.min(w, h) * 1.6 && c.area >= w * h * 0.85 && F[((c.y0 + c.y1) >> 1) * W + ((c.x0 + c.x1) >> 1)])
        box.push({ x0: c.x0, y0: c.y0, x1: c.x1 + 1, y1: c.y1 + 1, sz: Math.max(w, h), desk: true, filled: true });
    }
    for (const b of box) if (box.filter(o => Math.abs(o.sz - b.sz) <= b.sz * 0.2).length >= 3) seats.push(b);
  }

  seats.sort((a, b) => (b.filled ? 2 : b.desk ? 1 : 0) - (a.filled ? 2 : a.desk ? 1 : 0));
  for (let i = seats.length - 1; i >= 0; i--) {
    const a = seats[i], ar = (a.x1 - a.x0) * (a.y1 - a.y0);
    if (seats.some((o, j) => j < i && Math.max(0, Math.min(a.x1, o.x1) - Math.max(a.x0, o.x0)) * Math.max(0, Math.min(a.y1, o.y1) - Math.max(a.y0, o.y0)) > ar * 0.3)) seats.splice(i, 1);
  }

  const onWallFrac = r => { let hit = 0, tot = 0; for (let y = Math.round(r.y0); y < r.y1; y += 2) for (let x = Math.round(r.x0); x < r.x1; x += 2) { tot++; if (x >= 0 && y >= 0 && x < W && y < H && WM[y * W + x]) hit++; } return tot ? hit / tot : 1; };
  for (let i = seats.length - 1; i >= 0; i--) if (!seats[i].desk && onWallFrac(seats[i]) > 0.15) seats.splice(i, 1);
  for (let i = tables.length - 1; i >= 0; i--) if (onWallFrac(tables[i]) > 0.15) tables.splice(i, 1);

  for (let i = seats.length - 1; i >= 0; i--) {
    const a = seats[i], cx0 = (a.x0 + a.x1) / 2, cy0 = (a.y0 + a.y1) / 2;
    if (doors.some(d => { const vx = cx0 - d.p[0], vy = cy0 - d.p[1];
      return Math.hypot(vx, vy) <= d.r * 1.05 && vx * d.u[0] + vy * d.u[1] >= -d.r * 0.1 && vx * d.n[0] + vy * d.n[1] >= -d.r * 0.1; })) seats.splice(i, 1);
  }

  if (seats.length >= 4) {
    const sz = seats.map(a => Math.max(a.x1 - a.x0, a.y1 - a.y0)).sort((a, b) => a - b), med = sz[sz.length >> 1];
    for (let i = seats.length - 1; i >= 0; i--) if (Math.max(seats[i].x1 - seats[i].x0, seats[i].y1 - seats[i].y0) < med * 0.6) seats.splice(i, 1);
  }

  for (let i = seats.length - 1; i >= 0; i--) {
    const a = seats[i]; if (!a.desk || a.filled) continue;
    const ax = (a.x0 + a.x1) / 2, ay = (a.y0 + a.y1) / 2;
    const ok = seats.some(o => { if (o === a) return false; const ox = (o.x0 + o.x1) / 2, oy = (o.y0 + o.y1) / 2;
      return Math.hypot(ox - ax, oy - ay) <= m * 1.6 && (Math.abs(ox - ax) <= m * 0.25 || Math.abs(oy - ay) <= m * 0.25); });
    if (!ok) seats.splice(i, 1);
  }

  const room = new Uint8Array(N); for (let i = 0; i < N; i++) room[i] = F[i] && !WM[i] ? 1 : 0;
  const R = components(room, W, H), roomOf = s => { const x = Math.round((s.x0 + s.x1) / 2), y = Math.round((s.y0 + s.y1) / 2); return x >= 0 && y >= 0 && x < W && y < H ? R.lab[y * W + x] : 0; };
  const groups = new Map();
  for (const s of seats) { const id = roomOf(s); if (!id) continue; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(s); }
  const ordered = [...groups.values()].map(g => ({ g, y: Math.min(...g.map(s => s.y0)), x: Math.min(...g.map(s => s.x0)) }))
    .sort((a, b) => Math.abs(a.y - b.y) > m * 0.5 ? a.y - b.y : a.x - b.x);
  const out = [];
  ordered.forEach(({ g }, gi) => {
    const letter = String.fromCharCode(65 + (gi % 26));
    snakeOrder(g, m).forEach((s, i) => out.push({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, zone: gi + 1, label: letter + String(i + 1).padStart(2, '0') }));
  });
  return { seats: out, tables };
}

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
        if (Math.abs(cross) < 0.5) return;
        const t = ((a - px) * vy - (b - py) * vx) / cross;
        const q = ((px + ux * t - a) * vx + (py + uy * t - b) * vy);
        const reach = Math.max(r.t, o.t) * 1.5 + 3;
        if (Math.abs(t) > reach || q < -reach || q > M + reach) return;
        if (!best || Math.abs(t) < Math.abs(best.t)) best = { t, o, sin: Math.abs(cross) };
      });
      if (!best) return;

      const go = best.t + dir * best.o.t / 2 / best.sin, nx = px + ux * go, ny = py + uy * go;
      if (dir < 0) { fixed[i][0] = nx; fixed[i][1] = ny; } else { fixed[i][2] = nx; fixed[i][3] = ny; }
    });
  });
  segs.forEach((r, i) => { r.seg = fixed[i]; });
}

function autoExtent(P) {
  const { W, H } = P, S = Math.max(W, H), minArea = (S * 0.007) ** 2, gap = S * 0.05;
  P.comp = P.comp || components(P.wall, W, H);
  const cs = P.comp.list.filter(c => c.area >= minArea).sort((a, b) => b.area - a.area);
  if (P.photo) throw new Error('도면이 아닌 것 같습니다. 벽이 그려진 평면도 이미지를 올려 주세요');
  if (!cs.length) throw new Error('벽을 찾지 못했습니다');

  const total = cs.reduce((q, c) => q + c.area, 0);
  if (cs.length >= 8 && cs[0].area < total * 0.1) throw new Error('도면이 아닌 것 같습니다. 벽이 그려진 평면도 이미지를 올려 주세요');
  let box = [cs[0].x0, cs[0].y0, cs[0].x1, cs[0].y1], grew = true;
  const used = new Set([cs[0]]);
  while (grew) {
    grew = false;
    for (const c of cs) if (!used.has(c) && c.x0 <= box[2] + gap && c.x1 >= box[0] - gap && c.y0 <= box[3] + gap && c.y1 >= box[1] - gap) {
      used.add(c); box = [Math.min(box[0], c.x0), Math.min(box[1], c.y0), Math.max(box[2], c.x1), Math.max(box[3], c.y1)]; grew = true;
    }
  }
  return { extent: [box[1] / H * 1000, box[0] / W * 1000, box[3] / H * 1000, box[2] / W * 1000] };
}

function traceToPlan(w, P, widthM = 0) {
  const { W, H, wall } = P, S = Math.max(W, H);
  const ex = [w.extent[1] / 1000 * W, w.extent[0] / 1000 * H, w.extent[3] / 1000 * W, w.extent[2] / 1000 * H];
  const pad = S * 0.03, inEx = (x, y) => x >= ex[0] - pad && x <= ex[2] + pad && y >= ex[1] - pad && y <= ex[3] + pad;

  P.comp = P.comp || components(wall, W, H);
  const { lab, list } = P.comp, keepId = new Uint8Array(list.length + 1);
  const minArea = (S * 0.007) ** 2, minDim = S * 0.008;
  list.forEach(c => { if (c.area >= minArea && Math.max(c.x1 - c.x0, c.y1 - c.y0) >= minDim && inEx((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)) keepId[c.id] = 1; });
  const K0 = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lab[i] && keepId[lab[i]]) K0[i] = 1;
  const KE = closeExterior(bridgeWindows(K0, P.light, W, H), W, H);

  const K = P.tone && !P.tone.dark ? thinWalls(KE, P.raw, KE.F, W, H) : KE;

  const SC = schematize(K, KE.F, KE.t, W, H);

  let bars = SC.bars;

  let fx0 = W, fx1 = 0;
  for (let i = 0; i < W * H; i++) if (SC.F2[i]) { const x = i % W; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; }

  let pxPerM = fx1 > fx0 ? (fx1 - fx0 + 1) / (+widthM > 0 ? +widthM : 15) : S / 15, scaleFrom = +widthM > 0 ? 'input' : 'guess';
  if (!(+widthM > 0)) {
    const pre = detectDoors(bars.concat(SC.extSegs), P.light, W, H, 0, wallRaster(SC.ring, bars, W, H)).map(d => d.r).sort((a, b) => a - b);
    if (pre.length >= 2) { pxPerM = pre[pre.length >> 1] / 1.0; scaleFrom = 'doors'; }
  }
  bars = connectWalls(bars, SC.ring, W, H, pxPerM * 1.3, pxPerM * 0.4, P.light);

  const doors = detectDoors(bars.concat(SC.extSegs), P.light, W, H, pxPerM, wallRaster(SC.ring, bars, W, H));

  const seatInfo = detectSeats(P, SC, bars, doors, pxPerM);

  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < W * H; i++) if (SC.F2[i]) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) throw Object.assign(new Error('도면에서 벽을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });

  const k = +widthM > 0 ? +widthM * 100 / (x1 - x0 + 1) : 100 / pxPerM;
  const cx = v => Math.round((v - x0) * k * 10) / 10, cy = v => Math.round((v - y0) * k * 10) / 10;

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

  const doorOut = doors.map(d => ({ x: cx(d.p[0]), y: cy(d.p[1]), u: d.u, n: d.n, r: Math.round(d.r * k), t: Math.round(d.t * k) }));
  const rect = r => ({ x: cx(r.x0), y: cy(r.y0), w: Math.round((r.x1 - r.x0) * k), h: Math.round((r.y1 - r.y0) * k) });
  const seats = seatInfo.seats.map(r => ({ ...rect(r), label: r.label, zone: r.zone })), tables = seatInfo.tables.map(rect);
  return finalize({ width: Math.round((x1 - x0 + 1) * k), height: Math.round((y1 - y0 + 1) * k), wallThickness: 15, walls, shapes,
    doors: doorOut, seats, tables, scaleFrom, src: { x0, y0, k } });
}

function finalize(p) {
  const W = Math.min(10000, Math.max(200, p.width || 1000)), H = Math.min(10000, Math.max(200, p.height || 1000));
  const cx = v => Math.min(W, Math.max(0, v)), cy = v => Math.min(H, Math.max(0, v));
  const walls = p.walls.map(w => [cx(w[0]), cy(w[1]), cx(w[2]), cy(w[3]), ...w.slice(4, 5)])
    .filter(w => w.every(Number.isFinite) && (w[0] !== w[2] || w[1] !== w[3]));
  const shapes = (p.shapes || []).map(sh => sh.map(l => l.map(([x, y]) => [cx(x), cy(y)])));
  const doors = (p.doors || []).filter(d => [d.x, d.y, d.r].every(Number.isFinite));
  const box = r => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;
  return { width: W, height: H, wallThickness: p.wallThickness, walls, shapes, doors, seats: (p.seats || []).filter(box), tables: (p.tables || []).filter(box), ...(p.scaleFrom ? { scaleFrom: p.scaleFrom } : {}), ...(p.src ? { src: p.src } : {}) };
}

const straighten = ([x1, y1, x2, y2, ...t]) => {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dy) <= Math.abs(dx) * 0.07) { const y = Math.round((y1 + y2) / 2); return [x1, y, x2, y, ...t]; }
  if (Math.abs(dx) <= Math.abs(dy) * 0.07) { const x = Math.round((x1 + x2) / 2); return [x, y1, x, y2, ...t]; }
  return [x1, y1, x2, y2, ...t];
};
