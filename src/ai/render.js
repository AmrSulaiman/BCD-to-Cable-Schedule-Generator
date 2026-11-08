// render.js — turn one PDF page into images the AI can read.
//
// An A1 BCD has text only a few millimetres high. Sent as one picture it would be
// shrunk until that text is unreadable, so the sheet is sent as:
//   - one overview of the whole sheet (to see layout and where lines go), and
//   - a grid of overlapping close-up tiles (to read small text).
// Each image carries its position on the sheet on a 0–1000 scale, so the AI and
// the code can talk about the same places.
//
// Works in the browser (HTML canvas) and in Node (@napi-rs/canvas): the caller
// passes `makeCanvas(w, h)` and `encode(canvas) -> base64 PNG`.

export const DEFAULT_RENDER = { cols: 3, rows: 2, overlap: 0.08, tilePx: 1600, overviewPx: 2000 };

// `area` = [x0, y0, x1, y1] in PDF points: the part of the sheet with the diagram on it
// (from extractDrawing). Empty margins and the title block are left out so the text
// comes out larger.
export async function renderPageForAI(page, { makeCanvas, encode, area, mime = 'image/png', ...opts }) {
  const o = { ...DEFAULT_RENDER, ...opts };
  const base = page.getViewport({ scale: 1 });
  const [ax0, ay0, ax1, ay1] = area || [0, 0, base.width, base.height];
  const aw = ax1 - ax0, ah = ay1 - ay0;
  // one high-resolution render of the area, cut into tiles afterwards
  const tileW = aw / o.cols * (1 + o.overlap * 2);
  const scale = Math.min(o.tilePx / tileW, 4);
  const vp = page.getViewport({ scale, offsetX: -ax0 * scale, offsetY: -ay0 * scale });
  const W = Math.round(aw * scale), H = Math.round(ah * scale);
  const big = makeCanvas(W, H);
  const ctx = big.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  // canvas pixels -> 0–1000 sheet scale
  const sx = px => Math.round((ax0 + px / scale) / base.width * 1000);
  const sy = py => Math.round((ay0 + py / scale) / base.height * 1000);

  const images = [];
  // overview
  const ow = Math.min(o.overviewPx, W), oh = Math.round(H * ow / W);
  const ov = makeCanvas(ow, oh);
  const octx = ov.getContext('2d');
  octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, ow, oh);
  octx.drawImage(big, 0, 0, W, H, 0, 0, ow, oh);
  images.push({ name: 'overview', box: [sx(0), sy(0), sx(W), sy(H)], mime, data: await encode(ov) });

  // tiles
  const cw = W / o.cols, ch = H / o.rows;
  for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.cols; c++) {
    const x0 = Math.max(0, Math.floor(c * cw - cw * o.overlap)), x1 = Math.min(W, Math.ceil((c + 1) * cw + cw * o.overlap));
    const y0 = Math.max(0, Math.floor(r * ch - ch * o.overlap)), y1 = Math.min(H, Math.ceil((r + 1) * ch + ch * o.overlap));
    const t = makeCanvas(x1 - x0, y1 - y0);
    const tctx = t.getContext('2d');
    tctx.drawImage(big, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    images.push({
      name: `tile row ${r + 1} col ${c + 1}`,
      box: [sx(x0), sy(y0), sx(x1), sy(y1)],
      mime, data: await encode(t),
    });
  }
  return { width: base.width, height: base.height, images };
}

// Position on the sheet (PDF points, viewport space) -> 0–1000 scale
export const toSheetScale = (x, y, width, height) => [Math.round(x / width * 1000), Math.round(y / height * 1000)];

// One close-up of part of the sheet. `region` = [x0, y0, x1, y1] in PDF points.
// Rendered so its longer side is about `maxPx` pixels (text a few mm high on A1 comes
// out large and sharp), never more than 6× the PDF size.
export async function renderRegion(page, region, { makeCanvas, encode, maxPx = 1400, mime = 'image/jpeg' }) {
  const [x0, y0, x1, y1] = region;
  const w = x1 - x0, h = y1 - y0;
  const scale = Math.min(maxPx / Math.max(w, h), 6);
  const vp = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
  return { mime, data: await encode(c), width: W, height: H };
}
