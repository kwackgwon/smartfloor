// 모든 좌표는 cm. 그릴 때만 화면 배율 s 를 곱한다.
// plan = { v, width, height, wallThickness, walls: [[x1,y1,x2,y2,두께?]], shapes: [[고리...]] } (trace.js 참고)
// 저장: localStorage 'smartfloor' = plan, 'smartfloor-key' / '-model' = Gemini 설정
const KEY = 'smartfloor', PLAN_V = 2, WALL = '#D9D9D9', GRID = 10, PAD = 30; // PAD: 외벽이 잘리지 않게 도면 둘레 여백 (cm)
const $ = id => document.getElementById(id);
const cvs = $('c'), g = cvs.getContext('2d'), msg = $('msg'), file = $('file'), form = $('form');
let plan = null, image = null, s = 1, tmp = null;

const say = (t, cls = 'chip ok') => { msg.textContent = t; msg.title = t; msg.className = cls; };
const snap = (v, k = GRID) => Math.round(v / k) * k;
const pos = e => {
  const r = cvs.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * (plan.width + 2 * PAD) - PAD, y: (e.clientY - r.top) / r.height * (plan.height + 2 * PAD) - PAD };
};

function layout() { // 화면 폭에 맞춰 캔버스 크기 결정 (고해상도 화면 대응)
  if (!plan) return;
  const st = $('stage'), maxW = st.clientWidth - 28, maxH = Math.max(420, innerHeight - 200);
  const W = plan.width + 2 * PAD, H = plan.height + 2 * PAD, dpr = devicePixelRatio || 1;
  s = Math.min(maxW / W, maxH / H);
  cvs.style.width = W * s + 'px'; cvs.style.height = H * s + 'px';
  cvs.width = Math.round(W * s * dpr); cvs.height = Math.round(H * s * dpr);
  draw();
}

function draw(scale = s * (devicePixelRatio || 1), ratio = devicePixelRatio || 1) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cvs.width, cvs.height); // 배경은 투명 (PNG 도 투명 배경)
  g.setTransform(scale, 0, 0, scale, PAD * scale, PAD * scale);

  // 벽: 투명 바탕에 #D9D9D9 한 색으로만 칠한다 (테두리·격자 없음 → 겹치는 벽은 하나로 이어진다)
  const lines = [...plan.walls, ...(tmp ? [tmp] : [])];
  g.lineJoin = 'miter'; g.strokeStyle = g.fillStyle = WALL;
  lines.forEach(w => {
    // 옮겨 그린 벽(두께 있음)은 끝점이 벽 끝에 정확히 맞춰져 있어 끝을 평평하게, 직접 그린 벽은 모서리가 이어지게 사각 끝
    g.lineCap = w[4] ? 'butt' : 'square';
    g.lineWidth = w[4] || plan.wallThickness;
    g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke();
  });
  (plan.shapes || []).forEach(sh => {
    const P = new Path2D();
    sh.forEach(l => { l.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath(); });
    g.fill(P, 'evenodd');
  });
  if (hover) { // 지우기 모드: 지울 벽을 빨갛게
    g.globalAlpha = 0.55; g.strokeStyle = g.fillStyle = '#ef4444';
    if (hover.kind === 'wall' && plan.walls[hover.i]) { const w = plan.walls[hover.i]; g.lineCap = w[4] ? 'butt' : 'square'; g.lineWidth = w[4] || plan.wallThickness; g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke(); }
    if (hover.kind === 'shape' && plan.shapes[hover.i]) { const P = new Path2D(); plan.shapes[hover.i].forEach(l => { l.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath(); }); g.fill(P, 'evenodd'); }
    g.globalAlpha = 1;
  }
}

function show(p) {
  plan = p; tmp = null; hover = null;
  $('empty').hidden = $('loading').hidden = true; cvs.hidden = false;
  layout();
}

function save() {
  if (!plan) return;
  try { localStorage.setItem(KEY, JSON.stringify({ ...plan, v: PLAN_V })); say('저장됨'); }
  catch (e) { say('저장 실패 (브라우저 저장소를 사용할 수 없음)', 'chip err'); }
}

// ── 오류 안내 (AI 사용량 폭주·한도 초과·시간 초과) ─────────
let noticeTimer;
const LINK = {
  Gemini: '<a href="https://aistudio.google.com" target="_blank" rel="noopener">Google AI Studio</a>',
  OpenRouter: '<a href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener">OpenRouter</a>'
};
function showNotice(err, who) {
  const N = {
    busy: [`${who} 서버가 붐벼요`, `내 키나 설정 문제가 아니라 ${who} 쪽이 잠시 바쁜 거예요. 조금 뒤 다시 시도하면 대부분 풀려요. 계속되면 ⚙ AI 설정에서 다른 모델을 골라 보세요.`, 60],
    quota: err.daily
      ? ['오늘 쓸 수 있는 AI 사용량을 다 썼어요', `${who} 키의 하루 무료 한도를 넘었어요. 한도가 풀린 뒤 다시 쓰거나 다른 모델을 고르세요. 자주 쓴다면 ${LINK[who]}에서 결제를 연결하면 한도가 크게 늘어요.`, 0]
      : ['AI 사용 한도를 넘었어요', `짧은 시간에 요청이 많았어요. 잠시 기다리면 풀려요. 자주 막힌다면 ${LINK[who]}에서 남은 사용량을 확인하세요.`, 60],
    timeout: [`${who} 응답이 너무 오래 걸렸어요`, '도면이 복잡하거나 AI 쪽이 바쁠 때 생겨요. 잠시 뒤 다시 시도해 보세요.', 30]
  }[err.kind];
  if (!N) return;
  const [title, body, def] = N;
  const tip = who === 'Gemini' && !$('or-key').value.trim() ? '<br>⚙ AI 설정에 OpenRouter 무료 키를 넣어 두면 Gemini 가 막힐 때 자동으로 넘어가요.' : '';
  $('notice-title').textContent = title;
  $('notice-body').innerHTML = body + tip + (plan ? '<br>지금 보이는 도면(AI 없이 만든 것)은 그대로 쓸 수 있어요.' : '');
  let left = err.retryAfter || def;
  clearInterval(noticeTimer);
  const tickWait = () => {
    const t = left >= 3600 ? `${Math.floor(left / 3600)}시간 ${Math.floor(left % 3600 / 60)}분` : left >= 60 ? `${Math.floor(left / 60)}분 ${left % 60}초` : `${left}초`;
    $('notice-wait').textContent = err.daily && !err.retryAfter ? '' : left > 0 ? `약 ${t} 뒤 다시 시도하는 걸 권해요` : '지금 다시 시도할 수 있어요';
    if (left-- <= 0) clearInterval(noticeTimer);
  };
  tickWait(); noticeTimer = setInterval(tickWait, 1000);
  $('notice').hidden = false; $('ai').open = true;
}
const hideNotice = () => { clearInterval(noticeTimer); $('notice').hidden = true; };
$('retry').onclick = () => refine();

const working = on => { $('gen').disabled = $('refine').disabled = on; };
const widthM = () => +new FormData(form).get('widthM') || 0;
let pxCache = null; // 같은 이미지면 픽셀 분석을 다시 하지 않는다
async function pixels() {
  if (!pxCache || pxCache.image !== image) pxCache = { image, px: wallMasks(await readPixels(image)) };
  return pxCache.px;
}

// ── 도면 생성: AI 없이 이미지만 분석 (무료, 한도 없음) ─────
form.onsubmit = e => { e.preventDefault(); generate(); };
async function generate() {
  if (!image) { say('도면 이미지를 먼저 올려 주세요', 'chip err'); return; }
  working(true); hideNotice();
  $('empty').hidden = true; cvs.hidden = true; $('loading').hidden = false; $('loading-text').textContent = '도면 분석 중…';
  say('도면 분석 중…', 'chip');
  await new Promise(r => setTimeout(r, 30)); // 로딩 표시가 먼저 그려지게
  const t0 = Date.now();
  try {
    const px = await pixels();
    const p = traceToPlan(autoExtent(px), px, widthM());
    remember(); show(p); save(); // 이전 도면·편집은 되돌리기로 되살릴 수 있다
    say(`도면 생성 완료 · ${((Date.now() - t0) / 1000).toFixed(1)}초${widthM() ? '' : ' · 가로 길이를 넣으면 실제 크기가 정확해져요'}`);
    if (innerWidth < 800) cvs.scrollIntoView({ behavior: 'smooth', block: 'start' }); // 휴대폰: 결과로 이동
  } catch (err) {
    $('loading').hidden = true;
    if (plan) cvs.hidden = false; else $('empty').hidden = false;
    say(/^도면이 아닌/.test(err.message) ? err.message : '도면에서 벽을 찾지 못했습니다. 벽이 또렷한 도면 이미지인지 확인해 주세요', 'chip err');
  } finally { working(false); }
}

// ── AI로 다듬기: Gemini 먼저, 막히면 OpenRouter 무료 모델 ────
$('refine').onclick = () => refine();
async function refine() {
  const f = Object.fromEntries(new FormData(form)), gKey = $('key').value.trim(), orKey = $('or-key').value.trim();
  if (!image) { say('도면 이미지를 먼저 올려 주세요', 'chip err'); return; }
  if (!gKey && !orKey) { say('⚙ AI 설정에 Gemini 또는 OpenRouter(무료) 키를 넣어 주세요', 'chip err'); $('settings').open = true; return; }
  working(true); hideNotice();
  const t0 = Date.now();
  let who = gKey ? 'Gemini' : 'OpenRouter', stage = '도면 분석 중', pre = '';
  const status = () => say(`AI(${who}) ${pre}${stage}… ${Math.round((Date.now() - t0) / 1000)}초`, 'chip');
  const onProgress = e => { stage = e.phase === 'draw' ? `벽 찾는 중 (${e.count}개)` : '도면 분석 중'; status(); };
  const tick = setInterval(status, 1000); status();
  try {
    const px = await pixels();
    if (!plan) show(traceToPlan(autoExtent(px), px, widthM())); // AI 를 기다리는 동안 AI 없이 만든 도면을 먼저 보여 준다
    let w, last;
    if (gKey) {
      try { w = await viaGemini(f, gKey, onProgress, (p, st) => { pre = p; stage = st; status(); }); }
      catch (err) { last = err; if (!orKey) throw err; }
    }
    if (!w && orKey) {
      who = 'OpenRouter'; pre = gKey ? 'Gemini 대신 ' : ''; stage = '도면 분석 중'; status();
      w = await viaOpenRouter(f, orKey, onProgress, (p, st) => { pre = p; stage = st; status(); });
    }
    if (!w) throw last;
    const p = traceToPlan(w, px, widthM()); remember(); show(p); save();
    say(`AI로 다듬기 완료 · ${who} · ${Math.round((Date.now() - t0) / 1000)}초`);
  } catch (err) {
    say(`AI로 다듬지 못했어요 (${err.message})`, 'chip err');
    showNotice(err, who);
  } finally { clearInterval(tick); working(false); }
}

// Gemini 재시도 규칙 (최대 3번):
//  · 시간 초과 → 같은 모델, 생각 수준 low 로 (빠르게) · 빠르게 해도 시간 초과면 멈춤
//  · 사용량 폭주 등 일시 오류 → 잠시 기다렸다 다른 flash 모델로 (한도 초과면 같은 모델은 다시 하지 않음)
//  · 단종 모델 → Google 이 안내한 모델로
async function viaGemini(f, key, onProgress, onRetry) {
  const model = $('model').value.trim() || DEFAULT_MODEL;
  const other = [...$('models').options].map(o => o.value).find(n => n !== model && n.endsWith('-flash'));
  let cur = { model, level: 'high' }, last;
  for (let i = 0; i < 3; i++) {
    try {
      const w = await askGemini(f, image, key, cur.model, cur.level, onProgress);
      if (cur.model !== model) { $('model').value = cur.model; saveSettings(); }
      return w;
    } catch (err) {
      last = err;
      if (!err.busy && !err.suggest) throw err;
      if (i === 2 || (err.timeout && cur.level === 'low')) break;
      if (err.kind === 'quota' && (!other || cur.model === other)) break;
      const next = err.suggest ? { model: err.suggest, level: cur.level }
        : err.timeout ? { model: cur.model, level: 'low' }
        : { model: other && cur.model !== other ? other : cur.model, level: cur.level };
      onRetry(`${next.model !== cur.model ? next.model + ' 로 ' : ''}${next.level !== cur.level ? '빠르게 ' : ''}재시도 ${i + 2}/3 · `, '대기 중');
      if (!err.suggest && !err.timeout) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
      cur = next;
    }
  }
  throw last;
}

// OpenRouter: 고른 모델, 없으면 무료 비전 모델을 앞에서부터 최대 3개 시도 (하루 한도면 바로 멈춤)
async function viaOpenRouter(f, key, onProgress, onRetry) {
  const chosen = $('or-model').value.trim();
  let list = [];
  try { list = await orFreeVisionModels(); } catch (e) { if (!chosen) throw e; }
  const models = chosen ? [list.find(m => m.id === chosen) || { id: chosen }] : list.slice(0, 3);
  if (!models.length) throw new Error('지금 쓸 수 있는 OpenRouter 무료 비전 모델이 없습니다');
  let last;
  for (let i = 0; i < models.length; i++) {
    try { return await askOpenRouter(f, image, key, models[i], onProgress); }
    catch (err) {
      last = err;
      if (!err.busy || err.daily || i === models.length - 1) break;
      onRetry(`${models[i + 1].id} 로 재시도 ${i + 2}/${models.length} · `, '도면 분석 중');
    }
  }
  throw last;
}

// ── 참고 도면 이미지 ─────────────────────────────────────
function setImage(f) {
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 10 * 1024 * 1024) {
    say('PNG/JPG 이미지(10MB 이하)만 가능합니다', 'chip err'); return;
  }
  const raw = new Image();
  raw.onload = () => { // 최대 2048px JPEG 로 축소 (도면의 작은 치수가 읽히는 해상도)
    const k = Math.min(1, 2048 / Math.max(raw.width, raw.height)), c = document.createElement('canvas');
    c.width = Math.round(raw.width * k); c.height = Math.round(raw.height * k);
    const cg = c.getContext('2d'); cg.fillStyle = '#fff'; cg.fillRect(0, 0, c.width, c.height);
    cg.drawImage(raw, 0, 0, c.width, c.height);
    image = c.toDataURL('image/jpeg', 0.9);
    $('preview').src = image; $('preview').hidden = $('drop-note').hidden = false; $('drop-text').hidden = true;
    URL.revokeObjectURL(raw.src);
    say('도면 이미지가 첨부되었습니다', 'chip');
  };
  raw.onerror = () => say('이미지를 읽을 수 없습니다', 'chip err');
  raw.src = URL.createObjectURL(f);
}
file.onchange = () => { setImage(file.files[0]); file.value = ''; };
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); setImage(e.dataTransfer.files[0]); };

// ── 편집: 벽 그리기(드래그로 추가) · 벽 지우기(누른 벽 삭제) · 되돌리기 ─────
// 기본은 보기 모드: 휴대폰에서 도면 위를 쓸어도 화면만 스크롤되고 벽이 생기지 않는다
let drawing = false;
const undoStack = [];
// 새로고침해도 다시 생성하기 전 도면 하나는 되살릴 수 있게 가장 최근 것만 브라우저에 보관한다
const UNDO_KEY = KEY + '-undo';
try { const u = localStorage.getItem(UNDO_KEY); if (u) undoStack.push(u); } catch (e) { /* 저장소 사용 불가 */ }
function remember() { // 바꾸기 전 도면을 되돌리기용으로 보관 (최근 50개)
  if (!plan) return;
  undoStack.push(JSON.stringify(plan)); if (undoStack.length > 50) undoStack.shift();
  try { localStorage.setItem(UNDO_KEY, undoStack[undoStack.length - 1]); } catch (e) { /* 저장소 사용 불가 */ }
  $('undo').disabled = false;
}
function undo() {
  if (!undoStack.length) return;
  tmp = null; show({ ...JSON.parse(undoStack.pop()) }); save(); say('되돌렸습니다');
  try { undoStack.length ? localStorage.setItem(UNDO_KEY, undoStack[undoStack.length - 1]) : localStorage.removeItem(UNDO_KEY); } catch (e) { /* 저장소 사용 불가 */ }
  $('undo').disabled = !undoStack.length;
}
// 모드: 'view' (보기, 기본) · 'draw' (벽 그리기) · 'erase' (벽 지우기: 누른 벽 하나를 지운다)
let mode = 'view', hover = null; // hover: 지우기 모드에서 가리킨 벽 { kind: 'wall'|'shape', i }
function setMode(m) {
  mode = m; drawing = m === 'draw'; hover = null; tmp = null;
  for (const [id, on] of [['draw', m === 'draw'], ['erase', m === 'erase']]) { $(id).setAttribute('aria-pressed', on); $(id).classList.toggle('on', on); }
  cvs.style.touchAction = m === 'view' ? 'pan-x pan-y' : 'none';
  cvs.style.cursor = m === 'draw' ? 'crosshair' : m === 'erase' ? 'pointer' : 'default';
  if (plan) draw();
}
const setDrawing = on => setMode(on ? 'draw' : 'view');
$('draw').onclick = () => setMode(mode === 'draw' ? 'view' : 'draw');
$('erase').onclick = () => setMode(mode === 'erase' ? 'view' : 'erase');
$('undo').onclick = undo;
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
  if (e.key === 'Escape' && mode !== 'view') setMode('view');
});
setMode('view'); $('undo').disabled = !undoStack.length;

// 누른 자리의 벽 찾기: 선 벽(두께 + 손가락 여유) → 칠한 벽 모양(외벽 띠·기둥, 짝홀 규칙으로 안쪽인지)
function hitTest(p) {
  const tol = Math.min(10 / s, 30); // 화면 10px 여유, 최대 30cm (가까운 다른 벽이 잡히지 않게)
  for (let i = plan.walls.length - 1; i >= 0; i--) {
    const [x1, y1, x2, y2, t] = plan.walls[i], dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
    const k = l ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / l)) : 0;
    if (Math.hypot(p.x - (x1 + k * dx), p.y - (y1 + k * dy)) <= (t || plan.wallThickness) / 2 + tol) return { kind: 'wall', i };
  }
  const shapes = plan.shapes || [];
  for (let i = shapes.length - 1; i >= 0; i--) {
    let inside = false;
    for (const loop of shapes[i]) for (let a = 0, b = loop.length - 1; a < loop.length; b = a++) {
      const [xa, ya] = loop[a], [xb, yb] = loop[b];
      if ((ya > p.y) !== (yb > p.y) && p.x < (xb - xa) * (p.y - ya) / (yb - ya) + xa) inside = !inside;
    }
    if (inside) return { kind: 'shape', i };
  }
  return null;
}
const sameHit = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.i === b.i);

cvs.onpointerdown = e => {
  if (!plan) return;
  if (mode === 'erase') {
    const h = hitTest(pos(e));
    if (!h) { hover = null; draw(); return; }
    // 터치: 미리보기(빨간 표시)가 없으니 첫 탭은 고르기만, 같은 벽을 한 번 더 누르면 지운다
    if (e.pointerType !== 'mouse' && !sameHit(h, hover)) { hover = h; draw(); say('한 번 더 누르면 빨간 벽을 지웁니다'); return; }
    remember();
    if (h.kind === 'wall') plan.walls.splice(h.i, 1); else plan.shapes.splice(h.i, 1);
    hover = null; save(); draw(); say(h.kind === 'wall' ? '벽을 지웠습니다 (되돌리기로 복구)' : '벽 모양을 지웠습니다 (되돌리기로 복구)');
    return;
  }
  if (!drawing) return;
  const p = pos(e), x = snap(p.x), y = snap(p.y);
  tmp = [x, y, x, y];
  cvs.setPointerCapture(e.pointerId); draw();
};
cvs.onpointermove = e => {
  if (!plan) return;
  if (mode === 'erase') { const h = e.pointerType === 'mouse' ? hitTest(pos(e)) : null; if (!sameHit(h, hover)) { hover = h; draw(); } return; }
  if (!tmp) return;
  const p = pos(e);
  if (e.shiftKey) { tmp[2] = snap(p.x); tmp[3] = snap(p.y); } // 수평/수직으로 정렬 (Shift 를 누르면 사선)
  else if (Math.abs(p.x - tmp[0]) >= Math.abs(p.y - tmp[1])) { tmp[2] = snap(p.x); tmp[3] = tmp[1]; }
  else { tmp[2] = tmp[0]; tmp[3] = snap(p.y); }
  draw();
};
cvs.onpointerleave = e => { if (e.pointerType === 'mouse' && hover) { hover = null; draw(); } }; // 터치는 탭마다 leave 가 와서 고른 벽을 유지
cvs.onpointerup = () => {
  if (tmp && Math.hypot(tmp[2] - tmp[0], tmp[3] - tmp[1]) >= GRID) { const w = tmp; tmp = null; remember(); plan.walls.push(w); save(); }
  tmp = null; if (plan) draw();
};

$('save').onclick = save;

function download(href, name) {
  const a = document.createElement('a'); a.href = href; a.download = name; a.click();
}
$('export').onclick = () => { // Figma 플러그인 입력 형식
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  download(URL.createObjectURL(new Blob([JSON.stringify({ ...plan, v: PLAN_V, unit: 'cm' })], { type: 'application/json' })), 'smartfloor.json');
};
$('png').onclick = () => { // 최대 2px/cm (긴 변 4000px 이하) 해상도로 내보내기
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  const [w, h] = [cvs.width, cvs.height], W = plan.width + 2 * PAD, H = plan.height + 2 * PAD, k = Math.min(4000 / W, 4000 / H, 2);
  cvs.width = Math.round(W * k); cvs.height = Math.round(H * k);
  const hv = hover; hover = null; draw(k, 1.5); download(cvs.toDataURL('image/png'), 'smartfloor.png'); hover = hv;
  cvs.width = w; cvs.height = h; draw();
};

let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 100); });

// AI 키·모델은 이 브라우저에만 저장 (각 AI 호출에만 쓰고 다른 곳으로 보내지 않는다)
const SETTINGS = { key: '-key', model: '-model', 'or-key': '-or-key', 'or-model': '-or-model' };
try { for (const [id, k] of Object.entries(SETTINGS)) $(id).value = localStorage.getItem(KEY + k) || $(id).value; } catch (e) { /* 저장소 사용 불가 */ }
const keyState = () => {
  const on = [$('key').value.trim() && 'Gemini', $('or-key').value.trim() && 'OpenRouter'].filter(Boolean);
  $('key-state').textContent = on.length ? on.join(' · ') + ' 키' : '키 없음'; $('key-state').className = on.length ? 'state ok' : 'state';
};
keyState();
function saveSettings() {
  try { for (const [id, k] of Object.entries(SETTINGS)) localStorage.setItem(KEY + k, $(id).value.trim()); } catch (e) { /* 저장소 사용 불가 */ }
}
async function refreshModels() { // Gemini: 키로 쓸 수 있는 모델 목록을 받아 자동 완성에 채운다
  const key = $('key').value.trim();
  if (!key) return;
  try {
    const names = await listModels(key);
    $('models').innerHTML = names.map(n => `<option value="${n}">`).join('');
    const best = names.find(n => n.endsWith('-flash')) || names[0];
    const cur = $('model').value.trim(); // 목록에 없거나 최신보다 구버전이면 최신 flash 로 교체
    if (best && (!names.includes(cur) || ver(cur) < ver(best))) { $('model').value = best; saveSettings(); }
  } catch (e) { /* 키 오류 등은 다듬을 때 안내 */ }
}
async function refreshOrModels() { // OpenRouter: 무료 비전 모델 목록 (키 없이 조회)
  try { $('or-models').innerHTML = (await orFreeVisionModels()).map(m => `<option value="${m.id}">`).join(''); } catch (e) { /* 목록 없이도 자동 선택 */ }
}
$('model').onchange = $('or-model').onchange = saveSettings;
$('key').onchange = () => { saveSettings(); keyState(); refreshModels(); };
$('or-key').onchange = () => { saveSettings(); keyState(); };
refreshModels(); refreshOrModels();

try { // 새로고침 시 저장된 도면 복원 (예전 형식 저장본은 버린다)
  const d = JSON.parse(localStorage.getItem(KEY));
  if (d && d.v === PLAN_V && d.walls) { show(d); say('저장된 도면을 불러왔습니다'); }
  else if (d) localStorage.removeItem(KEY);
} catch (e) { /* 저장본 없음/손상 -> 새로 시작 */ }
