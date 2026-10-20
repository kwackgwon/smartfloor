// 모든 좌표는 cm (Gemini 가 준 도면 좌표). 그릴 때만 화면 배율 s 를 곱한다.
// plan = { width, height, wallThickness, walls: [[x1,y1,x2,y2]], seats: [{type,x,y,w,h,status}], labels: [{text,x,y}] }
// 저장: localStorage 'smartfloor' = plan, 'smartfloor-key' / 'smartfloor-model' = Gemini 설정
const KEY = 'smartfloor', WALL = '#D9D9D9', GRID = 10, PAD = 30; // PAD: 외벽이 잘리지 않게 도면 둘레 여백 (cm)
const STATUS = ['AVAILABLE', 'IN_USE', 'CLOSING', 'UNAVAILABLE'];
const COLOR = { AVAILABLE: '#10b981', IN_USE: '#3b82f6', CLOSING: '#f59e0b', UNAVAILABLE: '#94a3b8' };
const SIZE = { SINGLE: [80, 60], MULTI: [180, 90] };
const HINT = {
  move: '좌석을 끌어서 이동 · 더블클릭으로 회전',
  wall: '드래그해서 벽 추가 (수평/수직 자동 정렬)',
  erase: '좌석 또는 벽을 클릭해 삭제',
  status: '좌석을 클릭하면 상태가 순환'
};
const $ = id => document.getElementById(id);
const cvs = $('c'), g = cvs.getContext('2d'), msg = $('msg'), file = $('file'), form = $('form');
let plan = null, image = null, mode = 'move', s = 1, drag = null, tmp = null;

const say = (t, cls = 'chip ok') => { msg.textContent = t; msg.title = t; msg.className = cls; };
const snap = (v, k = GRID) => Math.round(v / k) * k;
const pos = e => {
  const r = cvs.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * (plan.width + 2 * PAD) - PAD, y: (e.clientY - r.top) / r.height * (plan.height + 2 * PAD) - PAD };
};
const hitSeat = p => [...plan.seats].reverse().find(t => Math.abs(p.x - t.x) <= t.w / 2 && Math.abs(p.y - t.y) <= t.h / 2);
const distSeg = (p, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  const k = l ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / l)) : 0;
  return Math.hypot(p.x - (x1 + k * dx), p.y - (y1 + k * dy));
};

function stats() {
  const seats = plan ? plan.seats : [], n = st => seats.filter(t => t.status === st).length;
  $('st-total').textContent = seats.length;
  STATUS.forEach(st => { $('st-' + st).textContent = n(st); });
  $('st-rate').textContent = (seats.length ? Math.round((n('IN_USE') + n('CLOSING')) / seats.length * 100) : 0) + '%';
}

function layout() { // 화면 폭에 맞춰 캔버스 크기 결정 (고해상도 화면 대응)
  if (!plan) return;
  const st = $('stage'), maxW = st.clientWidth - 28, maxH = Math.max(420, innerHeight - 260);
  const W = plan.width + 2 * PAD, H = plan.height + 2 * PAD, dpr = devicePixelRatio || 1;
  s = Math.min(maxW / W, maxH / H);
  cvs.style.width = W * s + 'px'; cvs.style.height = H * s + 'px';
  cvs.width = Math.round(W * s * dpr); cvs.height = Math.round(H * s * dpr);
  draw();
}

function draw(scale = s * (devicePixelRatio || 1), ratio = devicePixelRatio || 1) {
  const px = v => v / scale * ratio; // 화면 px -> cm
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(0, 0, cvs.width, cvs.height);
  g.setTransform(scale, 0, 0, scale, PAD * scale, PAD * scale);

  g.strokeStyle = '#f1f5f9'; g.lineWidth = px(1); // 1m 격자
  for (let x = 100; x < plan.width; x += 100) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, plan.height); g.stroke(); }
  for (let y = 100; y < plan.height; y += 100) { g.beginPath(); g.moveTo(0, y); g.lineTo(plan.width, y); g.stroke(); }

  g.strokeStyle = WALL; g.lineWidth = plan.wallThickness; g.lineCap = 'square';
  [...plan.walls, ...(tmp ? [tmp] : [])].forEach(([x1, y1, x2, y2]) => {
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  });

  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#94a3b8'; g.font = `600 ${px(13)}px sans-serif`;
  plan.labels.forEach(l => g.fillText(l.text, l.x, l.y));

  plan.seats.forEach((t, i) => {
    g.fillStyle = COLOR[t.status] || COLOR.AVAILABLE;
    g.beginPath(); g.roundRect(t.x - t.w / 2, t.y - t.h / 2, t.w, t.h, Math.min(t.w, t.h) * 0.18); g.fill();
    g.fillStyle = '#fff'; g.font = `600 ${Math.min(t.h * 0.45, px(14))}px sans-serif`;
    g.fillText(i + 1, t.x, t.y);
  });
  stats();
}

function show(p) {
  plan = p; drag = tmp = null;
  $('empty').hidden = $('loading').hidden = true; cvs.hidden = false;
  layout();
}

function save() {
  if (!plan) return;
  try { localStorage.setItem(KEY, JSON.stringify(plan)); say('저장됨'); }
  catch (e) { say('저장 실패 (브라우저 저장소를 사용할 수 없음)', 'chip err'); }
}

// ── Gemini 생성 ──────────────────────────────────────────
form.onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form)), key = $('key').value.trim(), model = $('model').value.trim() || DEFAULT_MODEL;
  if (!key) { say('Gemini API 키를 입력하세요', 'chip err'); $('key').focus(); return; }
  if (!image && !f.width && !f.single && !f.multi && !f.note.trim()) {
    say('매장 크기·좌석 수·요청 사항 중 하나 이상을 입력하거나 도면 이미지를 올려 주세요', 'chip err'); return;
  }
  if (plan && !confirm('현재 도면과 편집 내용이 새 도면으로 바뀝니다. 계속할까요?')) return;
  const btn = $('gen'); btn.disabled = true;
  $('empty').hidden = true; cvs.hidden = true; $('loading').hidden = false;
  say('Gemini가 도면을 그리는 중…', 'chip');
  try {
    // 일시 오류(사용량 폭주 등)면 기다렸다 재시도 → 그래도 안 되면 다른 flash 모델로, 단종 모델이면 안내된 모델로 시도
    const others = [...$('models').options].map(o => o.value).filter(n => n !== model && n.endsWith('-flash')).slice(0, 2);
    const tries = [model, model, ...(others.length ? others : [model])];
    let d, last;
    for (let i = 0; i < tries.length && !d; i++) {
      try { d = await generatePlan(f, image, key, tries[i]); }
      catch (err) {
        last = err;
        if (err.suggest && !tries.includes(err.suggest)) tries.splice(i + 1, 0, err.suggest);
        else if (!err.busy) throw err;
        const next = tries[i + 1];
        if (!next) break;
        say(next === tries[i] ? `Gemini 사용량이 많아 잠시 후 다시 시도하는 중… (${i + 2}/${tries.length})` : `${next} 모델로 다시 시도하는 중… (${i + 2}/${tries.length})`, 'chip');
        if (!err.suggest) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
      }
      if (d && tries[i] !== model) { $('model').value = tries[i]; saveSettings(); }
    }
    if (!d) throw last;
    show(d); save();
    say(`도면 생성 완료 · 벽 ${d.walls.length}개 · 좌석 ${d.seats.length}석`);
  } catch (err) {
    $('loading').hidden = true;
    if (plan) cvs.hidden = false; else $('empty').hidden = false;
    say(err.message, 'chip err');
  } finally { btn.disabled = false; }
};

// ── 참고 도면 이미지 ─────────────────────────────────────
function setImage(f) {
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/.test(f.type) || f.size > 10 * 1024 * 1024) {
    say('PNG/JPG 이미지(10MB 이하)만 가능합니다', 'chip err'); return;
  }
  const raw = new Image();
  raw.onload = () => { // 전송량을 줄이기 위해 최대 1600px JPEG 로 축소
    const k = Math.min(1, 1600 / Math.max(raw.width, raw.height)), c = document.createElement('canvas');
    c.width = Math.round(raw.width * k); c.height = Math.round(raw.height * k);
    const cg = c.getContext('2d'); cg.fillStyle = '#fff'; cg.fillRect(0, 0, c.width, c.height);
    cg.drawImage(raw, 0, 0, c.width, c.height);
    image = c.toDataURL('image/jpeg', 0.85);
    $('preview').src = image; $('preview').hidden = $('clear-img').hidden = false; $('drop-text').hidden = true;
    URL.revokeObjectURL(raw.src);
    say('참고 도면이 첨부되었습니다', 'chip');
  };
  raw.onerror = () => say('이미지를 읽을 수 없습니다', 'chip err');
  raw.src = URL.createObjectURL(f);
}
file.onchange = () => { setImage(file.files[0]); file.value = ''; };
$('clear-img').onclick = () => {
  image = null; $('preview').hidden = $('clear-img').hidden = true; $('drop-text').hidden = false;
};
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); setImage(e.dataTransfer.files[0]); };

// ── 편집 ────────────────────────────────────────────────
cvs.onpointerdown = e => {
  if (!plan) return;
  const p = pos(e), t = hitSeat(p);
  if (mode === 'move') drag = t ? { t, dx: t.x - p.x, dy: t.y - p.y } : null;
  else if (mode === 'wall') { const x = snap(p.x), y = snap(p.y); tmp = [x, y, x, y]; }
  else if (mode === 'status') { if (t) t.status = STATUS[(STATUS.indexOf(t.status) + 1) % STATUS.length]; }
  else if (t) plan.seats = plan.seats.filter(x => x !== t);
  else plan.walls = plan.walls.filter(w => distSeg(p, w) > plan.wallThickness / 2 + 6 / s);
  cvs.setPointerCapture(e.pointerId); draw();
};
cvs.onpointermove = e => {
  if (!plan) return;
  const p = pos(e);
  if (mode === 'move') cvs.style.cursor = drag || hitSeat(p) ? 'grab' : 'default';
  if (drag) { drag.t.x = snap(p.x + drag.dx, 5); drag.t.y = snap(p.y + drag.dy, 5); }
  else if (tmp) { // 수평/수직으로 정렬
    if (Math.abs(p.x - tmp[0]) >= Math.abs(p.y - tmp[1])) { tmp[2] = snap(p.x); tmp[3] = tmp[1]; }
    else { tmp[2] = tmp[0]; tmp[3] = snap(p.y); }
  } else return;
  draw();
};
cvs.onpointerup = () => {
  if (tmp && Math.hypot(tmp[2] - tmp[0], tmp[3] - tmp[1]) >= GRID) plan.walls.push(tmp);
  drag = tmp = null; if (plan) draw();
};
cvs.ondblclick = e => { // 좌석 회전 (가로/세로 교체)
  if (!plan || mode !== 'move') return;
  const t = hitSeat(pos(e));
  if (t) { [t.w, t.h] = [t.h, t.w]; draw(); }
};

document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  const [w, h] = SIZE[b.dataset.add], k = (plan.seats.length % 5) * 20;
  plan.seats.push({ type: b.dataset.add, x: snap(plan.width / 2 + k), y: snap(plan.height / 2 + k), w, h, status: 'AVAILABLE' });
  draw();
});
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
  mode = b.dataset.mode; $('hint').textContent = HINT[mode]; cvs.style.cursor = mode === 'move' ? 'default' : 'crosshair';
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
});
$('hint').textContent = HINT.move;
$('save').onclick = save;

function download(href, name) {
  const a = document.createElement('a'); a.href = href; a.download = name; a.click();
}
$('export').onclick = () => { // Figma 플러그인 입력 형식
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  download(URL.createObjectURL(new Blob([JSON.stringify(plan)], { type: 'application/json' })), 'smartfloor.json');
};
$('png').onclick = () => { // 최대 2px/cm (긴 변 4000px 이하) 해상도로 내보내기
  if (!plan) return say('먼저 도면을 생성하세요', 'chip err');
  const [w, h] = [cvs.width, cvs.height], W = plan.width + 2 * PAD, H = plan.height + 2 * PAD, k = Math.min(4000 / W, 4000 / H, 2);
  cvs.width = Math.round(W * k); cvs.height = Math.round(H * k);
  draw(k, 1.5); download(cvs.toDataURL('image/png'), 'smartfloor.png');
  cvs.width = w; cvs.height = h; draw();
};

let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(layout, 100); });

// API 키·모델은 이 브라우저에만 저장 (다른 곳으로 전송되지 않음, Gemini 호출에만 사용)
try { $('key').value = localStorage.getItem(KEY + '-key') || ''; $('model').value = localStorage.getItem(KEY + '-model') || $('model').value; } catch (e) { /* 저장소 사용 불가 */ }
function saveSettings() {
  try { localStorage.setItem(KEY + '-key', $('key').value.trim()); localStorage.setItem(KEY + '-model', $('model').value.trim()); } catch (e) { /* 저장소 사용 불가 */ }
}
async function refreshModels() { // 키로 쓸 수 있는 모델 목록을 받아 자동 완성에 채운다
  const key = $('key').value.trim();
  if (!key) return;
  try {
    const names = await listModels(key);
    $('models').innerHTML = names.map(n => `<option value="${n}">`).join('');
    const best = names.find(n => n.endsWith('-flash')) || names[0], ver = n => parseFloat((n.match(/gemini-([\d.]+)/) || [0, 0])[1]);
    const cur = $('model').value.trim(); // 목록에 없거나 최신보다 구버전이면 최신 flash 로 교체
    if (best && (!names.includes(cur) || ver(cur) < ver(best))) { $('model').value = best; saveSettings(); }
  } catch (e) { /* 키 오류 등은 생성할 때 안내 */ }
}
$('model').onchange = saveSettings;
$('key').onchange = () => { saveSettings(); refreshModels(); };
refreshModels();

try { // 새로고침 시 저장된 도면 복원
  const d = JSON.parse(localStorage.getItem(KEY));
  if (d && d.walls) { show(d); say('저장된 도면을 불러왔습니다'); }
} catch (e) { /* 저장본 없음/손상 -> 새로 시작 */ }
