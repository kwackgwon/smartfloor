// 모든 좌표는 cm. 그릴 때만 화면 배율 s 를 곱한다.
// plan = { v, width, height, wallThickness, walls, shapes, doors, seats, tables } (trace.js 참고)
// 저장: localStorage 'smartfloor' = plan, 'smartfloor-undo' = 다시 생성 직전 도면
const KEY = 'smartfloor', PLAN_V = 2, WALL = '#D9D9D9', SEAT = '#AEAEAE', DOOR = '#FFFFFF', GRID = 10;
let PAD = 30; // 도면 둘레 여백 (cm): 외벽이 잘리지 않게, 바깥으로 여는 문 호까지 들어가게 (show 에서 다시 잰다)
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
  // 문: 문 폭만큼 벽을 비우고(투명) 흰 1/4 원 (경첩 → 닫힌 자리 → 여는 쪽)
  for (const d of plan.doors || []) {
    const [ux, uy] = d.u, [nx, ny] = d.n, h = (d.t || plan.wallThickness) / 2 + 2;
    g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath();
    g.moveTo(d.x - nx * h, d.y - ny * h); g.lineTo(d.x + ux * d.r - nx * h, d.y + uy * d.r - ny * h);
    g.lineTo(d.x + ux * d.r + nx * h, d.y + uy * d.r + ny * h); g.lineTo(d.x + nx * h, d.y + ny * h); g.closePath(); g.fill(); g.restore();
    const a0 = Math.atan2(uy, ux), a1 = Math.atan2(ny, nx), ccw = ((a1 - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI < 0;
    g.fillStyle = DOOR; g.beginPath(); g.moveTo(d.x, d.y); g.arc(d.x, d.y, d.r, a0, a1, ccw); g.closePath(); g.fill();
  }
  // 탁자(연한 회색)·좌석(회색 네모 + 흰 번호)
  g.fillStyle = WALL; for (const t of plan.tables || []) g.fillRect(t.x, t.y, t.w, t.h);
  for (const st of plan.seats || []) {
    g.fillStyle = SEAT; g.fillRect(st.x, st.y, st.w, st.h);
    if (st.label) {
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `500 ${Math.min(st.w / (st.label.length * 0.62), st.h * 0.45)}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
      g.fillText(st.label, st.x + st.w / 2, st.y + st.h / 2 + 0.5);
    }
  }
  if (hover) { // 지우기 모드: 지울 벽을 빨갛게
    g.globalAlpha = 0.55; g.strokeStyle = g.fillStyle = '#ef4444';
    if (hover.kind === 'wall' && plan.walls[hover.i]) { const w = plan.walls[hover.i]; g.lineCap = w[4] ? 'butt' : 'square'; g.lineWidth = w[4] || plan.wallThickness; g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke(); }
    const it = hover.kind === 'seat' ? plan.seats[hover.i] : hover.kind === 'table' ? plan.tables[hover.i] : null;
    if (it && mode === 'zone') { // 구역 이름: 같은 구역 좌석 전체를 파랗게
      g.fillStyle = '#3b82f6';
      for (const st of plan.seats) if (sameZone(st, it)) g.fillRect(st.x, st.y, st.w, st.h);
    } else if (it) g.fillRect(it.x, it.y, it.w, it.h);
    if (hover.kind === 'door' && plan.doors[hover.i]) { const d = plan.doors[hover.i]; g.beginPath(); g.arc(d.x, d.y, d.r, 0, Math.PI * 2); g.fill(); }
    if (hover.kind === 'shape' && plan.shapes[hover.i]) { const P = new Path2D(); plan.shapes[hover.i].forEach(l => { l.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath(); }); g.fill(P, 'evenodd'); }
    g.globalAlpha = 1;
  }
}

function show(p) {
  plan = p; tmp = null; hover = null;
  PAD = 30;
  for (const d of p.doors || []) for (const [a, b] of [[1, 0], [0, 1], [0.7071, 0.7071]]) {
    const x = d.x + (d.u[0] * a + d.n[0] * b) * d.r, y = d.y + (d.u[1] * a + d.n[1] * b) * d.r;
    PAD = Math.max(PAD, -x + 10, x - p.width + 10, -y + 10, y - p.height + 10);
  }
  $('empty').hidden = $('loading').hidden = true; cvs.hidden = false;
  layout();
}

function save() {
  if (!plan) return;
  try { localStorage.setItem(KEY, JSON.stringify({ ...plan, v: PLAN_V })); say('저장됨'); }
  catch (e) { say('저장 실패 (브라우저 저장소를 사용할 수 없음)', 'chip err'); }
}

const working = on => { $('gen').disabled = on; };
const widthM = () => +new FormData(form).get('widthM') || 0;
let pxCache = null; // 같은 이미지면 픽셀 분석을 다시 하지 않는다
async function pixels() {
  if (!pxCache || pxCache.image !== image) pxCache = { image, px: wallMasks(await readPixels(image)) };
  return pxCache.px;
}

// ── 도면 생성: 이미지만 분석 (무료, 한도 없음) ─────
form.onsubmit = e => { e.preventDefault(); generate(); };
async function generate() {
  if (!image) { say('도면 이미지를 먼저 올려 주세요', 'chip err'); return; }
  working(true);
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
  for (const [id, on] of [['draw', m === 'draw'], ['erase', m === 'erase'], ['zone', m === 'zone']]) { $(id).setAttribute('aria-pressed', on); $(id).classList.toggle('on', on); }
  cvs.style.touchAction = m === 'view' ? 'pan-x pan-y' : 'none';
  cvs.style.cursor = m === 'draw' ? 'crosshair' : m === 'erase' || m === 'zone' ? 'pointer' : 'default';
  if (plan) draw();
}
const setDrawing = on => setMode(on ? 'draw' : 'view');
$('draw').onclick = () => setMode(mode === 'draw' ? 'view' : 'draw');
$('erase').onclick = () => setMode(mode === 'erase' ? 'view' : 'erase');
$('zone').onclick = () => setMode(mode === 'zone' ? 'view' : 'zone');
$('undo').onclick = undo;
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
  if (e.key === 'Escape' && mode !== 'view') setMode('view');
});
setMode('view'); $('undo').disabled = !undoStack.length;

// 누른 자리의 벽 찾기: 선 벽(두께 + 손가락 여유) → 칠한 벽 모양(외벽 띠·기둥, 짝홀 규칙으로 안쪽인지)
function hitTest(p) {
  const tol = Math.min(10 / s, 30); // 화면 10px 여유, 최대 30cm (가까운 다른 벽이 잡히지 않게)
  const inBox = r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  for (let i = (plan.seats || []).length - 1; i >= 0; i--) if (inBox(plan.seats[i])) return { kind: 'seat', i };
  for (let i = (plan.doors || []).length - 1; i >= 0; i--) { // 문: 1/4 원 안
    const d = plan.doors[i], vx = p.x - d.x, vy = p.y - d.y;
    if (Math.hypot(vx, vy) <= d.r && vx * d.u[0] + vy * d.u[1] >= -tol && vx * d.n[0] + vy * d.n[1] >= -tol) return { kind: 'door', i };
  }
  for (let i = (plan.tables || []).length - 1; i >= 0; i--) if (inBox(plan.tables[i])) return { kind: 'table', i };
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
// 같은 구역: 구역(방) 번호가 있으면 그것으로, 없으면(직접 만든 좌석 등) 번호 앞 글자로
const sameZone = (a, b) => a.zone != null && b.zone != null ? a.zone === b.zone : (a.label || '').replace(/\d+$/, '') === (b.label || '').replace(/\d+$/, '');
const sameHit = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.i === b.i);

cvs.onpointerdown = e => {
  if (!plan) return;
  if (mode === 'zone') { // 구역 이름: 누른 좌석과 같은 글자로 시작하는 좌석 번호의 글자를 한꺼번에 바꾼다 (A01 → H01)
    const h = hitTest(pos(e));
    if (!h || h.kind !== 'seat') { say('좌석을 눌러 주세요', 'chip err'); return; }
    const seat = plan.seats[h.i], cur = (seat.label || '').replace(/\d+$/, ''), name = (prompt('이 구역 좌석 번호 앞에 붙일 글자 (예: H)', cur) || '').trim();
    if (!name || name === cur) return;
    remember();
    let n = 0;
    for (const st of plan.seats) if (sameZone(st, seat)) { st.label = name + (st.label || '').replace(/^\D*/, ''); n++; }
    save(); draw(); say(`${cur} 구역 ${n}석 → ${name}`);
    return;
  }
  if (mode === 'erase') {
    const h = hitTest(pos(e));
    if (!h) { hover = null; draw(); return; }
    // 터치: 미리보기(빨간 표시)가 없으니 첫 탭은 고르기만, 같은 벽을 한 번 더 누르면 지운다
    if (e.pointerType !== 'mouse' && !sameHit(h, hover)) { hover = h; draw(); say('한 번 더 누르면 빨간 벽을 지웁니다'); return; }
    remember();
    const LIST = { wall: 'walls', shape: 'shapes', seat: 'seats', table: 'tables', door: 'doors' }, NAME = { wall: '벽을', shape: '벽 모양을', seat: '좌석을', table: '탁자를', door: '문을' };
    plan[LIST[h.kind]].splice(h.i, 1);
    hover = null; save(); draw(); say(`${NAME[h.kind]} 지웠습니다 (되돌리기로 복구)`);
    return;
  }
  if (!drawing) return;
  const p = pos(e), x = snap(p.x), y = snap(p.y);
  tmp = [x, y, x, y];
  cvs.setPointerCapture(e.pointerId); draw();
};
cvs.onpointermove = e => {
  if (!plan) return;
  if (mode === 'erase' || mode === 'zone') { let h = e.pointerType === 'mouse' ? hitTest(pos(e)) : null; if (mode === 'zone' && h && h.kind !== 'seat') h = null; if (!sameHit(h, hover)) { hover = h; draw(); } return; }
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

try { // 새로고침 시 저장된 도면 복원 (예전 형식 저장본은 버린다)
  const d = JSON.parse(localStorage.getItem(KEY));
  if (d && d.v === PLAN_V && d.walls) { show(d); say('저장된 도면을 불러왔습니다'); }
  else if (d) localStorage.removeItem(KEY);
} catch (e) { /* 저장본 없음/손상 -> 새로 시작 */ }
