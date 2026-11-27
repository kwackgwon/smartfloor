figma.showUI(__html__, { width: 360, height: 320 });

type Plan = {
  width: number; height: number; wallThickness: number;
  walls: number[][];
  shapes?: number[][][][];
  doors?: { x: number; y: number; u: number[]; n: number[]; r: number; t?: number }[];
  seats?: { x: number; y: number; w: number; h: number; label?: string }[];
  tables?: { x: number; y: number; w: number; h: number }[];
};

const hex = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255
});
const WALL = hex('#D9D9D9'), SEAT = hex('#AEAEAE'), WHITE = hex('#FFFFFF');

figma.ui.onmessage = async (d: Plan) => {
  const frame = figma.createFrame();
  frame.name = 'SmartFloor';
  frame.resize(d.width, d.height);
  frame.fills = [];
  frame.clipsContent = false;

  const shapes = d.shapes || [];
  if (shapes.length) {
    const data = shapes.flat().map(l => 'M ' + l.map(([x, y]) => `${x} ${y}`).join(' L ') + ' Z').join(' ');
    const v = figma.createVector();
    v.name = 'Wall shapes';
    v.vectorPaths = [{ windingRule: 'EVENODD', data }];
    v.fills = [{ type: 'SOLID', color: WALL }];
    v.strokes = [];
    frame.appendChild(v);
    // Vector 노드는 경계 상자 기준으로 위치가 잡히므로 최소 좌표로 옮긴다
    const pts = shapes.flat(2);
    v.x = Math.min(...pts.map(p => p[0]));
    v.y = Math.min(...pts.map(p => p[1]));
  }

  // 선으로 된 벽: 두께마다 따로
  for (const w of d.walls) {
    const [x1, y1, x2, y2] = w, line = figma.createVector();
    line.name = 'Wall';
    await line.setVectorNetworkAsync({ vertices: [{ x: x1, y: y1 }, { x: x2, y: y2 }], segments: [{ start: 0, end: 1 }] });
    line.strokes = [{ type: 'SOLID', color: WALL }];
    line.strokeWeight = w[4] || d.wallThickness || 15;
    line.strokeCap = 'SQUARE';
    frame.appendChild(line);
    line.x = Math.min(x1, x2);
    line.y = Math.min(y1, y2);
  }

  // 문: 흰 1/4 원 (경첩 → 닫힌 자리 → 여는 쪽). 벽은 이어진 채로 두고 문 호를 위에 얹는다
  for (const dr of d.doors || []) {
    const [ux, uy] = dr.u, [nx, ny] = dr.n, a = [dr.x + ux * dr.r, dr.y + uy * dr.r], b = [dr.x + nx * dr.r, dr.y + ny * dr.r];
    const sweep = ux * ny - uy * nx > 0 ? 1 : 0, v = figma.createVector();
    v.name = 'Door';
    const h = (dr.t || d.wallThickness || 15) / 2, back = [dr.x - nx * h, dr.y - ny * h], backA = [a[0] - nx * h, a[1] - ny * h]; // 경첩 뒤쪽 벽 반 두께도 문으로
    v.vectorPaths = [{ windingRule: 'NONZERO', data: `M ${back[0]} ${back[1]} L ${backA[0]} ${backA[1]} L ${a[0]} ${a[1]} A ${dr.r} ${dr.r} 0 0 ${sweep} ${b[0]} ${b[1]} L ${dr.x} ${dr.y} Z` }];
    v.fills = [{ type: 'SOLID', color: WHITE }]; v.strokes = [];
    frame.appendChild(v);
    v.x = Math.min(dr.x, a[0], b[0], back[0], backA[0]); v.y = Math.min(dr.y, a[1], b[1], back[1], backA[1]);
  }
  // 탁자(연한 회색)·좌석(회색 네모 + 흰 번호)
  for (const t of d.tables || []) {
    const r = figma.createRectangle(); r.name = 'Table'; r.resize(t.w, t.h); r.x = t.x; r.y = t.y; r.fills = [{ type: 'SOLID', color: WALL }]; frame.appendChild(r);
  }
  if ((d.seats || []).some(st => st.label)) await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
  for (const st of d.seats || []) {
    const r = figma.createRectangle(); r.name = 'Seat ' + (st.label || ''); r.resize(st.w, st.h); r.x = st.x; r.y = st.y; r.fills = [{ type: 'SOLID', color: SEAT }]; frame.appendChild(r);
    if (st.label) {
      const t = figma.createText(); t.fontName = { family: 'Inter', style: 'Medium' }; t.characters = st.label;
      t.fontSize = Math.min(st.w / (st.label.length * 0.62), st.h * 0.45); t.fills = [{ type: 'SOLID', color: WHITE }];
      t.textAlignHorizontal = 'CENTER'; t.textAlignVertical = 'CENTER'; t.resize(st.w, st.h); t.x = st.x; t.y = st.y; frame.appendChild(t);
    }
  }

  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.closePlugin('가져오기 완료');
};
