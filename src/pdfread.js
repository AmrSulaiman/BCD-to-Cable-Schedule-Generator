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
      for (const op of pops) {
        if (op === OPS.moveTo) { cur = tp(pargs[k], pargs[k + 1]); start = cur; k += 2; }
        else if (op === OPS.lineTo) { const p = tp(pargs[k], pargs[k + 1]); if (cur) addSeg(cur, p); cur = p; k += 2; }
        else if (op === OPS.curveTo) { const p = tp(pargs[k + 4], pargs[k + 5]); cur = p; k += 6; }
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) { const p = tp(pargs[k + 2], pargs[k + 3]); cur = p; k += 4; }
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
  return { width: viewport.width, height: viewport.height, texts, segs };
}
