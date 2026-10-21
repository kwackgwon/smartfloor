// 웹에서 내보낸 smartfloor.json -> Frame 1개 + 벽(#D9D9D9) 모양·선 Vector + 좌석 사각형
figma.showUI(__html__, { width: 360, height: 320 });

type Plan = {
  width: number; height: number; wallThickness: number;
  walls: number[][]; // [x1, y1, x2, y2, 두께?]
  shapes?: number[][][][]; // [모양][고리][점][x, y]
  seats: { no?: string; type: string; x: number; y: number; w: number; h: number; status: string }[];
};

const hex = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255
});
const WALL = hex('#D9D9D9'), EDGE = hex('#BDBDBD');
const COLOR: Record<string, string> = { AVAILABLE: '#10b981', IN_USE: '#3b82f6', CLOSING: '#f59e0b', UNAVAILABLE: '#94a3b8' };

figma.ui.onmessage = async (d: Plan) => {
  const frame = figma.createFrame();
  frame.name = 'SmartFloor';
  frame.resize(d.width, d.height);

  // 칠해진 벽 모양 (구멍 포함) -> Vector 1개, evenodd 로 채움
  const shapes = d.shapes || [];
  if (shapes.length) {
    const data = shapes.flat().map(l => 'M ' + l.map(([x, y]) => `${x} ${y}`).join(' L ') + ' Z').join(' ');
    const v = figma.createVector();
    v.name = 'Wall shapes';
    v.vectorPaths = [{ windingRule: 'EVENODD', data }];
    v.fills = [{ type: 'SOLID', color: WALL }];
    v.strokes = [{ type: 'SOLID', color: EDGE }];
    v.strokeWeight = 1;
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

  d.seats.forEach((t, i) => {
    const r = figma.createRectangle();
    r.name = `Seat ${t.no || i + 1} ${t.type}`;
    r.resize(t.w, t.h);
    r.x = t.x - t.w / 2;
    r.y = t.y - t.h / 2;
    r.cornerRadius = Math.min(t.w, t.h) * 0.18;
    r.fills = [{ type: 'SOLID', color: hex(COLOR[t.status] || COLOR.AVAILABLE) }];
    frame.appendChild(r);
  });

  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.closePlugin('가져오기 완료');
};
