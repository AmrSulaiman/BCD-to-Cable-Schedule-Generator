// pdfread.js — Layer 1: read a PDF page into plain geometry.
// Output (all coordinates in "viewport space": as the sheet is seen on screen,
// origin top-left, y increasing downwards, units = PDF points):
//   texts: [{ str, x0, y0, x1, y1, cx, cy, angle, size }]
//   segs:  [{ x1, y1, x2, y2 }]  straight line segments (rectangles are split into 4 segments)
// Works in the browser and in Node with the same pdf.js build.

export async function readPage(pdfjs, page) {
  const viewport = page.getViewport({ scale: 1 });
  const vt = viewport.transform;
  const U = pdfjs.Util;

  // ---- text ----
  const tc = await page.getTextContent();
  const texts = [];
  for (const it of tc.items) {
    const str = (it.str || '').replace(/\s+/g, ' ').trim();
    if (!str) continue;
    const m = U.transform(vt, it.transform); // [a b c d e f] in viewport space
    const size = Math.hypot(m[2], m[3]);     // font height
    const ux = m[0], uy = m[1];              // baseline direction (scaled)
    const len = Math.hypot(ux, uy) || 1;
    const dx = ux / len, dy = uy / len;      // unit baseline direction
    const w = it.width * (Math.hypot(m[0], m[1]) / Math.hypot(it.transform[0], it.transform[1]) || 1);
    // "up" direction of glyphs in viewport space (y down) is perpendicular to baseline
    const upx = dy, upy = -dx;
    const ox = m[4], oy = m[5];              // baseline start
    const pts = [
      [ox, oy],
      [ox + dx * w, oy + dy * w],
      [ox + upx * size, oy + upy * size],
      [ox + dx * w + upx * size, oy + dy * w + upy * size],
    ];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const angle = Math.round(Math.atan2(-dy, dx) * 180 / Math.PI); // 0 = horizontal, 90 = reads bottom-to-top
    texts.push({
      str, size, angle,
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      ox, oy, dx, dy,
    });
  }

  // ---- vector paths ----
  const ops = await page.getOperatorList();
  const OPS = pdfjs.OPS;
  const segs = [];
  const curves = [];   // every curved piece: { a, b, pts (control points) }
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const tp = (x, y) => {
    const p = U.applyTransform([x, y], ctm);
    return U.applyTransform(p, vt);
  };
  const addSeg = (a, b) => {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5) return;
    segs.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = U.transform(ctm, args);
    else if (fn === OPS.constructPath) {
      const [pops, pargs] = args;
      let k = 0, cur = null, start = null;
      const curve = (pts, end) => { if (cur) curves.push({ a: cur, b: end, pts }); };
      for (const op of pops) {
        if (op === OPS.moveTo) { cur = tp(pargs[k], pargs[k + 1]); start = cur; k += 2; }
        else if (op === OPS.lineTo) { const p = tp(pargs[k], pargs[k + 1]); if (cur) addSeg(cur, p); cur = p; k += 2; }
        else if (op === OPS.curveTo) { const p = tp(pargs[k + 4], pargs[k + 5]); curve([tp(pargs[k], pargs[k + 1]), tp(pargs[k + 2], pargs[k + 3])], p); cur = p; k += 6; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { const p = tp(pargs[k + 2], pargs[k + 3]); curve([tp(pargs[k], pargs[k + 1])], p); cur = p; k += 4; }
        else if (op === OPS.closePath) { if (cur && start) addSeg(cur, start); cur = start; }
        else if (op === OPS.rectangle) {
          const [x, y, w, h] = pargs.slice(k, k + 4); k += 4;
          const a = tp(x, y), b = tp(x + w, y), c = tp(x + w, y + h), d = tp(x, y + h);
          addSeg(a, b); addSeg(b, c); addSeg(c, d); addSeg(d, a);
          cur = a; start = a;
        }
      }
    }
  }
  segs.push(...wavyLines(curves));
  return { width: viewport.width, height: viewport.height, texts, segs };
}

// Wavy cables (vendor / flexible cables are often drawn that way) are made of many small
// curves, often each drawn separately and some backwards. Pieces whose ends touch are
// chained; a chain of 3+ curves that is long and nearly straight overall becomes one
// straight line from its first to its last point, marked `wavy`. Circles and arcs in
// symbols are left out: they end near where they started or bulge too far to one side.
export function wavyLines(curves, tol = 1.5) {
  const out = [], used = new Set(), chains = [];
  // index curve ends on a coarse grid so chaining is fast
  const grid = new Map();
  const cell = p => `${Math.round(p[0] / 4)}_${Math.round(p[1] / 4)}`;
  curves.forEach((c, i) => { for (const p of [c.a, c.b]) { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); } });
  const touching = p => {
    const [gx, gy] = [Math.round(p[0] / 4), Math.round(p[1] / 4)], res = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of grid.get(`${gx + dx}_${gy + dy}`) || []) if (!used.has(i)) {
      const c = curves[i];
      const da = Math.hypot(c.a[0] - p[0], c.a[1] - p[1]), db = Math.hypot(c.b[0] - p[0], c.b[1] - p[1]);
      if (Math.min(da, db) < tol) res.push([i, da <= db ? c.b : c.a, Math.min(da, db)]);
    }
    // the piece that starts closest to this point continues the line (tiny pieces make
    // several ends lie within the tolerance)
    res.sort((x, y) => x[2] - y[2]);
    return res.length > 1 && res[1][2] - res[0][2] < 0.05 ? res : res.slice(0, 1);
  };
  for (let i = 0; i < curves.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const pts = [...curves[i].pts, curves[i].a, curves[i].b];
    let ends = [curves[i].a, curves[i].b], n = 1;
    for (const side of [0, 1]) {
      for (;;) {
        const t = touching(ends[side]);
        if (t.length !== 1) break;          // a real fork or nothing: stop
        const [j, far] = t[0];
        used.add(j); n++;
        pts.push(...curves[j].pts, far);
        ends[side] = far;
      }
    }
    chains.push({ ends, pts, n });
  }
  // chains that meet end to end (small drafting gaps) are one line
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i++) for (let j = i + 1; j < chains.length && !merged; j++) {
      const A = chains[i], B = chains[j];
      for (const ai of [0, 1]) for (const bi of [0, 1]) {
        if (merged) break;
        const p = A.ends[ai], q = B.ends[bi];
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 2.5) {
          A.ends = [A.ends[1 - ai], B.ends[1 - bi]]; A.pts.push(...B.pts); A.n += B.n;
          chains.splice(j, 1); merged = true;
        }
      }
    }
  }
  for (const { ends, pts, n } of chains) {
    if (n < 3) continue;
    const [[ax, ay], [bx, by]] = ends, L = Math.hypot(bx - ax, by - ay);
    if (L < 40) continue;
    const dev = Math.max(...pts.map(([x, y]) => Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / L));
    if (dev < Math.max(12, L * 0.12)) out.push({ x1: ax, y1: ay, x2: bx, y2: by, wavy: true });
  }
  return out;
}
