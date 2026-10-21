// 브라우저에서 Gemini API 를 직접 호출해 벽 도면을 만든다 (서버 없음).
// 결과 plan (단위 cm): { width, height, wallThickness,
//   walls: [[x1,y1,x2,y2,두께?]]          선으로 된 벽 (두께가 없으면 wallThickness)
//   shapes: [[고리, 고리, ...]] }           칠해진 벽 모양. 고리 = [[x,y],...], 구멍 포함 evenodd 로 채운다
//
// 참고 도면이 있으면 "옮겨 그리기": 벽 모양은 업로드한 이미지의 벽 픽셀을 그대로 다각형으로 옮기고,
// Gemini 는 건물 영역·벽 위치(0~1000 정규화 좌표)를 알려 줘서 글자·표제란을 걸러 내고 얇은 칸막이·창문 구간을 메운다.
// 참고 도면이 없으면 "설계": 요청 사항에 맞춰 cm 좌표로 직접 설계한다.

const DEFAULT_MODEL = 'gemini-3.8-flash';
const IDLE_MS = 60000;   // 스트림에서 이 시간 동안 아무 데이터도 없으면 멈춘 것으로 보고 재시도
const TOTAL_MS = 240000; // 한 번 요청의 전체 상한
const API = 'https://generativelanguage.googleapis.com/v1beta/';
const ver = n => parseFloat((String(n).match(/gemini-([\d.]+)/) || [0, 0])[1]);

// 이 키로 쓸 수 있는 텍스트 생성 모델 (정식 gemini-X.Y-flash/pro 만, 최신 버전·flash 우선)
async function listModels(key) {
  const res = await fetch(API + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error('모델 목록을 가져오지 못했습니다');
  return ((await res.json()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-[\d.]+-(flash|pro)$/.test(n))
    .sort((a, b) => ver(b) - ver(a) || b.endsWith('flash') - a.endsWith('flash'));
}

// ── 응답 형식 (출력 토큰 수가 곧 응답 시간이라 키를 짧게, 좌표는 숫자 배열) ──
const NUMS = n => ({ type: 'ARRAY', items: { type: 'NUMBER' }, minItems: n, maxItems: n });
const obj = (props, order) => ({ type: 'OBJECT', properties: props, required: order, propertyOrdering: order });

const DESIGN_SCHEMA = obj({
  width: { type: 'NUMBER', description: '매장 전체 가로 (cm)' },
  height: { type: 'NUMBER', description: '매장 전체 세로 (cm)' },
  walls: { type: 'ARRAY', description: '벽 중심선 [x1,y1,x2,y2] (cm)', items: NUMS(4) }
}, ['width', 'height', 'walls']);

const designPrompt = o => `너는 스터디카페/독서실 평면 설계자다. 아래 요청에 맞는 벽 도면을 설계해 JSON 으로 답하라.

- 단위 cm, 원점 좌상단, x 는 오른쪽, y 는 아래쪽. 모든 좌표는 0~width, 0~height 안.
- walls: 벽 중심선 [x1,y1,x2,y2]. 외벽은 매장 테두리를 닫힌 형태로 둘러싼다. 화장실·카운터·룸 등 내부 칸막이 벽도 넣는다. 이어지는 끝점은 같은 좌표로.

[요청]
${o.note}`;

// ── 생각(thinking) 설정: Gemini 3 이상은 thinkingLevel, 2.x 는 thinkingBudget ──
const LEVEL_BUDGET = { low: 1024, medium: 4096, high: -1 };
const thinkingConfig = (model, level) => ver(model) >= 3
  ? { thinkingLevel: level, includeThoughts: true }
  : { thinkingBudget: LEVEL_BUDGET[level], includeThoughts: true };

// ── 스트리밍 요청 하나: JSON 결과를 돌려준다 ──
// onThink(): 생각 데이터가 올 때, onText(전체 텍스트): 결과 텍스트가 올 때, outer: 다른 요청이 실패하면 함께 중단
async function streamJSON({ key, model, parts, schema, level, onThink = () => {}, onText = () => {}, outer, noThink = false }) {
  const config = { responseMimeType: 'application/json', responseSchema: schema };
  if (!noThink) config.thinkingConfig = thinkingConfig(model, level);
  if (ver(model) < 3) config.temperature = 0.2; // Gemini 3 는 기본 온도(1.0) 유지가 권장

  const ctl = new AbortController();
  let idle, timedOut = false;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; ctl.abort(); }, IDLE_MS); };
  const total = setTimeout(() => { timedOut = true; ctl.abort(); }, TOTAL_MS);
  const stop = () => ctl.abort();
  outer?.addEventListener('abort', stop);
  let text = '';
  try {
    kick();
    const res = await fetch(`${API}models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: config }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const raw = await res.text(), data = (() => { try { const d = JSON.parse(raw); return Array.isArray(d) ? d[0] : d; } catch (e) { return {}; } })();
      const m = data.error?.message || String(res.status);
      if (!noThink && res.status === 400 && /thinking/i.test(m)) // 이 모델이 생각 설정을 지원하지 않으면 빼고 다시
        return await streamJSON({ key, model, parts, schema, level, onThink, onText, outer, noThink: true });
      throw apiError(res.status, m, model);
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', finish = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.error) throw apiError(ev.error.code || 500, ev.error.message, model);
        const c = ev.candidates?.[0];
        if (c?.finishReason) finish = c.finishReason;
        for (const part of c?.content?.parts || []) {
          if (part.thought) onThink();
          else if (part.text) { text += part.text; onText(text); }
        }
      }
    }
    if (!text && finish && finish !== 'STOP') throw new Error(`Gemini 가 도면을 만들지 못했습니다 (${finish}). 다시 시도해 주세요`);
  } catch (e) {
    if (outer?.aborted) throw outer.reason || e;
    if (e.name === 'AbortError' || timedOut) throw Object.assign(new Error('Gemini 응답이 멈춰 시간 초과되었습니다'), { busy: true });
    if (e instanceof TypeError) throw new Error('Gemini 에 연결할 수 없습니다 (인터넷 연결 확인)');
    throw e;
  } finally { clearTimeout(idle); clearTimeout(total); outer?.removeEventListener('abort', stop); }

  try { return JSON.parse(text); }
  catch (e) { throw Object.assign(new Error('Gemini 응답을 해석하지 못했습니다. 다시 시도해 주세요'), { busy: true }); }
}

// 옮겨 그리기: Gemini 는 건물 영역과 벽 위치를 알려 주고, 벽 모양은 업로드한 이미지의 픽셀에서 그대로 가져온다
const WALL_SCHEMA = obj({
  extent: { ...NUMS(4), description: '건물(외벽 바깥 테두리) 영역 [ymin, xmin, ymax, xmax], 0~1000 정규화' },
  width_mm: { type: 'NUMBER', description: '치수선에서 읽은 건물 전체 가로 길이 (mm). 모르면 0' },
  walls: { type: 'ARRAY', description: '벽 중심선 [y1, x1, y2, x2], 0~1000 정규화', items: NUMS(4) }
}, ['extent', 'width_mm', 'walls']);

const COORD = '좌표는 이미지 전체를 기준으로 0~1000 으로 정규화한 값이다 (왼쪽 위 0,0 / 오른쪽 아래 1000,1000). y 를 먼저 쓴다.';

const wallPrompt = o => `첨부한 이미지는 스터디카페 건축 평면도다. 벽만 찾아라.
${COORD}

- extent: 건물 외벽의 바깥 테두리를 감싸는 박스. 표제란(오른쪽 제목 칸), 좌석표, 치수선, 도면 이름은 넣지 않는다.
- walls: 각 벽의 중심선을 [y1, x1, y2, x2] 선분으로. 다음을 모두 포함한다:
  · 검게 칠해진 외벽·기둥 사이 벽, 창문 구간(외벽이 얇은 두 줄로 그려진 곳)도 외벽으로 이어서
  · 회색·빨간색으로 칠해진 칸막이 벽, 화장실·창고·스터디룸·카페를 나누는 얇은 벽
- 외벽 윤곽을 한 바퀴 빠짐없이 따라간다. 사선 벽은 사선 그대로. 꺾이는 곳마다 선분을 나누고, 이어지는 선분의 끝점은 같은 좌표로.
- 문은 벽으로 보고 문 자리도 벽을 이어서 그린다.
- 벽이 아닌 것: 책상·의자·책상 칸막이, 변기·싱크대 같은 집기, 문 열림 호, 얇은 치수선, 숫자·글자, 계단, 표제란, 좌석표, 도면 테두리.
- width_mm: 치수선에 적힌 건물 전체 가로 길이(mm, 가장 바깥 치수). 없으면 0.${o.note ? `\n\n[요청]\n${o.note}` : ''}`;

// o: 폼 값, image: dataURL 또는 null, level: low|medium|high, onProgress({ phase: 'think'|'draw'|'refine', count })
async function generatePlan(o, image, key, model, level = 'medium', onProgress = () => {}) {
  const count = (t, re) => (t.match(re) || []).length;
  if (!image) {
    const p = await streamJSON({
      key, model, level, schema: DESIGN_SCHEMA, parts: [{ text: designPrompt(o) }],
      onThink: () => onProgress({ phase: 'think' }), onText: t => onProgress({ phase: 'draw', count: Math.max(0, count(t, /\[/g) - 1) })
    });
    return designToPlan(p);
  }
  const m = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  const [w, px] = await Promise.all([
    streamJSON({
      key, model, level, schema: WALL_SCHEMA, parts: [{ text: wallPrompt(o) }, { inline_data: { mime_type: m[1], data: m[2] } }],
      onThink: () => onProgress({ phase: 'think' }), onText: t => onProgress({ phase: 'draw', count: Math.max(0, count(t, /\[/g) - 2) })
    }),
    readPixels(image).then(wallMasks) // Gemini 를 기다리는 동안 이미지 분석
  ]);
  onProgress({ phase: 'refine' });
  return traceToPlan(w, px);
}

// ── 이미지 픽셀 분석 ──
async function readPixels(dataURL) {
  const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = dataURL; });
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  return { W: im.width, H: im.height, d: g.getImageData(0, 0, im.width, im.height).data };
}

// raw: 진한 무채색 또는 빨간색 픽셀 (벽·칸막이 후보, 글자·선 포함)
// wall: raw 에서 5px 보다 얇은 것(치수선·글자·집기 선)을 지운 것 = 칠해진 벽
function wallMasks({ W, H, d }) {
  const raw = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], av = (r + g + b) / 3, ch = Math.max(r, g, b) - Math.min(r, g, b);
    raw[i] = (av < 140 && ch < 50) || (r > 150 && r - g > 45 && r - b > 45) ? 1 : 0;
  }
  return { W, H, raw, wall: morph(morph(raw, W, H, 2, true), W, H, 2, false) };
}

// 정사각형(2r+1) 침식/팽창. 가로·세로로 나눠 창 안의 1 개수를 세서 빠르게 계산
function morph(m, W, H, r, erode) {
  const pass = (src, len, count, at) => {
    const out = new Uint8Array(W * H), k = 2 * r + 1;
    for (let a = 0; a < count; a++) {
      let s = 0;
      for (let b = -r; b < len + r; b++) {
        if (b + r < len) s += src[at(a, b + r)]; // 창 오른쪽 끝 추가
        if (b - r - 1 >= 0) s -= src[at(a, b - r - 1)]; // 창 왼쪽 끝 제거
        if (b >= 0 && b < len) out[at(a, b)] = erode ? (s === k ? 1 : 0) : (s > 0 ? 1 : 0);
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

// Gemini 결과 + 픽셀 → cm 도면
function traceToPlan(w, P) {
  const { W, H, raw, wall } = P, S = Math.max(W, H);
  const ok4 = a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite);
  const lines = (w.walls || []).filter(ok4).map(([y1, x1, y2, x2]) => [x1 / 1000 * W, y1 / 1000 * H, x2 / 1000 * W, y2 / 1000 * H]);
  // 건물 영역: Gemini 가 준 extent (없으면 벽 선분 범위), 3% 여유
  let ex = ok4(w.extent) ? [w.extent[1] / 1000 * W, w.extent[0] / 1000 * H, w.extent[3] / 1000 * W, w.extent[2] / 1000 * H] : null;
  if (!ex && lines.length) ex = [Math.min(...lines.flatMap(l => [l[0], l[2]])), Math.min(...lines.flatMap(l => [l[1], l[3]])), Math.max(...lines.flatMap(l => [l[0], l[2]])), Math.max(...lines.flatMap(l => [l[1], l[3]]))];
  if (!ex) throw Object.assign(new Error('도면에서 건물을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });
  const pad = S * 0.03, inEx = (x, y) => x >= ex[0] - pad && x <= ex[2] + pad && y >= ex[1] - pad && y <= ex[3] + pad;

  // 1. 칠해진 벽 덩어리 중 건물 영역 안에 있고 충분히 큰 것만 남긴다 (글자·기호 조각 제거)
  const { lab, list } = components(wall, W, H), keepId = new Uint8Array(list.length + 1);
  const minArea = (S * 0.007) ** 2, minDim = S * 0.008;
  list.forEach(c => { if (c.area >= minArea && Math.max(c.x1 - c.x0, c.y1 - c.y0) >= minDim && inEx((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)) keepId[c.id] = 1; });
  const K = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lab[i] && keepId[lab[i]]) K[i] = 1;

  // 2. Gemini 벽 선분: 칠해진 벽에 맞추고(창문 구간 등 메우기), 안 되면 얇은 선에 맞춘다(얇은 칸막이). 근거 픽셀이 없으면 버린다
  const segs = [];
  for (const l of lines) {
    if (!inEx((l[0] + l[2]) / 2, (l[1] + l[3]) / 2)) continue;
    let r = snapWall(l, K, W, H);
    if (r.cov >= 0.85) continue; // 이미 칠해진 벽 모양이 덮고 있으면 선은 필요 없다
    if (r.cov < 0.35) { r = snapWall(l, raw, W, H); if (r.cov < 0.5) continue; r.t = Math.max(r.t, S * 0.004); }
    segs.push(r);
  }

  // 3. 범위·축척: 남은 벽 픽셀과 선분이 차지하는 범위 = 건물 외곽
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < W * H; i++) if (K[i]) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  segs.forEach(({ seg, t }) => { x0 = Math.min(x0, seg[0] - t / 2, seg[2] - t / 2); x1 = Math.max(x1, seg[0] + t / 2, seg[2] + t / 2); y0 = Math.min(y0, seg[1] - t / 2, seg[3] - t / 2); y1 = Math.max(y1, seg[1] + t / 2, seg[3] + t / 2); });
  if (x1 <= x0 || y1 <= y0) throw Object.assign(new Error('도면에서 벽을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });
  // 축척: 도면 치수(mm), 없으면 가로 15m 가정
  const realW = +w.width_mm > 500 ? +w.width_mm / 10 : 1500, k = realW / (x1 - x0 + 1);
  const cx = v => Math.round((v - x0) * k * 10) / 10, cy = v => Math.round((v - y0) * k * 10) / 10;

  // 4. 칠해진 벽 → 다각형(구멍 포함). 덩어리마다 하나의 모양으로 묶는다 (지우개로 한 번에 지울 수 있게)
  const shapes = [];
  list.forEach(c => {
    if (!keepId[c.id]) return;
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, sub = new Uint8Array(bw * bh);
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * W + x] === c.id) sub[(y - c.y0) * bw + x - c.x0] = 1;
    const loops = traceLoops(sub, bw, bh).map(l => simplifyLoop(l, 1.2)).filter(l => l.length >= 3)
      .map(l => l.map(([x, y]) => [cx(x + c.x0), cy(y + c.y0)]));
    if (loops.length) shapes.push(loops);
  });

  const walls = tidyWalls(segs.map(({ seg, t }) => [cx(seg[0]), cy(seg[1]), cx(seg[2]), cy(seg[3]), Math.max(4, Math.round(t * k))]));
  return finalize({ width: Math.round((x1 - x0 + 1) * k), height: Math.round((y1 - y0 + 1) * k), wallThickness: 15, walls, shapes });
}

// 설계 결과(cm) → 도면
function designToPlan(p) {
  const walls = tidyWalls((p.walls || []).filter(a => Array.isArray(a) && a.length === 4).map(a => a.map(Math.round)));
  return finalize({ width: Math.round(p.width), height: Math.round(p.height), wallThickness: 15, walls });
}

// 형식·범위 정리 (Gemini 응답을 그대로 믿지 않는다)
function finalize(p) {
  const W = Math.min(10000, Math.max(200, p.width || 1000)), H = Math.min(10000, Math.max(200, p.height || 1000));
  const cx = v => Math.min(W, Math.max(0, v)), cy = v => Math.min(H, Math.max(0, v));
  const walls = p.walls.map(w => [cx(w[0]), cy(w[1]), cx(w[2]), cy(w[3]), ...w.slice(4, 5)])
    .filter(w => w.every(Number.isFinite) && (w[0] !== w[2] || w[1] !== w[3]));
  const shapes = (p.shapes || []).map(sh => sh.map(l => l.map(([x, y]) => [cx(x), cy(y)])));
  return { width: W, height: H, wallThickness: p.wallThickness, walls, shapes };
}

// 거의 수평·수직인 벽은 똑바로 펴고(4° 이내), 가까운 끝점(20cm 이내)은 하나로 붙여 벽 틈을 없앤다
const straighten = ([x1, y1, x2, y2, ...t]) => { // t: 두께 (있으면 그대로 유지)
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dy) <= Math.abs(dx) * 0.07) { const y = Math.round((y1 + y2) / 2); return [x1, y, x2, y, ...t]; }
  if (Math.abs(dx) <= Math.abs(dy) * 0.07) { const x = Math.round((x1 + x2) / 2); return [x, y1, x, y2, ...t]; }
  return [x1, y1, x2, y2, ...t];
};
function tidyWalls(walls, pass = 2) {
  walls = walls.filter(w => w.every(Number.isFinite)).map(straighten);
  const pts = walls.flatMap(w => [[w[0], w[1]], [w[2], w[3]]]), groups = [];
  pts.forEach(p => {
    const g = groups.find(g => Math.hypot(g.x - p[0], g.y - p[1]) <= 20);
    if (g) { g.list.push(p); g.x = g.list.reduce((s, q) => s + q[0], 0) / g.list.length; g.y = g.list.reduce((s, q) => s + q[1], 0) / g.list.length; }
    else groups.push({ x: p[0], y: p[1], list: [p] });
  });
  groups.forEach(g => g.list.forEach(p => { p[0] = Math.round(g.x); p[1] = Math.round(g.y); }));
  walls = walls.map((w, i) => straighten([pts[2 * i][0], pts[2 * i][1], pts[2 * i + 1][0], pts[2 * i + 1][1], ...w.slice(4)]))
    .filter(w => w[0] !== w[2] || w[1] !== w[3]);
  return pass > 1 ? tidyWalls(walls, pass - 1) : walls; // 펴면서 생긴 모서리의 작은 어긋남을 한 번 더 붙인다
}

function apiError(status, m, model) {
  const busy = status === 503 || status === 500 || /high demand|overloaded|unavailable/i.test(m), quota = status === 429;
  const err = new Error(/API key not valid/i.test(m) ? 'API 키가 올바르지 않습니다'
    : busy ? 'Gemini 사용량이 많아 지금은 생성할 수 없습니다. 1~2분 뒤 다시 시도해 주세요'
    : quota ? 'Gemini 사용 한도를 넘었습니다. 잠시 후 다시 시도하거나 다른 모델을 선택해 주세요'
    : 'Gemini 오류: ' + m);
  err.busy = busy || quota; // 일시적인 오류: app.js 가 기다렸다 재시도하거나 다른 모델로 시도
  // 단종·미지원 모델이면 Google 이 안내하는 대체 모델을 함께 넘긴다
  if (/no longer available|not found|not supported/i.test(m)) err.suggest = (String(m).match(/models\/(gemini-[\w.-]+)/g) || []).map(x => x.slice(7).replace(/\.+$/, '')).find(x => x !== model) || DEFAULT_MODEL;
  return err;
}
