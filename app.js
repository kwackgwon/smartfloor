// 모든 좌표는 cm. 그릴 때만 화면 배율 s 를 곱한다.
// plan = { v, width, height, wallThickness, walls: [[x1,y1,x2,y2,두께?]], shapes: [[고리...]] } (gemini.js 참고)
// 저장: localStorage 'smartfloor' = plan, 'smartfloor-key' / '-model' = Gemini 설정
const KEY = 'smartfloor', PLAN_V = 2, WALL = '#D9D9D9', EDGE = '#BDBDBD', GRID = 10, PAD = 30; // PAD: 외벽이 잘리지 않게 도면 둘레 여백 (cm)
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
  const px = v => v / scale * ratio; // 화면 px -> cm
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(0, 0, cvs.width, cvs.height);
  g.setTransform(scale, 0, 0, scale, PAD * scale, PAD * scale);

  g.strokeStyle = '#f1f5f9'; g.lineWidth = px(1); // 1m 격자
  for (let x = 100; x < plan.width; x += 100) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, plan.height); g.stroke(); }
  for (let y = 100; y < plan.height; y += 100) { g.beginPath(); g.moveTo(0, y); g.lineTo(plan.width, y); g.stroke(); }

  // 벽: 테두리를 먼저 조금 두껍게 그리고 그 위를 #D9D9D9 로 채운다 → 겹치는 벽은 테두리 없이 하나로 이어진다
  const lines = [...plan.walls, ...(tmp ? [tmp] : [])], edge = px(1.5);
  const paths = (plan.shapes || []).map(sh => {
    const P = new Path2D();
    sh.forEach(l => { l.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath(); });
    return P;
  });
  g.lineCap = 'square'; g.lineJoin = 'miter';
  for (const fill of [false, true]) {
    g.strokeStyle = g.fillStyle = fill ? WALL : EDGE;
    lines.forEach(w => {
      g.lineWidth = (w[4] || plan.wallThickness) + (fill ? 0 : edge * 2);
      g.beginPath(); g.moveTo(w[0], w[1]); g.lineTo(w[2], w[3]); g.stroke();
    });
    paths.forEach(P => { if (fill) g.fill(P, 'evenodd'); else { g.lineWidth = edge * 2; g.stroke(P); } });
  }
}

function show(p) {
  plan = p; tmp = null;
  $('empty').hidden = $('loading').hidden = true; cvs.hidden = false;
  layout();
}

function save() {
  if (!plan) return;
  try { localStorage.setItem(KEY, JSON.stringify({ ...plan, v: PLAN_V })); say('저장됨'); }
  catch (e) { say('저장 실패 (브라우저 저장소를 사용할 수 없음)', 'chip err'); }
}

// ── Gemini 생성 ──────────────────────────────────────────
form.onsubmit = async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form)), key = $('key').value.trim(), model = $('model').value.trim() || DEFAULT_MODEL;
  if (!image) { say('도면 이미지를 먼저 올려 주세요', 'chip err'); return; }
  if (!key) { say('Gemini API 키를 입력하세요', 'chip err'); $('settings').open = true; $('key').focus(); return; }
  if (plan && !confirm('현재 도면과 편집 내용이 새 도면으로 바뀝니다. 계속할까요?')) return;
  const btn = $('gen'); btn.disabled = true;
  $('empty').hidden = true; cvs.hidden = true; $('loading').hidden = false;
  // 진행 상황 표시: 분석 중 → 벽 n개 그리는 중 → 다듬는 중 + 경과 시간 (멈춘 것처럼 보이지 않게)
  const t0 = Date.now(), base = '도면 분석 중';
  let stage = base, pre = '';
  const status = () => {
    const t = `Gemini ${pre}${stage}… ${Math.round((Date.now() - t0) / 1000)}초`;
    say(t, 'chip'); $('loading-text').textContent = t;
  };
  const onProgress = e => {
    stage = e.phase === 'refine' ? '벽 다듬는 중' : e.phase === 'draw' ? `벽 그리는 중 (${e.count}개)` : base;
    status();
  };
  const tick = setInterval(status, 1000); status();
  try {
    // 일시 오류(사용량 폭주 등)면 기다렸다 재시도 → 그래도 안 되면 다른 flash 모델로, 단종 모델이면 안내된 모델로 시도
    const other = [...$('models').options].map(o => o.value).find(n => n !== model && n.endsWith('-flash'));
    const tries = [model, ...(other ? [other] : []), model].slice(0, 3); // 최대 3번 시도
    let d, last;
    for (let i = 0; i < tries.length && !d; i++) {
      try { d = await generatePlan(f, image, key, tries[i], onProgress); }
      catch (err) {
        last = err;
        if (err.suggest && !tries.includes(err.suggest)) tries.splice(i + 1, 0, err.suggest);
        else if (!err.busy) throw err;
        const next = tries[i + 1];
        if (!next) break;
        pre = next === tries[i] ? `재시도 ${i + 2}/${tries.length} · ` : `${next} 로 재시도 ${i + 2}/${tries.length} · `;
        stage = '대기 중'; status();
        if (!err.suggest) await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        stage = base;
      }
      if (d && tries[i] !== model) { $('model').value = tries[i]; saveSettings(); }
    }
    if (!d) throw last;
    show(d); save();
    say(`도면 생성 완료 · ${Math.round((Date.now() - t0) / 1000)}초`);
  } catch (err) {
    $('loading').hidden = true;
    if (plan) cvs.hidden = false; else $('empty').hidden = false;
    say(err.message, 'chip err');
  } finally { clearInterval(tick); btn.disabled = false; }
};

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

// ── 편집: 드래그로 벽 추가 ─────────────────────────────
cvs.onpointerdown = e => {
  if (!plan) return;
  const p = pos(e), x = snap(p.x), y = snap(p.y);
  tmp = [x, y, x, y];
  cvs.setPointerCapture(e.pointerId); draw();
};
cvs.onpointermove = e => {
  if (!plan || !tmp) return;
  const p = pos(e);
  if (e.shiftKey) { tmp[2] = snap(p.x); tmp[3] = snap(p.y); } // 수평/수직으로 정렬 (Shift 를 누르면 사선)
  else if (Math.abs(p.x - tmp[0]) >= Math.abs(p.y - tmp[1])) { tmp[2] = snap(p.x); tmp[3] = tmp[1]; }
  else { tmp[2] = tmp[0]; tmp[3] = snap(p.y); }
  draw();
};
cvs.onpointerup = () => {
  if (tmp && Math.hypot(tmp[2] - tmp[0], tmp[3] - tmp[1]) >= GRID) plan.walls.push(tmp);
  tmp = null; if (plan) draw();
};

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
const keyState = () => { // 키가 없으면 설정을 펼쳐 둔다
  const ok = !!$('key').value.trim();
  $('key-state').textContent = ok ? '키 입력됨' : 'API 키 필요'; $('key-state').className = ok ? 'state ok' : 'state';
  if (!ok) $('settings').open = true;
};
keyState();
function saveSettings() {
  try { localStorage.setItem(KEY + '-key', $('key').value.trim()); localStorage.setItem(KEY + '-model', $('model').value.trim()); } catch (e) { /* 저장소 사용 불가 */ }
}
async function refreshModels() { // 키로 쓸 수 있는 모델 목록을 받아 자동 완성에 채운다
  const key = $('key').value.trim();
  if (!key) return;
  try {
    const names = await listModels(key);
    $('models').innerHTML = names.map(n => `<option value="${n}">`).join('');
    const best = names.find(n => n.endsWith('-flash')) || names[0];
    const cur = $('model').value.trim(); // 목록에 없거나 최신보다 구버전이면 최신 flash 로 교체
    if (best && (!names.includes(cur) || ver(cur) < ver(best))) { $('model').value = best; saveSettings(); }
  } catch (e) { /* 키 오류 등은 생성할 때 안내 */ }
}
$('model').onchange = saveSettings;
$('key').onchange = () => { saveSettings(); keyState(); refreshModels(); };
refreshModels();

try { // 새로고침 시 저장된 도면 복원 (예전 형식 저장본은 버린다)
  const d = JSON.parse(localStorage.getItem(KEY));
  if (d && d.v === PLAN_V && d.walls) { show(d); say('저장된 도면을 불러왔습니다'); }
  else if (d) localStorage.removeItem(KEY);
} catch (e) { /* 저장본 없음/손상 -> 새로 시작 */ }
