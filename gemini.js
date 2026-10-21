// 브라우저에서 Gemini API 를 직접 호출해 좌석 도면을 만든다 (서버 없음).
// 결과 plan: { width, height, wallThickness, walls: [[x1,y1,x2,y2]], seats: [{no,type,x,y,w,h,status}], labels: [] } (단위 cm)
//
// 참고 도면이 있으면 "옮겨 그리기": 벽·좌석을 두 요청으로 나눠 동시에 받고, 좌표는 Gemini 가 가장 정확한
// 이미지 기준 0~1000 정규화 좌표로 받은 뒤, 벽은 이미지의 실제 검은 벽 픽셀에 맞춰 위치·두께를 보정한다.
// 참고 도면이 없으면 "설계": 조건에 맞춰 cm 좌표로 직접 설계한다.

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

const WALL_SCHEMA = obj({
  width_mm: { type: 'NUMBER', description: '치수선에서 읽은 건물 전체 가로 길이 (mm). 모르면 0' },
  walls: { type: 'ARRAY', description: '벽 중심선 [y1, x1, y2, x2], 0~1000 정규화', items: NUMS(4) }
}, ['width_mm', 'walls']);

const SEAT_SCHEMA = obj({
  seats: {
    type: 'ARRAY',
    items: obj({
      n: { type: 'STRING', description: '좌석 번호 (도면 표기 그대로, 없으면 빈 문자열)' },
      t: { type: 'STRING', enum: ['S', 'M'], description: 'S=1인 책상, M=여러 명이 쓰는 테이블' },
      box_2d: { ...NUMS(4), description: '[ymin, xmin, ymax, xmax], 0~1000 정규화' }
    }, ['n', 't', 'box_2d'])
  }
}, ['seats']);

const DESIGN_SCHEMA = obj({
  width: { type: 'NUMBER', description: '매장 전체 가로 (cm)' },
  height: { type: 'NUMBER', description: '매장 전체 세로 (cm)' },
  walls: { type: 'ARRAY', description: '벽 중심선 [x1,y1,x2,y2] (cm)', items: NUMS(4) },
  seats: {
    type: 'ARRAY',
    items: obj({
      n: { type: 'STRING' }, t: { type: 'STRING', enum: ['S', 'M'] },
      b: { ...NUMS(4), description: '[중심x, 중심y, 가로, 세로] (cm)' }
    }, ['n', 't', 'b'])
  }
}, ['width', 'height', 'walls', 'seats']);

const wantText = o => [
  o.width && o.height ? `매장 크기: 가로 ${o.width}m × 세로 ${o.height}m` : '',
  o.single ? `1인석: ${o.single}석` : '',
  o.multi ? `다인석 테이블: ${o.multi}개` : '',
  o.note ? `추가 요청: ${o.note}` : ''
].filter(Boolean).join('\n');

const COORD = '좌표는 이미지 전체를 기준으로 0~1000 으로 정규화한 값이다 (왼쪽 위 0,0 / 오른쪽 아래 1000,1000). y 를 먼저 쓴다.';

const WALL_PROMPT = `첨부한 이미지는 스터디카페 건축 평면도다. 벽만 찾아라.
${COORD}

- walls: 각 벽의 중심선을 [y1, x1, y2, x2] 선분으로. 검게(또는 진하게) 두껍게 칠해진 외벽·내벽, 화장실·창고·룸을 나누는 칸막이 벽.
- 외벽 윤곽을 한 바퀴 빠짐없이 따라간다. 사선 벽은 사선 그대로. 꺾이는 곳마다 선분을 나누고, 이어지는 선분의 끝점은 같은 좌표로.
- 문·출입구 자리(문 열림 호가 그려진 곳, 벽이 끊긴 곳)는 선분을 끊어 비운다.
- 벽이 아닌 것: 얇은 치수선, 치수 숫자, 글자, 책상·의자·변기·싱크대 같은 집기, 표제란(오른쪽 제목 칸), 좌석표, 도면 테두리.
- width_mm: 치수선에 적힌 건물 전체 가로 길이(mm, 가장 바깥 치수). 없으면 0.`;

const seatPrompt = o => `첨부한 이미지는 스터디카페 건축 평면도다. 좌석(책상)만 찾아라.
${COORD}

- 책상 하나 = 박스 하나. box_2d 는 책상 상판의 [ymin, xmin, ymax, xmax]. 의자는 박스에 넣지 않는다.
- 하나도 빠뜨리지 말고 모두 찾는다. 줄지어 있는 책상은 하나씩 따로.
- n: 책상 옆에 적힌 좌석 번호 그대로(예: "01", "32"). 없으면 "".
- t: 1인 책상은 "S", 스터디룸 등 여러 명이 쓰는 큰 테이블은 "M".
- 표제란·좌석표·범례 안의 그림은 제외한다. 좌석표에 합계가 있으면 찾은 개수가 같은지 확인한다.
${wantText(o) ? '\n[참고]\n' + wantText(o) : ''}`;

const designPrompt = o => `너는 스터디카페/독서실 좌석 배치 설계자다. 아래 조건에 맞는 좌석 도면을 설계해 JSON 으로 답하라.

- 단위 cm, 원점 좌상단, x 는 오른쪽, y 는 아래쪽. 모든 좌표는 0~width, 0~height 안.
- walls: 벽 중심선 [x1,y1,x2,y2]. 외벽은 매장 테두리를 닫힌 형태로 둘러싸되 출입문 자리(폭 90~120cm)는 비운다. 화장실·카운터 등 내부 칸막이 벽도 넣는다. 이어지는 끝점은 같은 좌표로.
- seats: n=좌석 번호("1" 부터 차례로), t=S(1인석 80×60cm)/M(다인석 180×90cm), b=[중심x, 중심y, 가로, 세로].
- 좌석끼리·좌석과 벽이 겹치지 않게, 벽에서 20cm 이상, 주 통로 90cm 이상. 1인석은 벽을 따라 또는 열을 지어 가지런히.
- 요청한 좌석 수를 정확히 지킨다.

[요구 사항]
${wantText(o) || '일반적인 30평 규모 스터디카페'}`;

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

// o: 폼 값, image: dataURL 또는 null, level: low|medium|high, onProgress({ phase: 'think'|'draw', seats })
async function generatePlan(o, image, key, model, level = 'medium', onProgress = () => {}) {
  const count = (t, re) => (t.match(re) || []).length;
  if (!image) {
    const p = await streamJSON({
      key, model, level, schema: DESIGN_SCHEMA, parts: [{ text: designPrompt(o) }],
      onThink: () => onProgress({ phase: 'think' }), onText: t => onProgress({ phase: 'draw', seats: count(t, /"b"\s*:/g) })
    });
    return designToPlan(p);
  }

  const m = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/), img = { inline_data: { mime_type: m[1], data: m[2] } };
  const outer = new AbortController(), fail = e => { outer.abort(e); throw e; };
  const [w, s, mask] = await Promise.all([
    streamJSON({ key, model, level, outer: outer.signal, schema: WALL_SCHEMA, parts: [{ text: WALL_PROMPT }, img], onThink: () => onProgress({ phase: 'think' }) }).catch(fail),
    // 좌석 찾기는 물체 탐지라 생각을 적게 하는 편이 위치가 더 정확하다
    streamJSON({ key, model, level: 'low', outer: outer.signal, schema: SEAT_SCHEMA, parts: [{ text: seatPrompt(o) }, img],
      onText: t => onProgress({ phase: 'draw', seats: count(t, /"box_2d"\s*:/g) }) }).catch(fail),
    loadMask(image)
  ]);
  return traceToPlan(w, s, mask, o);
}

// ── 이미지 픽셀: 두꺼운 검은 벽만 남긴 마스크 ──
async function loadMask(dataURL) {
  const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = dataURL; });
  const W = im.width, H = im.height, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, W, H).data, dark = new Uint8Array(W * H), m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { // 진한 무채색만 (빨간 번호·유리벽 등 색 있는 선 제외)
    const r = d[4 * i], gr = d[4 * i + 1], b = d[4 * i + 2];
    dark[i] = r + gr + b < 330 && Math.max(r, gr, b) - Math.min(r, gr, b) < 60 ? 1 : 0;
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { // 3×3 침식: 1~2px 얇은 선(치수선·집기·글자) 제거
    let ok = 1;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!dark[(y + dy) * W + x + dx]) { ok = 0; break; }
    m[y * W + x] = ok;
  }
  return { W, H, m };
}

// Gemini 가 준 벽 선분을 실제 벽 픽셀의 중심선에 맞춘다 (평행 이동 + 기울기 보정), 끝점은 벽이 끝나는 곳까지. t = 벽 두께(px)
function snapWall([x1, y1, x2, y2], M) {
  const L = Math.hypot(x2 - x1, y2 - y1);
  if (L < 4) return { seg: [x1, y1, x2, y2], t: 0 };
  const ux = (x2 - x1) / L, uy = (y2 - y1) / L, nx = -uy, ny = ux;
  const R = Math.max(6, Math.round(Math.max(M.W, M.H) * 0.015)), N = Math.max(10, Math.round(L / 4));
  const on = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < M.W && y < M.H && M.m[y * M.W + x] === 1; };

  // 1. 선분을 따라 N 곳에서, 법선 방향 ±R 안의 벽 픽셀 구간 중 선에 가장 가까운 구간의 중심을 찾는다
  const samples = [];
  for (let i = 0; i <= N; i++) {
    const s = 0.05 + 0.9 * i / N, px = x1 + (x2 - x1) * s, py = y1 + (y2 - y1) * s;
    let best = null;
    for (let d = -R; d <= R; d++) {
      if (!on(px + nx * d, py + ny * d) || on(px + nx * (d - 1), py + ny * (d - 1)) && d > -R) continue; // 구간 시작점만
      let e = d; while (e < R && on(px + nx * (e + 1), py + ny * (e + 1))) e++;
      const c = (d + e) / 2, len = e - d + 1;
      if (!best || Math.abs(c) < Math.abs(best.c)) best = { c, len };
      d = e;
    }
    if (best) samples.push({ s, ...best });
  }
  if (samples.length < (N + 1) * 0.35) return { seg: [x1, y1, x2, y2], t: 0 }; // 근처에 벽 픽셀이 없으면 그대로 둔다

  // 2. 가로지르는 다른 벽(구간이 유난히 긴 곳)과 튀는 값을 빼고, 오프셋 = a + b·s 로 직선 맞춤 (최소제곱)
  const med = a => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
  const tLen = med(samples.map(x => x.len)), cMed = med(samples.map(x => x.c));
  const ok = samples.filter(x => x.len <= tLen * 1.8 + 2 && Math.abs(x.c - cMed) <= Math.max(4, tLen * 1.5));
  if (ok.length < 3) return { seg: [x1, y1, x2, y2], t: 0 };
  const ms = ok.reduce((a, x) => a + x.s, 0) / ok.length, mc = ok.reduce((a, x) => a + x.c, 0) / ok.length;
  const vs = ok.reduce((a, x) => a + (x.s - ms) ** 2, 0), b = vs > 1e-6 ? ok.reduce((a, x) => a + (x.s - ms) * (x.c - mc), 0) / vs : 0, a = mc - b * ms;
  let ax = x1 + nx * a, ay = y1 + ny * a, bx = x2 + nx * (a + b), by = y2 + ny * (a + b);

  // 3. 끝점: 벽 위면 벽이 끝날 때까지 늘리고, 벽 밖이면 벽이 시작할 때까지 줄인다 (문 자리 틈은 그대로 남는다)
  const L2 = Math.hypot(bx - ax, by - ay), vx = (bx - ax) / L2, vy = (by - ay) / L2, E = R * 2;
  const fit = (px, py, dx, dy) => {
    if (on(px, py)) { let k = 0; while (k < E && on(px + dx * (k + 1), py + dy * (k + 1))) k++; return [px + dx * k, py + dy * k]; }
    let k = 0; while (k < E && !on(px - dx * k, py - dy * k)) k++;
    return k < E ? [px - dx * k, py - dy * k] : [px, py];
  };
  [ax, ay] = fit(ax, ay, -vx, -vy);
  [bx, by] = fit(bx, by, vx, vy);
  return { seg: [ax, ay, bx, by], t: tLen + 2 }; // +2: 침식으로 양쪽 1px 씩 줄어든 만큼
}

// 옮겨 그리기 결과(정규화 좌표) → cm 도면
function traceToPlan(w, s, M, o) {
  const toPx = ([y1, x1, y2, x2]) => [x1 / 1000 * M.W, y1 / 1000 * M.H, x2 / 1000 * M.W, y2 / 1000 * M.H];
  const raw = (w.walls || []).filter(a => Array.isArray(a) && a.length === 4 && a.every(Number.isFinite)).map(toPx);
  if (!raw.length) throw Object.assign(new Error('도면에서 벽을 찾지 못했습니다. 다시 시도하거나 더 선명한 도면을 올려 주세요'), { busy: true });
  const snapped = raw.map(a => snapWall(a, M));
  const ts = snapped.map(x => x.t).filter(Boolean).sort((a, b) => a - b), tPx = ts.length ? ts[ts.length >> 1] : 6;

  const xs = snapped.flatMap(x => [x.seg[0], x.seg[2]]), ys = snapped.flatMap(x => [x.seg[1], x.seg[3]]);
  const minX = Math.min(...xs) - tPx / 2, minY = Math.min(...ys) - tPx / 2;
  const outerW = Math.max(...xs) - Math.min(...xs) + tPx, outerH = Math.max(...ys) - Math.min(...ys) + tPx;
  // 축척: 직접 입력한 가로(m) > 도면 치수(mm) > 가로 15m 가정
  const realW = +o.width > 0 ? +o.width * 100 : +w.width_mm > 500 ? +w.width_mm / 10 : 1500, k = realW / outerW;
  const cm = v => Math.round(v * k);

  const walls = tidyWalls(snapped.map(x => [cm(x.seg[0] - minX), cm(x.seg[1] - minY), cm(x.seg[2] - minX), cm(x.seg[3] - minY)]));
  const seats = (s.seats || []).filter(t => t && Array.isArray(t.box_2d) && t.box_2d.length === 4 && t.box_2d.every(Number.isFinite)).map((t, i) => {
    const [ymin, xmin, ymax, xmax] = t.box_2d, a = xmin / 1000 * M.W, b = ymin / 1000 * M.H, c = xmax / 1000 * M.W, d = ymax / 1000 * M.H;
    return { no: String(t.n || '').trim().slice(0, 6) || String(i + 1), type: t.t === 'M' ? 'MULTI' : 'SINGLE',
      x: cm((a + c) / 2 - minX), y: cm((b + d) / 2 - minY), w: Math.max(20, cm(Math.abs(c - a))), h: Math.max(20, cm(Math.abs(d - b))), status: 'AVAILABLE' };
  });
  return finalize({ width: cm(outerW), height: cm(outerH), wallThickness: Math.min(40, Math.max(8, cm(tPx))), walls, seats: alignSeats(seats) });
}

// 같은 줄(행·열)에 있는 좌석의 중심과 크기를 맞춘다: 중심 차이가 좌석 크기의 20% 이내면 같은 줄로 본다
function alignSeats(seats) {
  const med = a => { const b = [...a].sort((p, q) => p - q); return b[b.length >> 1]; };
  const line = (pos, size) => {
    const sorted = [...seats].sort((a, b) => a[pos] - b[pos]), groups = [];
    for (const t of sorted) {
      const g = groups[groups.length - 1];
      if (g && t[pos] - g[g.length - 1][pos] <= med(g.map(x => x[size])) * 0.2) g.push(t); else groups.push([t]);
    }
    const other = size === 'h' ? 'w' : 'h', along = pos === 'y' ? 'x' : 'y';
    for (const g of groups) if (g.length > 1) {
      const c = Math.round(med(g.map(x => x[pos])));
      g.forEach(t => { t[pos] = c; });
      // 같은 줄의 같은 종류 좌석은 크기를 통일 (중앙값에서 40% 넘게 다른 좌석은 다른 책상으로 보고 그대로)
      for (const k of [size, other]) {
        const z = Math.round(med(g.map(x => x[k])));
        g.forEach(t => { if (Math.abs(t[k] - z) <= z * 0.4) t[k] = z; });
      }
      // 간격이 거의 일정한 줄(3석 이상)은 양 끝 사이에 같은 간격으로 배치
      const row = [...g].sort((a, b) => a[along] - b[along]), gaps = row.slice(1).map((t, i) => t[along] - row[i][along]), mg = med(gaps);
      if (row.length >= 3 && mg > 0 && gaps.every(d => Math.abs(d - mg) <= mg * 0.3)) {
        const a0 = row[0][along], step = (row[row.length - 1][along] - a0) / (row.length - 1);
        row.forEach((t, i) => { t[along] = Math.round(a0 + step * i); });
      }
    }
  };
  line('y', 'h'); line('x', 'w');
  return seats;
}

// 설계 결과(cm) → 도면
function designToPlan(p) {
  const walls = tidyWalls((p.walls || []).filter(a => Array.isArray(a) && a.length === 4).map(a => a.map(Math.round)));
  const seats = (p.seats || []).filter(t => t && Array.isArray(t.b)).map((t, i) => ({
    no: String(t.n || i + 1).slice(0, 6), type: t.t === 'M' ? 'MULTI' : 'SINGLE',
    x: Math.round(t.b[0]), y: Math.round(t.b[1]), w: Math.max(20, Math.round(t.b[2]) || 80), h: Math.max(20, Math.round(t.b[3]) || 60), status: 'AVAILABLE'
  }));
  return finalize({ width: Math.round(p.width), height: Math.round(p.height), wallThickness: 15, walls, seats });
}

// 형식·범위 정리 (Gemini 응답을 그대로 믿지 않는다)
function finalize(p) {
  const W = Math.min(10000, Math.max(200, p.width || 1000)), H = Math.min(10000, Math.max(200, p.height || 1000));
  const cx = v => Math.min(W, Math.max(0, v)), cy = v => Math.min(H, Math.max(0, v));
  const walls = p.walls.map(w => [cx(w[0]), cy(w[1]), cx(w[2]), cy(w[3])])
    .filter(w => w.every(Number.isFinite) && (w[0] !== w[2] || w[1] !== w[3]));
  const seats = p.seats.filter(t => [t.x, t.y, t.w, t.h].every(Number.isFinite)).map(t => ({ ...t, x: cx(t.x), y: cy(t.y) }));
  return { width: W, height: H, wallThickness: p.wallThickness, walls, seats, labels: [] };
}

// 거의 수평·수직인 벽은 똑바로 펴고(2° 이내), 가까운 끝점(20cm 이내)은 하나로 붙여 벽 틈을 없앤다
const straighten = ([x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dy) <= Math.abs(dx) * 0.035) { const y = Math.round((y1 + y2) / 2); return [x1, y, x2, y]; }
  if (Math.abs(dx) <= Math.abs(dy) * 0.035) { const x = Math.round((x1 + x2) / 2); return [x, y1, x, y2]; }
  return [x1, y1, x2, y2];
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
  walls = walls.map((w, i) => straighten([pts[2 * i][0], pts[2 * i][1], pts[2 * i + 1][0], pts[2 * i + 1][1]]))
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
