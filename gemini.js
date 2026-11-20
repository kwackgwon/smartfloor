// Gemini API 호출 (브라우저에서 직접, 서버 없음): 도면 이미지에서 건물 영역·벽 위치·치수를 받아 온다.
// 결과 w = { extent: [ymin,xmin,ymax,xmax], width_mm, walls: [[y1,x1,y2,x2]] } (0~1000 정규화) → trace.js 의 traceToPlan 으로 도면을 만든다.
// 프롬프트·응답 형식(wallPrompt, WALL_SCHEMA)은 openrouter.js 도 같이 쓴다.
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

// Gemini 에게 벽을 물어본다. level: 생각 수준 (high 로 시작, 시간 초과면 app.js 가 low 로 다시)
// onProgress({ phase: 'think'|'draw', count }) 로 진행 상황을 알린다
async function askGemini(o, image, key, model, level = 'high', onProgress = () => {}) {
  const m = image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/), count = t => Math.max(0, (t.match(/\[/g) || []).length - 2);
  return streamJSON({
    key, model, level, schema: WALL_SCHEMA, parts: [{ text: wallPrompt(o) }, { inline_data: { mime_type: m[1], data: m[2] } }],
    onThink: () => onProgress({ phase: 'think' }), onText: t => onProgress({ phase: 'draw', count: count(t) })
  });
}

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
