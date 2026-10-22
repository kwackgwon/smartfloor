// 브라우저에서 Gemini API 를 직접 호출해 벽 도면을 만든다 (서버 없음).
// 결과 plan (단위 cm): { width, height, wallThickness,
//   walls: [[x1,y1,x2,y2,두께?]]          선으로 된 벽 (두께가 없으면 wallThickness)
//   shapes: [[고리, 고리, ...]] }           칠해진 벽 모양. 고리 = [[x,y],...], 구멍 포함 evenodd 로 채운다
//
// 벽 모양은 업로드한 도면 이미지의 벽 픽셀을 그대로 다각형으로 옮기고,
// Gemini 는 건물 영역·벽 위치(0~1000 정규화 좌표)를 알려 줘서 글자·표제란을 걸러 내고 얇은 칸막이·창문 구간을 메운다.

const DEFAULT_MODEL = 'gemini-3.8-flash';
// 생각 수준이 높으면 Gemini 가 생각하는 동안 1분 넘게 아무 데이터도 보내지 않을 수 있다 → 넉넉히 기다린다
const IDLE_MS = 180000;  // 스트림에서 이 시간 동안 아무 데이터도 없으면 멈춘 것으로 보고 재시도
const TOTAL_MS = 300000; // 한 번 요청의 전체 상한
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

// ── 생각(thinking) 설정: Gemini 3 이상은 thinkingLevel, 2.x 는 thinkingBudget ──
const LEVEL_BUDGET = { low: 1024, medium: 4096, high: -1 }; // 2.x: -1 = 필요한 만큼
const thinkingConfig = (model, level) => ver(model) >= 3
  ? { thinkingLevel: level, includeThoughts: true }
  : { thinkingBudget: LEVEL_BUDGET[level], includeThoughts: true };

// ── 스트리밍 요청 하나: JSON 결과를 돌려준다 ──
// onThink(): 생각 데이터가 올 때, onText(전체 텍스트): 결과 텍스트가 올 때
async function streamJSON({ key, model, parts, schema, level, onThink = () => {}, onText = () => {}, noThink = false }) {
  const config = { responseMimeType: 'application/json', responseSchema: schema };
  if (!noThink) config.thinkingConfig = thinkingConfig(model, level);
  if (ver(model) < 3) config.temperature = 0.2; // Gemini 3 는 기본 온도(1.0) 유지가 권장

  const ctl = new AbortController();
  let idle, timedOut = false;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; ctl.abort(); }, IDLE_MS); };
  const total = setTimeout(() => { timedOut = true; ctl.abort(); }, TOTAL_MS);
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
        return await streamJSON({ key, model, parts, schema, level, onThink, onText, noThink: true });
      throw apiError(res.status, m, model, data.error?.details);
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
        if (ev.error) throw apiError(ev.error.code || 500, ev.error.message, model, ev.error.details);
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
    if (e.name === 'AbortError' || timedOut) throw Object.assign(new Error('Gemini 응답이 너무 오래 걸려 시간 초과되었습니다'), { busy: true, timeout: true, kind: 'timeout' });
    if (e instanceof TypeError) throw new Error('Gemini 에 연결할 수 없습니다 (인터넷 연결 확인)');
    throw e;
  } finally { clearTimeout(idle); clearTimeout(total); }

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

const wallPrompt = o => `첨부한 이미지는 스터디카페 건축 평면도다. 이 이미지에 그려진 벽만 찾아라.

[가장 중요한 규칙]
- 너의 생각·추측·설계 지식으로 만들지 마라. 오직 첨부한 이미지만 보고, 이미지와 똑같아지도록 좌표를 정한다.
- 이미지에 없는 벽을 추가하지 않는다. 이미지에 있는 벽을 빼지 않는다. 보기 좋게 정리하거나 대칭으로 맞추거나 모양을 바꾸지 않는다.
- 확실하지 않으면 이미지에 보이는 그대로 따른다. 일반적인 도면은 이럴 것이라는 짐작으로 채우지 않는다.

${COORD}

- extent: 건물 외벽의 바깥 테두리를 감싸는 박스. 표제란(오른쪽 제목 칸), 좌석표, 치수선, 도면 이름은 넣지 않는다.
- walls: 이미지에 그려진 각 벽의 중심선을 [y1, x1, y2, x2] 선분으로. 다음을 모두 포함한다:
  · 검게 칠해진 외벽, 창문 구간(외벽이 얇은 두 줄로 그려진 곳)
  · 회색·빨간색으로 칠해진 칸막이 벽, 화장실·창고·스터디룸·카페를 나누는 얇은 벽
- 외벽 윤곽을 이미지대로 한 바퀴 따라간다. 사선 벽은 사선 그대로. 꺾이는 곳마다 선분을 나누고, 이어지는 선분의 끝점은 같은 좌표로.
- 문 자리처럼 이미지에서 벽이 끊긴 곳은 이미지대로 비운다.
- 벽이 아닌 것: 책상·의자·책상 칸막이, 변기·싱크대 같은 집기, 문 열림 호, 얇은 치수선, 숫자·글자, 계단, 표제란, 좌석표, 도면 테두리.
- width_mm: 치수선에 적힌 건물 전체 가로 길이(mm, 가장 바깥 치수). 없으면 0.${o.note ? `\n\n[요청] (이미지에 그려진 것 안에서만 반영한다)\n${o.note}` : ''}`;

// o: 폼 값, image: dataURL, onProgress({ phase: 'think'|'draw'|'refine', count }), onPreview(plan), level: 생각 수준
// 정확도가 가장 중요해서 생각(thinking) 수준은 high 로 시작한다 (시간 초과면 app.js 가 low 로 다시 시도). 기다리는 동안
// 이미지 픽셀만으로 만든 미리보기를 먼저 보여 주고(1초 안팎), Gemini 답이 오면 최종 도면으로 바꾼다.
let pxCache = null; // 같은 이미지로 재시도할 때 픽셀 분석을 다시 하지 않는다
async function generatePlan(o, image, key, model, onProgress = () => {}, onPreview = () => {}, level = 'high') {
  const count = (t, re) => (t.match(re) || []).length;
  const m = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  const gem = streamJSON({
    key, model, level, schema: WALL_SCHEMA, parts: [{ text: wallPrompt(o) }, { inline_data: { mime_type: m[1], data: m[2] } }],
    onThink: () => onProgress({ phase: 'think' }), onText: t => onProgress({ phase: 'draw', count: Math.max(0, count(t, /\[/g) - 2) })
  });
  gem.catch(() => {}); // 미리보기를 만드는 동안 실패해도 아래 await 에서 받는다
  if (!pxCache || pxCache.image !== image) pxCache = { image, px: wallMasks(await readPixels(image)) };
  const px = pxCache.px;
  try { onPreview(traceToPlan(autoExtent(px), px)); } catch (e) { /* 미리보기를 못 만들면 Gemini 결과만 쓴다 */ }
  const w = await gem;
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
  return { W, H, raw, light, tone, wall: morph(morph(raw, W, H, 2, true), W, H, 2, false) };
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
  // 바깥까지 거리 (체스판 거리, 2번 훑기)
  const D = new Int32Array(N), INF = 1 << 29;
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
  return out;
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
        if (Math.abs(t) > reach || q < -o.t || q > M + o.t) return;
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
  P.comp = P.comp || components(wall, W, H);
  const { lab, list } = P.comp, keepId = new Uint8Array(list.length + 1);
  const minArea = (S * 0.007) ** 2, minDim = S * 0.008;
  list.forEach(c => { if (c.area >= minArea && Math.max(c.x1 - c.x0, c.y1 - c.y0) >= minDim && inEx((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)) keepId[c.id] = 1; });
  const K0 = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (lab[i] && keepId[lab[i]]) K0[i] = 1;
  const K = closeExterior(bridgeWindows(K0, P.light, W, H), W, H); // 외벽 창문 구간 메우기 → 외벽 전부 닫기

  // 2. Gemini 벽 선분: 칠해진 벽에 맞추고(창문 구간 등 메우기), 안 되면 얇은 선에 맞춘다(얇은 칸막이). 근거 픽셀이 없으면 버린다
  const segs = [];
  for (const l of lines) {
    if (!inEx((l[0] + l[2]) / 2, (l[1] + l[3]) / 2)) continue;
    let r = snapWall(l, K, W, H);
    if (r.cov >= 0.85) continue; // 이미 칠해진 벽 모양이 덮고 있으면 선은 필요 없다
    if (r.cov < 0.35) { r = snapWall(l, raw, W, H); if (r.cov < 0.5) continue; r.t = Math.max(r.t, S * 0.004); }
    segs.push(r);
  }
  joinEnds(segs);

  // 3. 범위·축척: 남은 벽 픽셀과 선분이 차지하는 범위 = 건물 외곽
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < W * H; i++) if (K[i]) { const x = i % W, y = (i - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  segs.forEach(({ seg, t }) => { x0 = Math.min(x0, seg[0] - t / 2, seg[2] - t / 2); x1 = Math.max(x1, seg[0] + t / 2, seg[2] + t / 2); y0 = Math.min(y0, seg[1] - t / 2, seg[3] - t / 2); y1 = Math.max(y1, seg[1] + t / 2, seg[3] + t / 2); });
  if (x1 <= x0 || y1 <= y0) throw Object.assign(new Error('도면에서 벽을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });
  // 축척: 도면 치수(mm), 없으면 가로 15m 가정
  const realW = +w.width_mm > 500 ? +w.width_mm / 10 : 1500, k = realW / (x1 - x0 + 1);
  const cx = v => Math.round((v - x0) * k * 10) / 10, cy = v => Math.round((v - y0) * k * 10) / 10;

  // 4. 칠해진 벽 → 다각형(구멍 포함). 덩어리마다 하나의 모양으로 묶는다 (지우개로 한 번에 지울 수 있게)
  const shapes = [], K2 = components(K, W, H);
  K2.list.forEach(c => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, sub = new Uint8Array(bw * bh);
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (K2.lab[y * W + x] === c.id) sub[(y - c.y0) * bw + x - c.x0] = 1;
    const loops = traceLoops(sub, bw, bh).map(l => orthogonalize(simplifyLoop(l, 2))).filter(l => l.length >= 3)
      .map(l => l.map(([x, y]) => [cx(x + c.x0), cy(y + c.y0)]));
    if (loops.length) shapes.push(loops);
  });

  // 선 벽의 끝점은 픽셀에서 벽이 끝나는 곳에 맞췄으므로 수평·수직만 편다
  const walls = segs.map(({ seg, t }) => straighten([cx(seg[0]), cy(seg[1]), cx(seg[2]), cy(seg[3]), Math.max(4, Math.round(t * k))]));
  return finalize({ width: Math.round((x1 - x0 + 1) * k), height: Math.round((y1 - y0 + 1) * k), wallThickness: 15, walls, shapes });
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

// 거의 수평·수직인(4° 이내) 벽 선분을 똑바로 편다
const straighten = ([x1, y1, x2, y2, ...t]) => { // t: 두께 (있으면 그대로 유지)
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dy) <= Math.abs(dx) * 0.07) { const y = Math.round((y1 + y2) / 2); return [x1, y, x2, y, ...t]; }
  if (Math.abs(dx) <= Math.abs(dy) * 0.07) { const x = Math.round((x1 + x2) / 2); return [x, y1, x, y2, ...t]; }
  return [x1, y1, x2, y2, ...t];
};
// details: Google 오류의 상세 정보 (RetryInfo.retryDelay = 다시 시도까지 기다릴 시간, QuotaFailure = 어떤 한도인지)
function apiError(status, m, model, details = []) {
  const busy = status === 503 || status === 500 || /high demand|overloaded|unavailable/i.test(m), quota = status === 429;
  const err = new Error(/API key not valid/i.test(m) ? 'API 키가 올바르지 않습니다'
    : busy ? 'Gemini 사용량이 많아 지금은 생성할 수 없습니다. 1~2분 뒤 다시 시도해 주세요'
    : quota ? 'Gemini 사용 한도를 넘었습니다. 잠시 후 다시 시도하거나 다른 모델을 선택해 주세요'
    : 'Gemini 오류: ' + m);
  err.busy = busy || quota; // 일시적인 오류: app.js 가 기다렸다 재시도하거나 다른 모델로 시도
  err.kind = quota ? 'quota' : busy ? 'busy' : '';
  const delay = (details || []).map(d => d && d.retryDelay).find(Boolean); // 예: "37s"
  if (delay) err.retryAfter = Math.ceil(parseFloat(delay));
  err.daily = quota && (/per ?day/i.test(JSON.stringify(details || []) + m) || err.retryAfter > 600); // 하루 한도인지 (10분 넘게 기다려야 하면 사실상 하루 한도)
  // 단종·미지원 모델이면 Google 이 안내하는 대체 모델을 함께 넘긴다
  if (/no longer available|not found|not supported/i.test(m)) err.suggest = (String(m).match(/models\/(gemini-[\w.-]+)/g) || []).map(x => x.slice(7).replace(/\.+$/, '')).find(x => x !== model) || DEFAULT_MODEL;
  return err;
}
