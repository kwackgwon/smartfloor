// 브라우저에서 Gemini API 를 직접 호출해 좌석 도면 JSON 을 받아온다 (서버 없음).
// 결과: { width, height, wallThickness, walls: [[x1,y1,x2,y2]], seats: [{no,type,x,y,w,h,status}], labels: [{text,x,y}] } (단위 cm)

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

// 응답 형식. 출력 토큰 수가 곧 응답 시간이라 키 이름을 짧게, 좌표는 숫자 배열로 받는다.
const NUMS = n => ({ type: 'ARRAY', items: { type: 'NUMBER' }, minItems: n, maxItems: n });
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    width: { type: 'NUMBER', description: '매장 전체 가로 (cm)' },
    height: { type: 'NUMBER', description: '매장 전체 세로 (cm)' },
    walls: { type: 'ARRAY', description: '벽 중심선 [x1,y1,x2,y2]', items: NUMS(4) },
    seats: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          n: { type: 'STRING', description: '좌석 번호 (도면 표기 그대로)' },
          t: { type: 'STRING', enum: ['S', 'M'], description: 'S=1인석, M=다인석' },
          b: { ...NUMS(4), description: '[중심x, 중심y, 가로, 세로]' }
        },
        required: ['n', 't', 'b'],
        propertyOrdering: ['n', 't', 'b']
      }
    },
    labels: {
      type: 'ARRAY', description: '공간 이름',
      items: { type: 'OBJECT', properties: { s: { type: 'STRING' }, p: NUMS(2) }, required: ['s', 'p'], propertyOrdering: ['s', 'p'] }
    }
  },
  required: ['width', 'height', 'walls', 'seats', 'labels'],
  propertyOrdering: ['width', 'height', 'walls', 'seats', 'labels']
};

function buildPrompt(o, hasImage) {
  const want = [
    o.width && o.height ? `매장 크기: 가로 ${o.width}m × 세로 ${o.height}m` : '',
    o.single ? `1인석: ${o.single}석` : '',
    o.multi ? `다인석 테이블: ${o.multi}개` : '',
    o.note ? `추가 요청: ${o.note}` : ''
  ].filter(Boolean).join('\n');

  const common = `[출력 형식]
- 단위 cm, 원점 좌상단, x 는 오른쪽, y 는 아래쪽으로 증가. 모든 좌표는 0~width, 0~height 안.
- walls: 벽 중심선 [x1,y1,x2,y2]. 벽이 꺾이면 선분을 나눈다. 문·출입구 자리는 선분을 끊어 비운다.
- seats: n=좌석 번호 문자열, t=S(1인석)/M(다인석 테이블), b=[중심x, 중심y, 가로, 세로].
- labels: s=공간 이름(한국어), p=[x,y] 그 공간의 중심.
- 이어진 벽의 끝점 좌표는 정확히 같은 값으로 맞춘다.`;

  if (hasImage) return `첨부한 이미지는 스터디카페 건축 평면도다. 이 도면을 그대로 옮겨 JSON 으로 답하라. 새로 설계하지 말고 도면에 있는 것만 옮긴다.

[읽는 순서]
1. 치수선의 숫자(mm)로 매장 전체 가로·세로를 구해 cm 로 바꾼다 (예: 15,065mm → 1507cm). 축척 표기(예: 1/80)가 있으면 참고한다.
2. 외벽 윤곽을 따라간다. 사선 벽은 사선 그대로 [x1,y1,x2,y2] 로 넣는다 (수평·수직으로 바꾸지 않는다).
3. 화장실·창고·스터디룸·카페 등 내부 칸막이 벽을 넣는다. 문 자리(문 열림 호가 그려진 곳)는 비운다.
4. 책상(좌석)을 하나도 빠짐없이 넣는다. n 에는 도면에 적힌 번호를 그대로(예: "01", "32") 넣는다.
   크기는 도면 표기(예: 1,000*800 → 가로 100, 세로 80)를 쓰고, 위치는 치수와 이웃 좌석 간격으로 맞춘다.
   좌석표/합계가 있으면 seats 개수가 그 합계와 같은지 확인한다. 스터디룸 등의 큰 테이블은 t="M".
5. 공간 이름(예: OPEN STUDY ZONE → 오픈 스터디존, M TOILET → 남자화장실, ENT → 출입구)을 labels 에 넣는다.

[무시할 것]
표제란(오른쪽 제목 칸), 치수선·치수 숫자, 좌석표, 문 열림 호, 의자·변기·싱크대 같은 집기 그림, 도면 테두리.

${common}
${want ? `\n[추가 조건]\n${want}` : ''}`;

  return `너는 스터디카페/독서실 좌석 배치 설계자다. 아래 조건에 맞는 좌석 도면을 설계해 JSON 으로 답하라.

[설계 규칙]
- 외벽은 매장 테두리를 닫힌 형태로 둘러싸되 출입문 자리(폭 90~120cm)는 비운다. 화장실·카운터 등 내부 칸막이 벽도 넣는다.
- 1인석 기본 80×60cm, 다인석 테이블 기본 180×90cm. 좌석끼리·좌석과 벽이 겹치지 않게, 벽에서 20cm 이상, 주 통로 90cm 이상.
- 1인석은 벽을 따라 또는 열을 지어 가지런히 배치하고, 번호는 "1" 부터 차례로 붙인다.
- 요청한 좌석 수를 정확히 지킨다.

${common}

[요구 사항]
${want || '일반적인 30평 규모 스터디카페'}`;
}

// Gemini 응답을 신뢰하지 않고 형식·범위를 정리
function cleanPlan(p) {
  const n = v => (Number.isFinite(+v) ? Math.round(+v) : NaN);
  const W = Math.min(10000, Math.max(200, n(p.width) || 1000)), H = Math.min(10000, Math.max(200, n(p.height) || 1000));
  const cx = v => Math.min(W, Math.max(0, v)), cy = v => Math.min(H, Math.max(0, v));
  let walls = (p.walls || []).filter(Array.isArray).map(w => [cx(n(w[0])), cy(n(w[1])), cx(n(w[2])), cy(n(w[3]))])
    .filter(w => w.every(Number.isFinite) && (w[0] !== w[2] || w[1] !== w[3]));
  walls = tidyWalls(walls);
  const seats = (p.seats || []).filter(t => t && Array.isArray(t.b)).map((t, i) => ({
    no: String(t.n || i + 1).slice(0, 6), type: t.t === 'M' ? 'MULTI' : 'SINGLE',
    x: cx(n(t.b[0])), y: cy(n(t.b[1])), w: Math.max(20, n(t.b[2]) || 80), h: Math.max(20, n(t.b[3]) || 60), status: 'AVAILABLE'
  })).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
  const labels = (p.labels || []).filter(l => l && l.s && Array.isArray(l.p))
    .map(l => ({ text: String(l.s).slice(0, 20), x: cx(n(l.p[0])), y: cy(n(l.p[1])) }))
    .filter(l => Number.isFinite(l.x) && Number.isFinite(l.y));
  return { width: W, height: H, wallThickness: 15, walls, seats, labels };
}

// 거의 수평·수직인 벽은 똑바로 펴고(2° 이내), 가까운 끝점(20cm 이내)은 하나로 붙여 벽 틈을 없앤다
const straighten = ([x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dy) <= Math.abs(dx) * 0.035) { const y = Math.round((y1 + y2) / 2); return [x1, y, x2, y]; }
  if (Math.abs(dx) <= Math.abs(dy) * 0.035) { const x = Math.round((x1 + x2) / 2); return [x, y1, x, y2]; }
  return [x1, y1, x2, y2];
};
function tidyWalls(walls) {
  walls = walls.map(straighten);
  const pts = walls.flatMap(w => [[w[0], w[1]], [w[2], w[3]]]), groups = [];
  pts.forEach(p => {
    const g = groups.find(g => Math.hypot(g.x - p[0], g.y - p[1]) <= 20);
    if (g) { g.list.push(p); g.x = g.list.reduce((s, q) => s + q[0], 0) / g.list.length; g.y = g.list.reduce((s, q) => s + q[1], 0) / g.list.length; }
    else groups.push({ x: p[0], y: p[1], list: [p] });
  });
  groups.forEach(g => g.list.forEach(p => { p[0] = Math.round(g.x); p[1] = Math.round(g.y); }));
  return walls.map((w, i) => straighten([pts[2 * i][0], pts[2 * i][1], pts[2 * i + 1][0], pts[2 * i + 1][1]]))
    .filter(w => w[0] !== w[2] || w[1] !== w[3]);
}

// 속도 설정 -> 모델별 생각(thinking) 설정. Gemini 3 이상은 thinkingLevel, 2.x 는 thinkingBudget.
const LEVEL_BUDGET = { low: 1024, medium: 4096, high: -1 };
function thinkingConfig(model, level) {
  return ver(model) >= 3 ? { thinkingLevel: level, includeThoughts: true }
    : { thinkingBudget: LEVEL_BUDGET[level], includeThoughts: true };
}

// o: 폼 값, image: dataURL 또는 null, level: low|medium|high, onProgress({ phase: 'think'|'draw', seats })
async function generatePlan(o, image, key, model, level = 'medium', onProgress = () => {}, noThink = false) {
  const parts = [{ text: buildPrompt(o, !!image) }];
  if (image) {
    const m = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const config = { responseMimeType: 'application/json', responseSchema: SCHEMA };
  if (!noThink) config.thinkingConfig = thinkingConfig(model, level);
  if (ver(model) < 3) config.temperature = 0.2; // Gemini 3 는 기본 온도(1.0) 유지가 권장

  // 스트리밍: 생각/출력이 오는 동안은 기다리고, 데이터가 IDLE_MS 동안 끊기면 멈춘 것으로 본다
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
      if (!noThink && res.status === 400 && /thinking/i.test(m)) { // 이 모델이 생각 설정을 지원하지 않으면 빼고 다시
        clearTimeout(idle); clearTimeout(total);
        return generatePlan(o, image, key, model, level, onProgress, true);
      }
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
          if (part.thought) onProgress({ phase: 'think' });
          else if (part.text) { text += part.text; onProgress({ phase: 'draw', seats: (text.match(/"b"\s*:/g) || []).length }); }
        }
      }
    }
    if (!text && finish && finish !== 'STOP') throw new Error(`Gemini 가 도면을 만들지 못했습니다 (${finish}). 다시 시도해 주세요`);
  } catch (e) {
    if (e.name === 'AbortError' || timedOut) throw Object.assign(new Error('Gemini 응답이 멈춰 시간 초과되었습니다'), { busy: true });
    if (e instanceof TypeError) throw new Error('Gemini 에 연결할 수 없습니다 (인터넷 연결 확인)');
    throw e;
  } finally { clearTimeout(idle); clearTimeout(total); }

  try { return cleanPlan(JSON.parse(text)); }
  catch (e) { throw Object.assign(new Error('Gemini 응답을 해석하지 못했습니다. 다시 시도해 주세요'), { busy: true }); }
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
