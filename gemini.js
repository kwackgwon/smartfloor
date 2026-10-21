// 브라우저에서 Gemini API 를 직접 호출해 좌석 도면 JSON 을 받아온다 (서버 없음).
// 결과: { width, height, wallThickness, walls: [[x1,y1,x2,y2]], seats: [{type,x,y,w,h,status}], labels: [{text,x,y}] } (단위 cm)

const DEFAULT_MODEL = 'gemini-3.8-flash';
const ATTEMPT_MS = 60000; // 한 번 요청의 최대 대기 시간 (넘으면 재시도)
const API = 'https://generativelanguage.googleapis.com/v1beta/';

// 이 키로 쓸 수 있는 텍스트 생성 모델 (정식 gemini-X.Y-flash/pro 만, 최신 버전·flash 우선)
async function listModels(key) {
  const res = await fetch(API + 'models?pageSize=1000', { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error('모델 목록을 가져오지 못했습니다');
  const ver = n => parseFloat(n.match(/gemini-([\d.]+)/)[1]);
  return ((await res.json()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-[\d.]+-(flash|pro)$/.test(n))
    .sort((a, b) => ver(b) - ver(a) || b.endsWith('flash') - a.endsWith('flash'));
}

// Gemini 에게 강제할 응답 형식 (좌표 단위 cm, 원점 좌상단)
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    width: { type: 'NUMBER', description: '매장 전체 가로 (cm)' },
    height: { type: 'NUMBER', description: '매장 전체 세로 (cm)' },
    walls: {
      type: 'ARRAY', description: '벽 중심선 선분',
      items: { type: 'OBJECT', properties: { x1: { type: 'NUMBER' }, y1: { type: 'NUMBER' }, x2: { type: 'NUMBER' }, y2: { type: 'NUMBER' } }, required: ['x1', 'y1', 'x2', 'y2'] }
    },
    seats: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['SINGLE', 'MULTI'] },
          x: { type: 'NUMBER', description: '좌석 중심 x' }, y: { type: 'NUMBER', description: '좌석 중심 y' },
          w: { type: 'NUMBER' }, h: { type: 'NUMBER' }
        },
        required: ['type', 'x', 'y', 'w', 'h']
      }
    },
    labels: {
      type: 'ARRAY', description: '공간 이름 (입구, 카운터, 화장실 등)',
      items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['text', 'x', 'y'] }
    }
  },
  required: ['width', 'height', 'walls', 'seats', 'labels']
};

function buildPrompt(o, hasImage) {
  const want = [
    o.width && o.height ? `매장 크기: 가로 ${o.width}m × 세로 ${o.height}m` : '',
    o.single ? `1인석: ${o.single}석` : '',
    o.multi ? `다인석 테이블: ${o.multi}개` : '',
    o.note ? `추가 요청: ${o.note}` : ''
  ].filter(Boolean).join('\n');
  return `너는 스터디카페/독서실 좌석 배치 설계자다. 아래 조건에 맞는 좌석 도면을 설계해 JSON 으로만 답하라.

[좌표 규칙]
- 단위는 cm, 원점은 좌상단, x 는 오른쪽, y 는 아래쪽으로 증가한다.
- width/height 는 매장 전체 크기다. 모든 좌표는 0 ~ width, 0 ~ height 안에 있어야 한다.

[벽]
- walls 는 벽 중심선 선분이다. 벽은 수평 또는 수직으로만 그린다.
- 외벽은 매장 테두리를 닫힌 형태로 둘러싸되, 출입문 자리(폭 90~120cm)는 선분을 끊어서 비워 둔다.
- 화장실, 카운터, 스터디룸 등이 있으면 내부 칸막이 벽도 포함하고 문 자리는 비워 둔다.

[좌석]
- SINGLE = 1인석 (기본 80×60cm), MULTI = 다인석 테이블 (기본 180×90cm, 세로 배치면 w/h 를 바꾼다).
- x, y 는 좌석 중심, w, h 는 좌석 크기다.
- 좌석끼리, 좌석과 벽이 겹치지 않게 하고 벽에서 20cm 이상 띄운다. 주 통로 폭은 90cm 이상 확보한다.
- 1인석은 벽을 따라 또는 열을 지어 가지런히 배치한다.

[라벨]
- labels 에 입구, 카운터, 화장실 등 공간 이름과 그 중심 위치를 넣는다.

${hasImage ? '[참고 도면]\n첨부한 도면 이미지의 외벽 형태, 비율, 출입구 위치, 내부 벽을 최대한 그대로 따라라. 이미지에 좌석이 있으면 그 배치를 참고하라. 실제 크기가 주어지지 않았으면 이미지 비율로 현실적인 cm 크기를 추정하라.\n\n' : ''}[요구 사항]
${want || '일반적인 30평 규모 스터디카페'}`;
}

// Gemini 응답을 신뢰하지 않고 형식·범위를 정리
function cleanPlan(p) {
  const n = v => (Number.isFinite(+v) ? Math.round(+v) : NaN);
  const W = Math.min(10000, Math.max(200, n(p.width) || 1000)), H = Math.min(10000, Math.max(200, n(p.height) || 1000));
  const cx = v => Math.min(W, Math.max(0, v)), cy = v => Math.min(H, Math.max(0, v));
  const walls = (p.walls || []).map(w => [cx(n(w.x1)), cy(n(w.y1)), cx(n(w.x2)), cy(n(w.y2))])
    .filter(w => w.every(Number.isFinite) && (w[0] !== w[2] || w[1] !== w[3]));
  const seats = (p.seats || []).map(t => ({
    type: t.type === 'MULTI' ? 'MULTI' : 'SINGLE',
    x: cx(n(t.x)), y: cy(n(t.y)), w: Math.max(20, n(t.w) || 80), h: Math.max(20, n(t.h) || 60), status: 'AVAILABLE'
  })).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
  const labels = (p.labels || []).filter(l => l && l.text)
    .map(l => ({ text: String(l.text).slice(0, 20), x: cx(n(l.x)), y: cy(n(l.y)) }))
    .filter(l => Number.isFinite(l.x) && Number.isFinite(l.y));
  return { width: W, height: H, wallThickness: 15, walls, seats, labels };
}

// o: 폼 값, image: dataURL 또는 null
async function generatePlan(o, image, key, model) {
  const parts = [{ text: buildPrompt(o, !!image) }];
  if (image) {
    const m = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  let res;
  try {
    res = await fetch(`${API}models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.4 }
      }),
      signal: AbortSignal.timeout(ATTEMPT_MS)
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw Object.assign(new Error('Gemini 응답이 늦어 시간 초과되었습니다'), { busy: true }); // 재시도 대상
    throw new Error('Gemini 에 연결할 수 없습니다 (인터넷 연결 확인)');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = data.error?.message || res.status;
    const busy = res.status === 503 || res.status === 500 || /high demand|overloaded|unavailable/i.test(m), quota = res.status === 429;
    const err = new Error(/API key not valid/i.test(m) ? 'API 키가 올바르지 않습니다'
      : busy ? 'Gemini 사용량이 많아 지금은 생성할 수 없습니다. 1~2분 뒤 다시 시도해 주세요'
      : quota ? 'Gemini 사용 한도를 넘었습니다. 잠시 후 다시 시도하거나 다른 모델을 선택해 주세요'
      : 'Gemini 오류: ' + m);
    err.busy = busy || quota; // 일시적인 오류: app.js 가 기다렸다 재시도하거나 다른 모델로 시도
    // 단종·미지원 모델이면 Google 이 안내하는 대체 모델을 함께 넘긴다 (app.js 가 한 번 재시도)
    if (/no longer available|not found|not supported/i.test(m)) err.suggest = (String(m).match(/models\/(gemini-[\w.-]+)/g) || []).map(x => x.slice(7).replace(/\.+$/, '')).find(x => x !== model) || DEFAULT_MODEL;
    throw err;
  }
  const text = (data.candidates?.[0]?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
  try { return cleanPlan(JSON.parse(text)); }
  catch (e) { throw new Error('Gemini 응답을 해석하지 못했습니다. 다시 시도해 주세요'); }
}
