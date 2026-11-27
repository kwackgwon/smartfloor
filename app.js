const KEY = 'smartfloor', PLAN_V = 2, WALL = '#D9D9D9', SEAT = '#AEAEAE', DOOR = '#FFFFFF', GRID = 10;
let PAD = 30;
const $ = id => document.getElementById(id);
const cvs = $('c'), g = cvs.getContext('2d'), msg = $('msg'), file = $('file'), form = $('form');
let plan = null, image = null, s = 1, tmp = null;

const say = (t, cls = 'chip ok') => { msg.textContent = t; msg.title = t; msg.className = cls; };
const snap = (v, k = GRID) => Math.round(v / k) * k;
const pos = e => {
  const r = cvs.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * (plan.width + 2 * PAD) - PAD, y: (e.clientY - r.top) / r.height * (plan.height + 2 * PAD) - PAD };
};

function layout() {
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
  g.clearRect(0, 0, cvs.width, cvs.height);
  g.setTransform(scale, 0, 0, scale, PAD * scale, PAD * scale);

  const lines = [...plan.walls, ...(tmp ? [tmp] : [])];
  g.lineJoin = 'miter'; g.strokeStyle = g.fillStyle = WALL;
  lines.forEach(w => {

    g.lineCap = w[4] ? 'butt' : 'square';
    g.lineWidth = w[4] || plan.wallThickness;
    g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke();
  });
  (plan.shapes || []).forEach(sh => {
    const P = new Path2D();
    sh.forEach(l => { l.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath(); });
    g.fill(P, 'evenodd');
  });

  for (const d of plan.doors || []) {
    const [ux, uy] = d.u, [nx, ny] = d.n, h = (d.t || plan.wallThickness) / 2 + 2;
    g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath();
    g.moveTo(d.x - nx * h, d.y - ny * h); g.lineTo(d.x + ux * d.r - nx * h, d.y + uy * d.r - ny * h);
    g.lineTo(d.x + ux * d.r + nx * h, d.y + uy * d.r + ny * h); g.lineTo(d.x + nx * h, d.y + ny * h); g.closePath(); g.fill(); g.restore();
    const a0 = Math.atan2(uy, ux), a1 = Math.atan2(ny, nx), ccw = ((a1 - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI < 0;

    const b = (d.t || plan.wallThickness) / 2;
    g.fillStyle = DOOR; g.beginPath();
    g.moveTo(d.x - nx * b, d.y - ny * b); g.lineTo(d.x + ux * d.r - nx * b, d.y + uy * d.r - ny * b);
    g.lineTo(d.x + ux * d.r, d.y + uy * d.r); g.arc(d.x, d.y, d.r, a0, a1, ccw); g.lineTo(d.x, d.y); g.closePath(); g.fill();
  }

  g.fillStyle = WALL; for (const t of plan.tables || []) g.fillRect(t.x, t.y, t.w, t.h);
  for (const st of plan.seats || []) {
    g.fillStyle = SEAT; g.fillRect(st.x, st.y, st.w, st.h);
    if (st.label) {
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `500 ${Math.min(st.w / (st.label.length * 0.62), st.h * 0.45)}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
      g.fillText(st.label, st.x + st.w / 2, st.y + st.h / 2 + 0.5);
    }
  }
  if (hover) {
    g.globalAlpha = 0.55; g.strokeStyle = g.fillStyle = '#ef4444';
    if (hover.kind === 'wall' && plan.walls[hover.i]) { const w = plan.walls[hover.i]; g.lineCap = w[4] ? 'butt' : 'square'; g.lineWidth = w[4] || plan.wallThickness; g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke(); }
    const it = hover.kind === 'seat' ? plan.seats[hover.i] : hover.kind === 'table' ? plan.tables[hover.i] : null;
    if (it && mode === 'zone') {
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
let pxCache = null;
async function pixels() {
  if (!pxCache || pxCache.image !== image) pxCache = { image, px: wallMasks(await readPixels(image)) };
  return pxCache.px;
}

form.onsubmit = e => { e.preventDefault(); generate(); };
async function generate() {
  if (!image) { say('도면 이미지를 먼저 올려 주세요', 'chip err'); return; }
  working(true);
  $('empty').hidden = true; cvs.hidden = true; $('loading').hidden = false; $('loading-text').textContent = '도면 분석 중…';
  say('도면 분석 중…', 'chip');
  await new Promise(r => setTimeout(r, 30));
  const t0 = Date.now();
  try {
    const px = await pixels();
    const p = traceToPlan(autoExtent(px), px, widthM());
    remember(); show(p); save();
    const scale = p.scaleFrom === 'doors' ? ' · 크기는 문 폭으로 추정했어요 (가로 길이를 넣으면 정확해져요)' : p.scaleFrom === 'guess' ? ' · 가로 길이를 넣으면 실제 크기가 정확해져요' : '';
    const narrow = innerWidth < 800, secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(narrow ? `생성 완료 · ${secs}초${p.seats.length ? ' · 🔤로 구역 글자 바꾸기' : ''}`
      : `도면 생성 완료 · ${secs}초${scale}${p.seats.length ? ' · 좌석 글자는 🔤 구역 이름으로 바꿔요' : ''}`);
    if (narrow) document.querySelector('.view').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('loading').hidden = true;
    if (plan) cvs.hidden = false; else $('empty').hidden = false;
    say(/^도면이 아닌/.test(err.message) ? err.message : '도면에서 벽을 찾지 못했습니다. 벽이 또렷한 도면 이미지인지 확인해 주세요', 'chip err');
  } finally { working(false); }
}

function setImage(f) {
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 10 * 1024 * 1024) {
    say('PNG/JPG 이미지(10MB 이하)만 가능합니다', 'chip err'); return;
  }
  const raw = new Image();
  raw.onload = () => {
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

let drawing = false;
const undoStack = [];

const UNDO_KEY = KEY + '-undo';
try { const u = localStorage.getItem(UNDO_KEY); if (u) undoStack.push(u); } catch (e) {  }
function remember() {
  if (!plan) return;
  undoStack.push(JSON.stringify(plan)); if (undoStack.length > 50) undoStack.shift();
  try { localStorage.setItem(UNDO_KEY, undoStack[undoStack.length - 1]); } catch (e) {  }
  $('undo').disabled = false;
}
function undo() {
  if (!undoStack.length) return;
  tmp = null; show({ ...JSON.parse(undoStack.pop()) }); save(); say('되돌렸습니다');
  try { undoStack.length ? localStorage.setItem(UNDO_KEY, undoStack[undoStack.length - 1]) : localStorage.removeItem(UNDO_KEY); } catch (e) {  }
  $('undo').disabled = !undoStack.length;
}

let mode = 'view', hover = null;
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

function hitTest(p) {
  const tol = Math.min(10 / s, 30);
  const inBox = r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  for (let i = (plan.seats || []).length - 1; i >= 0; i--) if (inBox(plan.seats[i])) return { kind: 'seat', i };
  for (let i = (plan.doors || []).length - 1; i >= 0; i--) {
    const d = plan.doors[i], vx = p.x - d.x, vy = p.y - d.y;
    if (Math.hypot(vx, vy) <= d.r && vx * d.u[0] + vy * d.u[1] >= -tol && vx * d.n[0] + vy * d.n[1] >= -tol - (d.t || plan.wallThickness) / 2) return { kind: 'door', i };
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

const sameZone = (a, b) => a.zone != null && b.zone != null ? a.zone === b.zone : (a.label || '').replace(/\d+$/, '') === (b.label || '').replace(/\d+$/, '');
const sameHit = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.i === b.i);

cvs.onpointerdown = e => {
  if (!plan) return;
  if (mode === 'zone') {
    const h = hitTest(pos(e));
    if (!h || h.kind !== 'seat') { say('좌석을 눌러 주세요', 'chip err'); return; }
    const seat = plan.seats[h.i], cur = (seat.label || '').replace(/\d+$/, ''), name = (prompt('이 구역 좌석 번호 앞에 붙일 글자 (예: H)', cur) || '').trim().toUpperCase();
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
  if (e.shiftKey) { tmp[2] = snap(p.x); tmp[3] = snap(p.y); }
  else if (Math.abs(p.x - tmp[0]) >= Math.abs(p.y - tmp[1])) { tmp[2] = snap(p.x); tmp[3] = tmp[1]; }
  else { tmp[2] = tmp[0]; tmp[3] = snap(p.y); }
  draw();
};
cvs.onpointerleave = e => { if (e.pointerType === 'mouse' && hover) { hover = null; draw(); } };
cvs.onpointerup = () => {
  if (tmp && Math.hypot(tmp[2] - tmp[0], tmp[3] - tmp[1]) >= GRID) { const w = tmp; tmp = null; remember(); plan.walls.push(w); save(); }
  tmp = null; if (plan) draw();
};

$('save').onclick = save;

function download(href, name) {
  const a = document.createElement('a'); a.href = href; a.download = name; a.click();
}
$('export').onclick = () => {
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  download(URL.createObjectURL(new Blob([JSON.stringify({ ...plan, v: PLAN_V, unit: 'cm' })], { type: 'application/json' })), 'smartfloor.json');
};
$('png').onclick = () => {
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  const [w, h] = [cvs.width, cvs.height], W = plan.width + 2 * PAD, H = plan.height + 2 * PAD, k = Math.min(4000 / W, 4000 / H, 2);
  cvs.width = Math.round(W * k); cvs.height = Math.round(H * k);
  const hv = hover; hover = null; draw(k, 1.5); download(cvs.toDataURL('image/png'), 'smartfloor.png'); hover = hv;
  cvs.width = w; cvs.height = h; draw();
};

let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 100); });

try {
  const d = JSON.parse(localStorage.getItem(KEY));
  if (d && d.v === PLAN_V && d.walls) { show(d); say('저장된 도면을 불러왔습니다'); }
  else if (d) localStorage.removeItem(KEY);
} catch (e) {  }
