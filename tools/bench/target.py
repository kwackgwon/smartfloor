# 목표 그림과 비교: python3 tools/bench/target.py <목표 그림(벽=#D9D9D9)> <plan.json> <겹쳐보기.png>
# 목표 그림의 #D9D9D9 벽(두꺼운 탁자 띠·글자 조각 제외)과 결과 plan 을 외곽 상자로 맞춰 겹쳐 보고 점수 (정답=회색, 결과=빨강, 겹침=검정)
import sys, json, numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd
tgt, plan_p, out = sys.argv[1], sys.argv[2], sys.argv[3]
a = np.asarray(Image.open(tgt).convert('RGB')).astype(int); v = a.mean(2)
m = (np.abs(v - 217) < 6) & ((a.max(2) - a.min(2)) < 10)
# 탁자 띠(두꺼운 217 덩어리) 빼기: 두께 22px 넘는 부분 제거
thick = nd.binary_opening(m, structure=np.ones((23, 23)))
m = m & ~nd.binary_dilation(thick, iterations=3)
lab, n = nd.label(m); sz = nd.sum(m, lab, range(1, n + 1)); m = np.isin(lab, 1 + np.nonzero(sz >= 400)[0])  # 글자 조각 제거
Image.fromarray((m*255).astype(np.uint8)).save(out.replace('.png','-gt.png'))
ys, xs = np.nonzero(m); x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
p = json.load(open(plan_p)); W, H = p['width'], p['height']
sx, sy = (x1 - x0 + 1) / W, (y1 - y0 + 1) / H
im = Image.new('L', a.shape[1::-1], 0); d = ImageDraw.Draw(im)
T = lambda x, y: (x0 + x * sx, y0 + y * sy)
for w in p['walls']:
    t = (w[4] if len(w) > 4 else p['wallThickness']) * sx
    (ax, ay), (bx, by) = T(w[0], w[1]), T(w[2], w[3])
    if abs(ay - by) < 1: d.rectangle([min(ax, bx), ay - t / 2, max(ax, bx), ay + t / 2], fill=255)
    else: d.rectangle([ax - t / 2, min(ay, by), ax + t / 2, max(ay, by)], fill=255)
for sh in p['shapes']:
    lay = Image.new('L', im.size, 0); ld = ImageDraw.Draw(lay)
    for l in sh: ld.polygon([T(x, y) for x, y in l], fill=1)
    # evenodd: 고리마다 뒤집기
    acc = np.zeros(m.shape, bool)
    for l in sh:
        li = Image.new('L', im.size, 0); ImageDraw.Draw(li).polygon([T(x, y) for x, y in l], fill=1); acc ^= np.asarray(li).astype(bool)
    im = Image.fromarray(np.maximum(np.asarray(im), acc.astype(np.uint8) * 255))
pr = np.asarray(im) > 0
tol = 6
gD, pD = nd.binary_dilation(m, iterations=tol), nd.binary_dilation(pr, iterations=tol)
prec = (pr & gD).sum() / max(1, pr.sum()); rec = (m & pD).sum() / max(1, m.sum())
print(f'정확 {prec*100:.1f}%  찾음 {rec*100:.1f}%  F1 {2*prec*rec/max(1e-9,prec+rec)*100:.1f}')
ov = np.full(m.shape + (3,), 255, np.uint8); ov[m] = (170, 170, 170); ov[pr] = (230, 40, 40); ov[m & pr] = (0, 0, 0)
Image.fromarray(ov).save(out)
