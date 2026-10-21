// 웹에서 내보낸 smartfloor.json -> Frame 1개 + 벽(#D9D9D9) Vector Network + 좌석 사각형
figma.showUI(__html__, { width: 360, height: 320 });

type Plan = {
  width: number; height: number; wallThickness: number;
  walls: number[][];
  seats: { no?: string; type: string; x: number; y: number; w: number; h: number; status: string }[];
};

const hex = (h: string) => ({
  r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255
});
const WALL = hex('#D9D9D9');
const COLOR: Record<string, string> = { AVAILABLE: '#10b981', IN_USE: '#3b82f6', CLOSING: '#f59e0b', UNAVAILABLE: '#94a3b8' };

figma.ui.onmessage = async (d: Plan) => {
  const frame = figma.createFrame();
  frame.name = 'SmartFloor';
  frame.resize(d.width, d.height);

  const vertices: { x: number; y: number }[] = [];
  const segments: { start: number; end: number }[] = [];
  for (const [x1, y1, x2, y2] of d.walls) {
    vertices.push({ x: x1, y: y1 }, { x: x2, y: y2 });
    segments.push({ start: vertices.length - 2, end: vertices.length - 1 });
  }
  const walls = figma.createVector();
  walls.name = 'Walls';
  await walls.setVectorNetworkAsync({ vertices, segments });
  walls.strokes = [{ type: 'SOLID', color: WALL }];
  walls.strokeWeight = d.wallThickness || 15;
  walls.strokeCap = 'SQUARE';
  walls.strokeAlign = 'CENTER';
  frame.appendChild(walls);
  // Vector 노드는 경계 상자 기준으로 위치가 잡히므로 최소 좌표로 옮긴다
  if (vertices.length) {
    walls.x = Math.min(...vertices.map(v => v.x));
    walls.y = Math.min(...vertices.map(v => v.y));
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
