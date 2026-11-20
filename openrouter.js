// OpenRouter 호출 (브라우저에서 직접, 서버 없음): Gemini 대신 쓰는 무료(:free) 비전 모델.
// Gemini 와 같은 프롬프트(wallPrompt)·응답 형식(WALL_SCHEMA)을 쓰고, 결과 w 도 같은 모양이다 (gemini.js 참고).
// 무료 모델은 분당·하루 요청 수 한도가 있고 목록이 자주 바뀌어서, 쓸 수 있는 모델을 그때그때 조회한다.

const OR_API = 'https://openrouter.ai/api/v1/';
const OR_TIMEOUT_MS = 180000;

// 무료이면서 이미지를 받는 모델 (키 없이 조회 가능). 응답 형식을 강제할 수 있는 모델을 앞에 둔다
async function orFreeVisionModels() {
  const res = await fetch(OR_API + 'models');
  if (!res.ok) throw new Error('OpenRouter 모델 목록을 가져오지 못했습니다');
  const has = (m, p) => (m.supported_parameters || []).includes(p);
  return ((await res.json()).data || [])
    .filter(m => m.id.endsWith(':free') && (m.architecture?.input_modalities || []).includes('image'))
    .map(m => ({ id: m.id, schema: has(m, 'structured_outputs'), json: has(m, 'response_format') }))
    .sort((a, b) => (b.schema - a.schema) || (b.json - a.json));
}

// Gemini 형식 스키마(대문자 type, propertyOrdering) → 표준 JSON Schema (strict 모드: 모든 객체에 additionalProperties: false)
function toJsonSchema(s) {
  const out = { type: s.type.toLowerCase() };
  if (s.description) out.description = s.description;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.minItems) out.minItems = s.minItems;
  if (s.maxItems) out.maxItems = s.maxItems;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = s.required || Object.keys(s.properties);
    out.additionalProperties = false;
  }
  return out;
}

// 응답 형식을 강제하지 못하는 모델용 안내 (프롬프트 끝에 붙인다)
const OR_FORMAT = `

[출력]
설명 없이 JSON 하나만 답한다. 형식:
{"extent":[ymin,xmin,ymax,xmax],"width_mm":0,"walls":[[y1,x1,y2,x2],...]}`;

// 모델 답에서 JSON 만 꺼낸다 (```json 감싸기, 앞뒤 설명 무시)
function extractJSON(text) {
  const t = String(text || '').replace(/```(?:json)?/g, ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no json');
  return JSON.parse(t.slice(a, b + 1));
}

// m: { id, schema, json } (orFreeVisionModels 의 한 항목, 직접 입력한 모델이면 { id })
async function askOpenRouter(o, image, key, m, onProgress = () => {}) {
  const format = m.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'walls', strict: true, schema: toJsonSchema(WALL_SCHEMA) } } }
    : m.json ? { response_format: { type: 'json_object' } } : {};
  onProgress({ phase: 'think' });
  let res;
  try {
    res = await fetch(OR_API + 'chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': 'SmartFloor' },
      body: JSON.stringify({
        model: m.id, ...format,
        messages: [{ role: 'user', content: [{ type: 'text', text: wallPrompt(o) + OR_FORMAT }, { type: 'image_url', image_url: { url: image } }] }]
      }),
      signal: AbortSignal.timeout(OR_TIMEOUT_MS)
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw Object.assign(new Error('OpenRouter 응답이 너무 오래 걸려 시간 초과되었습니다'), { busy: true, timeout: true, kind: 'timeout' });
    throw new Error('OpenRouter 에 연결할 수 없습니다 (인터넷 연결 확인)');
  }
  const data = await res.json().catch(() => ({}));
  const err = data.error || data.choices?.[0]?.error; // 200 이어도 본문에 오류가 올 수 있다
  if (!res.ok || err) throw orError(err?.code || res.status, err?.message || String(res.status), err?.metadata);
  try { return extractJSON(data.choices?.[0]?.message?.content); }
  catch (e) { throw Object.assign(new Error('OpenRouter 응답을 해석하지 못했습니다'), { busy: true }); }
}

// OpenRouter 오류 → Gemini 와 같은 모양 (kind: quota|busy|timeout, daily, retryAfter) 으로 맞춰 app.js 가 같이 다룬다
function orError(status, m, meta = {}) {
  const quota = status === 429 || status === 402, busy = status >= 500 || status === 408;
  const err = new Error(status === 401 ? 'OpenRouter API 키가 올바르지 않습니다'
    : quota ? 'OpenRouter 무료 사용 한도를 넘었습니다'
    : busy ? 'OpenRouter 모델이 지금 응답하지 않습니다'
    : 'OpenRouter 오류: ' + m);
  err.busy = quota || busy;
  err.kind = quota ? 'quota' : busy ? (status === 408 ? 'timeout' : 'busy') : '';
  err.daily = quota && /per.?day|daily|free-models-per-day|credits/i.test(m + JSON.stringify(meta || {}));
  const reset = +(meta?.headers?.['X-RateLimit-Reset'] || 0); // 한도가 풀리는 시각 (ms)
  if (reset > Date.now()) err.retryAfter = Math.ceil((reset - Date.now()) / 1000);
  return err;
}
