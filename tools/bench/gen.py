# 정답이 있는 연습용 도면 생성기
# 사용: python3 tools/bench/gen.py <출력 폴더> <시드> <스타일: cad_solid|cad_hatch|floorplanner|design>  (Pillow 필요)
# 결과: <이름>.png (도면), <이름>-gt.png (정답 벽 마스크: 벽=검정), <이름>.json (문·가로 길이)
import sys, json, math, random
from PIL import Image, ImageDraw
out, seed, style = sys.argv[1], int(sys.argv[2]), sys.argv[3]
R = random.Random(seed)
W, H = 1600, 1300
im = Image.new('RGB', (W, H), 'white'); d = ImageDraw.Draw(im)
gt = Image.new('L', (W, H), 255); g = ImageDraw.Draw(gt)
ppm = R.uniform(60, 85)                      # 1m 당 px
bx0, by0 = R.randint(180, 260), R.randint(160, 230)
bw, bh = R.randint(900, 1150), R.randint(750, 950)
bx1, by1 = bx0 + bw, by0 + bh
S = {
  'cad_solid':    dict(ext=18, int=10, col=(45, 45, 45), int_style='solid', win=True, hatch=False),
  'cad_hatch':    dict(ext=20, int=9, col=(110, 110, 110), int_style='hatch', win=True, hatch=True),
  'floorplanner': dict(ext=10, int=7, col=(0, 0, 0), int_style='solid', win=True, hatch=False),
  'design':       dict(ext=24, int=10, col=(217, 217, 217), int_style='solid', win=False, hatch=False),
}[style]
K = S['col']; LINE = (40, 40, 40) if style != 'design' else (190, 190, 190)

# 외벽 다각형: 직사각형에서 한 귀퉁이를 잘라 L자 (50%)
cut = None
if R.random() < 0.5:
    cw, ch = R.randint(200, 350), R.randint(150, 300)
    cut = R.choice(['tl', 'tr', 'bl', 'br']); cut = (cut, cw, ch)
def outline():
    x0, y0, x1, y1 = bx0, by0, bx1, by1
    if not cut: return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    c, cw, ch = cut
    if c == 'tl': return [(x0 + cw, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0 + ch), (x0 + cw, y0 + ch)]
    if c == 'tr': return [(x0, y0), (x1 - cw, y0), (x1 - cw, y0 + ch), (x1, y0 + ch), (x1, y1), (x0, y1)]
    if c == 'bl': return [(x0, y0), (x1, y0), (x1, y1), (x0 + cw, y1), (x0 + cw, y1 - ch), (x0, y1 - ch)]
    return [(x0, y0), (x1, y0), (x1, y1 - ch), (x1 - cw, y1 - ch), (x1 - cw, y1), (x0, y1)]
poly = outline()
doors = []

def rect_wall(x1, y1, x2, y2, t, kind):
    # 축 방향 벽 하나를 그린다 (도면 + 정답)
    x1, y1, x2, y2 = (int(round(v)) for v in (x1, y1, x2, y2))
    if x1 == x2: box = [(x1 - t // 2, min(y1, y2)), (x1 + t // 2, max(y1, y2))]
    else: box = [(min(x1, x2), y1 - t // 2), (max(x1, x2), y1 + t // 2)]
    g.rectangle(box, fill=0)
    if kind == 'hatch':
        (a, b), (c, e) = box
        d.rectangle(box, outline=(0, 0, 0), width=1)
        tile = Image.new('RGB', (c - a + 1, e - b + 1), 'white'); td = ImageDraw.Draw(tile)
        for k in range(-(e - b), (c - a) + (e - b), 4):   # 빗금
            td.line([(k, e - b), (k + (e - b), 0)], fill=(150, 150, 150), width=1)
        td.rectangle([(0, 0), (c - a, e - b)], outline=(0, 0, 0), width=1)
        im.paste(tile, (a, b))
        return box
    d.rectangle(box, fill=K)
    return box

def door_arc(hx, hy, ux, uy, nx, ny, r):
    # 경첩 (hx,hy), 문 폭 방향 u, 여는 쪽 n
    pts = [(hx + r * (math.cos(a) * ux + math.sin(a) * nx), hy + r * (math.cos(a) * uy + math.sin(a) * ny)) for a in [i * math.pi / 2 / 40 for i in range(41)]]
    d.line(pts, fill=LINE, width=1); d.line([(hx, hy), (hx + nx * r, hy + ny * r)], fill=LINE, width=2)
    doors.append(dict(x=hx, y=hy, r=r))

def wall_with_openings(x1, y1, x2, y2, t, kind, n_door=1, n_win=0, door_side=1):
    # 벽 하나에 문(틈+호)·창문(틈+얇은 선)을 낸다
    horiz = y1 == y2; L = abs(x2 - x1) if horiz else abs(y2 - y1); a0 = min(x1, x2) if horiz else min(y1, y2)
    ops = []; tries = 0
    want = [('door', ppm * R.uniform(0.8, 1.0)) for _ in range(n_door)] + [('win', ppm * R.uniform(1.0, 2.0)) for _ in range(n_win)]
    for kind_o, w in want:
        while tries < 200:
            tries += 1; s = R.uniform(t * 2, L - w - t * 2)
            if all(s + w + 20 < o[1] or s > o[2] + 20 for o in ops): ops.append((kind_o, s, s + w)); break
    ops.sort(key=lambda o: o[1]); cur = 0
    for kind_o, s0, s1 in ops + [('end', L, L)]:
        if s0 > cur:
            if horiz: rect_wall(a0 + cur, y1, a0 + s0, y1, t, kind)
            else: rect_wall(x1, a0 + cur, x1, a0 + s0, t, kind)
        if kind_o == 'win':
            for o in (-t // 3, 0, t // 3):           # 창문: 얇은 선 3줄 (정답에서는 벽)
                if horiz: d.line([(a0 + s0, y1 + o), (a0 + s1, y1 + o)], fill=(120, 120, 120), width=1)
                else: d.line([(x1 + o, a0 + s0), (x1 + o, a0 + s1)], fill=(120, 120, 120), width=1)
            if horiz: g.rectangle([(a0 + s0, y1 - t // 2), (a0 + s1, y1 + t // 2)], fill=0)
            else: g.rectangle([(x1 - t // 2, a0 + s0), (x1 + t // 2, a0 + s1)], fill=0)
        if kind_o == 'door':
            r = s1 - s0
            if horiz: door_arc(a0 + s0, y1, 1, 0, 0, door_side, r)
            else: door_arc(x1, a0 + s0, 0, 1, door_side, 0, r)
        cur = max(cur, s1)

# 외벽
cx, cy = sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)
n_ext_door = R.randint(1, 2); door_left = n_ext_door
for i, (p, q) in enumerate(zip(poly, poly[1:] + poly[:1])):
    L = math.hypot(q[0] - p[0], q[1] - p[1])
    nd = 1 if door_left and L > 400 and R.random() < 0.5 else 0; door_left -= nd
    nw = R.randint(1, 2) if S['win'] and L > 500 else 0
    out_side = (1 if (q[1] - p[1] == 0 and p[1] < cy) or (q[0] - p[0] == 0 and p[0] < cx) else -1) * -1  # 바깥쪽
    wall_with_openings(p[0], p[1], q[0], q[1], S['ext'], 'solid', nd, nw, door_side=-out_side if R.random() < 0.5 else out_side)
for (x, y) in poly: g.rectangle([(x - S['ext'] // 2, y - S['ext'] // 2), (x + S['ext'] // 2, y + S['ext'] // 2)], fill=0); d.rectangle([(x - S['ext'] // 2, y - S['ext'] // 2), (x + S['ext'] // 2, y + S['ext'] // 2)], fill=K)

# 내부: 방 나누기 (가로·세로 칸막이 2~4개, 각자 문 하나)
def inside(x, y):
    n = len(poly); c = False
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
walls_int = []
for _ in range(R.randint(2, 4)):
    for _try in range(50):
        if R.random() < 0.5:
            x = R.randint(bx0 + 150, bx1 - 150); ya, yb = R.randint(by0, by0 + 300), R.randint(by1 - 300, by1)
            ya = by0 if R.random() < 0.6 else ya; yb = by1 if R.random() < 0.6 else yb
            if all(inside(x, y) for y in range(ya + 30, yb - 30, 20)) and all(abs(w[0] - x) > 120 for w in walls_int if w[0] == w[2]):
                walls_int.append((x, ya + S['ext'] // 2, x, yb - S['ext'] // 2)); break
        else:
            y = R.randint(by0 + 150, by1 - 150); xa, xb = bx0, bx1
            if all(inside(x, y) for x in range(xa + 30, xb - 30, 20)) and all(abs(w[1] - y) > 120 for w in walls_int if w[1] == w[3]):
                walls_int.append((xa + S['ext'] // 2, y, xb - S['ext'] // 2, y)); break
for (x1, y1, x2, y2) in walls_int:
    wall_with_openings(x1, y1, x2, y2, S['int'], S['int_style'], 1, 0, door_side=R.choice([1, -1]))

# 가구: 책상 줄(얇은 사각형)+의자(작은 호), 둥근 탁자, 글자
gtpx = gt.load()
def clear(x0, y0, x1, y1):  # 가구가 벽(정답 마스크)과 겹치지 않는지 (여유 25px)
    for yy in range(max(0, y0 - 25), min(H, y1 + 25), 4):
        for xx in range(max(0, x0 - 25), min(W, x1 + 25), 4):
            if gtpx[xx, yy] < 128: return False
    return True
for _ in range(R.randint(6, 12)):
    x, y = R.randint(bx0 + 60, bx1 - 300), R.randint(by0 + 60, by1 - 150)
    n = R.randint(2, 5); dw, dh = int(ppm * 1.1), int(ppm * 0.6)
    if not inside(x, y) or not inside(x + n * dw, y + dh + 40) or not clear(x, y, x + n * dw, y + dh + 40): continue
    for k in range(n):
        x0 = x + k * dw
        if style == 'design': d.rectangle([(x0, y), (x0 + dw - 6, y + dh)], fill=(174, 174, 174))
        else:
            d.rectangle([(x0, y), (x0 + dw, y + dh)], outline=LINE, width=1)
            c0 = (x0 + dw // 2, y + dh + 18); d.arc([(c0[0] - 14, c0[1] - 14), (c0[0] + 14, c0[1] + 14)], 0, 180, fill=LINE, width=1)
            d.rectangle([(c0[0] - 12, c0[1] - 10), (c0[0] + 12, c0[1] + 6)], outline=LINE, width=1)
for _ in range(R.randint(1, 3)):
    x, y = R.randint(bx0 + 80, bx1 - 80), R.randint(by0 + 80, by1 - 80)
    if inside(x, y) and clear(x - 30, y - 30, x + 30, y + 30): d.ellipse([(x - 30, y - 30), (x + 30, y + 30)], outline=LINE, width=1)
for _ in range(4):
    x, y = R.randint(bx0 + 80, bx1 - 200), R.randint(by0 + 80, by1 - 80)
    if inside(x, y): d.text((x, y), R.choice(['OPEN ZONE', 'FOCUS', 'LOUNGE', 'CAFE', 'STUDY']), fill=(30, 30, 30) if style != 'design' else (150, 150, 150))
# 치수선·표제란 (CAD 계열)
if style != 'design':
    d.line([(bx0, by0 - 70), (bx1, by0 - 70)], fill=LINE, width=1); d.text(((bx0 + bx1) // 2, by0 - 90), f'{bw / ppm * 1000:,.0f}', fill=LINE)
    for x in (bx0, bx1): d.line([(x, by0 - 80), (x, by0 - 60)], fill=LINE, width=1)
    d.line([(bx0 - 70, by0), (bx0 - 70, by1)], fill=LINE, width=1)
    if style == 'cad_solid': d.rectangle([(W - 110, 20), (W - 15, H - 20)], outline=LINE, width=2); d.rectangle([(W - 105, H - 160), (W - 20, H - 25)], fill=(200, 30, 40))
name = f'{style}-{seed}'
im.save(f'{out}/{name}.png'); gt.save(f'{out}/{name}-gt.png')
json.dump(dict(widthM=round(bw / ppm, 2), doors=doors, ppm=ppm), open(f'{out}/{name}.json', 'w'))
print(name, 'doors', len(doors), 'widthM', round(bw / ppm, 2))
