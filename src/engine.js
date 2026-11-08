// engine.js — Layer 2: turn page geometry into cable records (JSON).
// Pure functions, no pdf.js dependency: input is the output of readPage().
//
//   extractDrawing(geom, fileName) -> { drawing: {...title block...}, panel: {...}, cables: [...] }
//   mergeDrawings([drawing, ...], rules) -> { header, cables: [...rows], issues: [...] }

import { DEFAULT_RULES, titleCase, voltageForBand, normaliseSize } from './rules.js';

const REF_RE = /^([A-Z]{1,3}\d{2}[A-Z]{2}[0-9X]{3,5}(?:-\d+)?)\s*(?:\(\s*(B\d(?:\s*[&+\/]\s*B\d)?)\s*\))?$/;
const BAND_RE = /^\(\s*(B\d(?:\s*[&+\/]\s*B\d)?)\s*\)$/;
const DWG_RE = /\d{6,}-\d{2}-[A-Z]{2,4}-\d{4,6}-[A-Z]{2}-[A-Z]{2}-[A-Z]-\d{4,6}/;
// Text that is part of a symbol, not a name
const NOISE_RE = /^(P|C|E|M|H|TH|SL|VSD|DOL|E\.\s?S\.?|f\d|\d~|NOTE\s*\d+|LIT\d+|[\d.]+\s*kW)$/i;
// Asset tag lines printed under equipment names, e.g. 07808-SU1-NA1-BLD01-HT001
const TAG_RE = /^[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){3,}$/;

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const isV = s => Math.abs(s.x1 - s.x2) < 0.6;
const isH = s => Math.abs(s.y1 - s.y2) < 0.6;
const segLen = s => dist(s.x1, s.y1, s.x2, s.y2);
function ptSegDist(px, py, s) {
  const vx = s.x2 - s.x1, vy = s.y2 - s.y1;
  const L2 = vx * vx + vy * vy || 1;
  let t = ((px - s.x1) * vx + (py - s.y1) * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, s.x1 + t * vx, s.y1 + t * vy);
}
function boxDist(px, py, b) {
  const dx = Math.max(b.x0 - px, 0, px - b.x1);
  const dy = Math.max(b.y0 - py, 0, py - b.y1);
  return Math.hypot(dx, dy);
}
const inside = (px, py, b, pad = 0) => px >= b.x0 - pad && px <= b.x1 + pad && py >= b.y0 - pad && py <= b.y1 + pad;

// ---------------------------------------------------------------------------
// Rectangles (boxes such as "JB P01", "TELEMETRY OUTSTATION", "ISO T01")
function findRects(segs) {
  const H = segs.filter(isH).map(s => ({ y: s.y1, x0: Math.min(s.x1, s.x2), x1: Math.max(s.x1, s.x2), s }));
  const V = segs.filter(isV).map(s => ({ x: s.x1, y0: Math.min(s.y1, s.y2), y1: Math.max(s.y1, s.y2), s }));
  const tol = 1.5;
  const rects = [];
  const vAt = (x, y0, y1) => V.find(v => Math.abs(v.x - x) < tol && v.y0 <= y0 + tol && v.y1 >= y1 - tol);
  for (let i = 0; i < H.length; i++) {
    const a = H[i];
    if (a.x1 - a.x0 < 8) continue;
    for (let j = 0; j < H.length; j++) {
      const b = H[j];
      if (b.y <= a.y + 4 || b.y - a.y > 200) continue;
      if (Math.abs(a.x0 - b.x0) > tol || Math.abs(a.x1 - b.x1) > tol) continue;
      const l = vAt(a.x0, a.y, b.y), r = vAt(a.x1, a.y, b.y);
      if (l || r) rects.push({ x0: a.x0, y0: a.y, x1: a.x1, y1: b.y, edges: [a.s, b.s, l?.s, r?.s].filter(Boolean), open: !(l && r) });
    }
  }
  // keep innermost-unique (dedupe identical)
  const out = [];
  for (const r of rects) if (!out.some(o => Math.abs(o.x0 - r.x0) < 1 && Math.abs(o.y0 - r.y0) < 1 && Math.abs(o.x1 - r.x1) < 1 && Math.abs(o.y1 - r.y1) < 1)) out.push(r);
  return out;
}

// ---------------------------------------------------------------------------
// Title block: values sit below their caption ("W&B DRAWING No:", "REV:" ...)
function readTitleBlock(texts) {
  const find = re => texts.find(t => re.test(t.str));
  const below = (cap, maxDx = 260, maxDy = 40, filter = () => true) => {
    if (!cap) return '';
    const c = texts.filter(t => t !== cap && t.angle === 0 && t.y0 > cap.y0 + 2 && t.y0 - cap.y1 < maxDy &&
      t.x0 > cap.x0 - 15 && t.x0 < cap.x0 + maxDx && filter(t))
      .sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    return c.length ? c[0].str : '';
  };
  const sameRowRight = (cap, maxDx = 300) => {
    if (!cap) return '';
    const c = texts.filter(t => t !== cap && t.angle === 0 && Math.abs(t.cy - cap.cy) < cap.size * 0.8 && t.x0 > cap.x1 && t.x0 - cap.x1 < maxDx)
      .sort((a, b) => a.x0 - b.x0);
    return c.length ? c[0].str : '';
  };
  const wbCap = find(/^W&B DRAWING No/i), clCap = find(/^CLIENT DRAWING No/i);
  const revCap = find(/^REV:?$/i), titleCap = find(/^TITLE:?$/i), projCap = find(/^PROJECT:?$/i);
  const pnCap = find(/^PROJECT NUMBER/i), suitCap = find(/^SUITABILITY CODE/i);
  const any = re => (texts.find(t => re.test(t.str)) || {}).str || '';
  return {
    wbNumber: below(wbCap, 200, 30, t => /[A-Z]{3,}-/.test(t.str)) || any(/^[A-Z]+-WAB-\d{2}-/),
    clientNumber: (below(clCap, 220, 30, t => DWG_RE.test(t.str)).match(DWG_RE) || [''])[0],
    revision: below(revCap, 60, 30, t => /^[A-Z]{1,2}\d{2}$/.test(t.str)),
    title: below(titleCap, 300, 40) || sameRowRight(titleCap),
    project: below(projCap, 300, 40) || sameRowRight(projCap),
    projectNumber: below(pnCap, 200, 30),
    suitability: below(suitCap, 300, 30),
    _titleBlockX: Math.min(...[wbCap, clCap, revCap, titleCap, projCap, find(/^NOTES$/), find(/^COPYRIGHT/)].filter(Boolean).map(t => t.x0)),
  };
}

// ---------------------------------------------------------------------------
// Header strip (board schedule along the top of the BCD)
// A sheet can have more than one strip (e.g. an MCC with a second "ICA" strip lower down):
// every REFERENCE row title with a DESCRIPTION row title below it starts one.
function readStrips(texts, segs, title = '') {
  const out = [];
  for (const ref of texts.filter(t => t.angle === 0 && /^REFERENCE$/i.test(t.str))) {
    const desc = texts.filter(t => t.angle === 0 && /^DESCRIPTION$/i.test(t.str) && Math.abs(t.x0 - ref.x0) < 25 && t.cy > ref.cy && t.cy - ref.cy < 220)
      .sort((a, b) => a.cy - b.cy)[0];
    if (desc) { const st = readStrip(texts, segs, ref, desc, title); if (st) out.push(st); }
  }
  return out;
}

function readStrip(texts, segs, ref, desc, title) {
  const left = Math.min(desc.x0, ref.x0) - 6;
  // strip horizontal lines: long lines starting near the left edge
  const hl = segs.filter(s => isH(s) && Math.min(s.x1, s.x2) < left + 12 && segLen(s) > 200 && s.y1 > ref.y0 - 30 && s.y1 < desc.y1 + 80)
    .map(s => ({ y: s.y1, x1: Math.max(s.x1, s.x2) }));
  const right = Math.max(...hl.map(h => h.x1), desc.x1 + 100);
  // last row label is TAG or WAY
  const last = texts.filter(t => t.angle === 0 && /^(TAG|WAY)$/i.test(t.str) && Math.abs(t.x0 - desc.x0) < 15 && t.cy > desc.cy)
    .sort((a, b) => a.cy - b.cy)[0];
  const ys = hl.map(h => h.y).sort((a, b) => a - b);
  const bottomRef = last ? last.cy : desc.cy;
  // bottom edge: a long line below the last row, or else where most short line pieces are
  let bottom = ys.filter(y => y > bottomRef).sort((a, b) => a - b)[0];
  if (bottom == null) {
    const tally = new Map();
    for (const sg of segs) if (isH(sg) && segLen(sg) > 15 && sg.y1 > bottomRef && sg.y1 < bottomRef + 25 && Math.max(sg.x1, sg.x2) > left && Math.min(sg.x1, sg.x2) < right) {
      const k = Math.round(sg.y1); tally.set(k, (tally.get(k) || 0) + segLen(sg));
    }
    const bestY = [...tally].sort((a, b) => b[1] - a[1])[0];
    bottom = bestY ? bestY[0] : bottomRef + 8;
  }
  const top = ys.filter(y => y < ref.cy).sort((a, b) => b - a)[0] ?? (ref.y0 - 4);
  const descTop = ys.filter(y => y < desc.cy).sort((a, b) => b - a)[0] ?? desc.y0 - 6;
  const descBot = ys.filter(y => y > desc.cy).sort((a, b) => a - b)[0] ?? desc.y1 + 6;
  const refBot = ys.filter(y => y > ref.cy).sort((a, b) => a - b)[0] ?? ref.y1 + 4;
  // panel name = text in the REFERENCE row
  const refTxt = texts.filter(t => t.angle === 0 && t !== ref && t.cy > top && t.cy < refBot && t.x0 > ref.x1 && t.x1 < right + 5)
    .map(t => t.str).join(' ');
  let name = refTxt.replace(/\s*-\s*FORM\s*\w+\s*$/i, '').trim();
  if (!name) {
    // some strips write the board name in another top row (e.g. across COMPARTMENT)
    const rowTitles = /^(REFERENCE|COMPARTMENT|TYPE\/?\s*SIZE|WB REF|DESCRIPTION|TAG|WAY)$/i;
    const cand = texts.filter(t => t.angle === 0 && t.cy > top && t.cy < descTop && t.x0 > ref.x1 && t.x1 < right + 5 &&
      !rowTitles.test(t.str) && !/BS\s?88|MCB|\bAMP\b|^\d+[A-Z]?$|^ICA$/i.test(t.str) && /[A-Z]{3,}/i.test(t.str))
      .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0));
    name = cand[0]?.str || (title || '').replace(/\s*\bBCD\b\s*$/i, '').trim();
  }
  // column boundaries: vertical lines crossing the description row
  const xs = segs.filter(s => isV(s) && Math.min(s.y1, s.y2) <= desc.cy && Math.max(s.y1, s.y2) >= desc.cy && s.x1 > left && s.x1 <= right + 2)
    .map(s => s.x1).sort((a, b) => a - b);
  const bounds = [];
  for (const x of xs) if (!bounds.length || x - bounds[bounds.length - 1] > 3) bounds.push(x);
  const descTexts = texts.filter(t => t.angle === 0 && t !== desc && t.cy > descTop && t.cy < descBot && t.x0 > desc.x1);
  const column = x => {
    let a = left, b = right;
    for (const bx of bounds) { if (bx <= x) a = bx; else { b = bx; break; } }
    const d = descTexts.filter(t => t.cx > a && t.cx < b).sort((p, q) => p.cy - q.cy).map(t => t.str).join(' ');
    return { x0: a, x1: b, description: d };
  };
  return { name, rawName: refTxt || name, x0: left, x1: right, y0: top, y1: bottom, column };
}

// ---------------------------------------------------------------------------
// Group free horizontal text into blocks (multi-line labels)
function buildBlocks(texts) {
  const n = texts.length, parent = texts.map((_, i) => i);
  const f = i => (parent[i] === i ? i : (parent[i] = f(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = texts[i], b = texts[j];
    const [u, l] = a.cy < b.cy ? [a, b] : [b, a];
    const gap = l.y0 - u.y1;
    const sz = Math.max(a.size, b.size);
    const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (gap < sz * 0.9 && gap > -sz * 0.5 && (xOverlap > -2 || Math.abs(a.cx - b.cx) < sz * 2)) parent[f(i)] = f(j);
  }
  const groups = new Map();
  texts.forEach((t, i) => { const r = f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  return [...groups.values()].map(ts => {
    ts.sort((a, b) => (a.cy - b.cy) || (a.x0 - b.x0));
    return {
      texts: ts, lines: ts.map(t => t.str),
      x0: Math.min(...ts.map(t => t.x0)), y0: Math.min(...ts.map(t => t.y0)),
      x1: Math.max(...ts.map(t => t.x1)), y1: Math.max(...ts.map(t => t.y1)),
    };
  });
}

// ---------------------------------------------------------------------------
// Parse "4c x 2.5mm² XLPE/SWA BS5467", "VENDOR CABLE", "7G2.5+2×1.5 SUBCAB" ...
export function parseSpec(raw) {
  let s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return { type: '', size: '' };
  if (/VENDOR\s*CABLE/i.test(s)) {
    const rest = s.replace(/VENDOR\s*CABLE/i, '').trim();
    return { type: 'VENDOR CABLE', size: rest ? normaliseSize(rest) : 'VENDOR CABLE' };
  }
  if (/SUBCAB/i.test(s)) {
    return { type: 'SUBCAB', size: s.trim() };
  }
  const m = s.match(/((?:\d+\s*[x×]\s*)?\d+\s*(?:c|pr|g)\s*[x×]\s*\d+(?:\.\d+)?\s*(?:mm²|mm2|mm)?)/i);
  if (m) {
    const type = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return { type, size: normaliseSize(m[1]) };
  }
  return { type: s, size: '' };
}

// ---------------------------------------------------------------------------
export function extractDrawing(geom, fileName = '', rules = DEFAULT_RULES) {
  const { texts, segs } = geom;
  const issues = [];
  const tb = readTitleBlock(texts);
  const tbX = isFinite(tb._titleBlockX) ? tb._titleBlockX - 5 : Infinity;
  const strips = readStrips(texts.filter(t => t.x1 < tbX), segs, tb.title);
  const strip = strips[0] || null;
  // the strip a point belongs to; `below` = how far under the strip still counts (cables
  // leave the strip through a small P/C marker, so their lines start a little below it)
  const stripAt = (x, y, below = 1) => strips.find(st => x > st.x0 && x < st.x1 && y > st.y0 - 2 && y < st.y1 + below);
  const inStrip = (x, y) => !!stripAt(x, y);

  const rects = findRects(segs).filter(r => r.x1 < tbX && !strips.some(st => r.y0 >= st.y0 - 2 && r.y1 <= st.y1 + 2 && r.x0 >= st.x0 - 2 && r.x1 <= st.x1 + 2))
    // a box must have writing in it: four lines that happen to enclose an empty space
    // (e.g. two parallel cables between two boxes) are not a box
    .filter(r => texts.some(t => t.angle === 0 && inside(t.cx, t.cy, r) && /[A-Za-z]{2}/.test(t.str) && !REF_RE.test(t.str) && !NOISE_RE.test(t.str)));
  const rectEdge = new Set(rects.flatMap(r => r.edges));
  // drawing-area texts
  const dTexts = texts.filter(t => t.x1 < tbX && !inStrip(t.cx, t.cy));

  // 1. cable labels
  const used = new Set();
  const labels = [];
  for (const t of dTexts) {
    const m = t.str.replace(/\s+/g, ' ').match(REF_RE);
    if (!m) continue;
    labels.push({ t, ref: m[1], band: m[2] ? m[2].replace(/\s+/g, '').replace(/[+\/]/, '&') : '' });
    used.add(t);
  }
  // detached "(B1)" band texts
  for (const L of labels) if (!L.band) {
    const b = dTexts.find(t => BAND_RE.test(t.str) && !used.has(t) && t.angle === L.t.angle &&
      (L.t.angle === 0 ? Math.abs(t.cy - L.t.cy) < 4 && t.x0 - L.t.x1 < 45 && t.x0 > L.t.x0 : Math.abs(t.cx - L.t.cx) < 4 && boxDist(t.cx, t.cy, L.t) < 45));
    if (b) { L.band = b.str.match(BAND_RE)[1].replace(/\s+/g, ''); used.add(b); }
  }

  const cableSegs = segs.filter(s => !rectEdge.has(s) && !(strip && inStrip((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2) && !isV(s)));

  // 2. for each label find its cable line
  const pickLine = (L) => {
    const t = L.t, sz = t.size;
    let best = null, bestD = Infinity;
    for (const s of cableSegs) {
      if (segLen(s) < 6) continue;
      let d = Infinity;
      if (Math.abs(t.angle) === 90 && isV(s)) {
        const y0 = Math.min(s.y1, s.y2), y1 = Math.max(s.y1, s.y2);
        if (y1 < t.y0 - 5 || y0 > t.y1 + 5) continue;
        d = s.x1 >= t.x1 ? s.x1 - t.x1 : (s.x1 <= t.x0 ? t.x0 - s.x1 : 0);
        if (d > sz * 1.6) continue;
      } else if (t.angle === 0 && isH(s)) {
        const x0 = Math.min(s.x1, s.x2), x1 = Math.max(s.x1, s.x2);
        if (x1 < t.x0 + 2 || x0 > t.x1 - 2) continue;
        d = s.y1 >= t.y1 ? s.y1 - t.y1 : (s.y1 <= t.y0 ? t.y0 - s.y1 : 0);
        if (d > sz * 1.2) continue;
      } else if (t.angle === 0 && isV(s)) {
        // horizontal label beside a vertical line (e.g. LC vendor labels)
        const y0 = Math.min(s.y1, s.y2), y1 = Math.max(s.y1, s.y2);
        if (y1 < t.y0 || y0 > t.y1) continue;
        d = s.x1 <= t.x0 ? t.x0 - s.x1 : (s.x1 >= t.x1 ? s.x1 - t.x1 : Infinity);
        if (d > sz * 1.2) continue;
        d += 0.5; // slight preference for parallel lines
      } else continue;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  };

  // adjacency helpers for tracing
  const key = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
  const touchesAt = (x, y, exclude) => cableSegs.filter(s => !exclude.has(s) && (dist(x, y, s.x1, s.y1) < 1.6 || dist(x, y, s.x2, s.y2) < 1.6));

  // Walk from segment s out of endpoint (x,y); returns final point + path
  const walk = (s, fromEnd) => {
    const seen = new Set([s]);
    let cur = s, px = fromEnd ? s.x2 : s.x1, py = fromEnd ? s.y2 : s.y1;
    let qx = fromEnd ? s.x1 : s.x2, qy = fromEnd ? s.y1 : s.y2; // previous point (for direction)
    for (let step = 0; step < 40; step++) {
      let next = touchesAt(px, py, seen).filter(n => segLen(n) > 1);
      if (next.length !== 1) {
        // bridge a small collinear gap (e.g. the "P"/"C" marker break)
        const ux = (px - qx), uy = (py - qy), ul = Math.hypot(ux, uy) || 1;
        const gap = cableSegs.filter(n => !seen.has(n) && ((isV(n) && isV(cur) && Math.abs(n.x1 - px) < 0.8) || (isH(n) && isH(cur) && Math.abs(n.y1 - py) < 0.8)))
          .map(n => {
            const dA = dist(px, py, n.x1, n.y1), dB = dist(px, py, n.x2, n.y2);
            const near = dA < dB ? [n.x1, n.y1] : [n.x2, n.y2];
            const ahead = ((near[0] - px) * ux + (near[1] - py) * uy) / ul;
            return { n, d: Math.min(dA, dB), ahead };
          }).filter(g => g.ahead > 0 && g.d < 18).sort((a, b) => a.d - b.d);
        if (next.length === 0 && gap.length) next = [gap[0].n];
        else break;
      }
      const n = next[0];
      // cables run in long straight lengths; a turn onto a short stroke means the line has
      // reached an equipment symbol drawn with straight lines, so the cable ends here
      const cu = [cur.x2 - cur.x1, cur.y2 - cur.y1], nu = [n.x2 - n.x1, n.y2 - n.y1];
      const sinT = Math.abs(cu[0] * nu[1] - cu[1] * nu[0]) / ((Math.hypot(...cu) * Math.hypot(...nu)) || 1);
      if (sinT > 0.17 && segLen(n) < 25 && seen.size > 0) break;
      seen.add(n);
      const farFirst = dist(px, py, n.x1, n.y1) > dist(px, py, n.x2, n.y2);
      qx = farFirst ? n.x2 : n.x1; qy = farFirst ? n.y2 : n.y1;
      px = farFirst ? n.x1 : n.x2; py = farFirst ? n.y1 : n.y2;
      cur = n;
    }
    // overall direction from the start of the walk: the last piece can point anywhere once
    // the line wanders into an equipment symbol, but the cable's general heading cannot
    const sx = fromEnd ? s.x1 : s.x2, sy = fromEnd ? s.y1 : s.y2;
    const ol = Math.hypot(px - sx, py - sy);
    const dl = Math.hypot(px - qx, py - qy) || 1;
    const [dx, dy] = ol > 5 ? [(px - sx) / ol, (py - sy) / ol] : [(px - qx) / dl, (py - qy) / dl];
    return { x: px, y: py, dx, dy, path: seen };
  };

  // free text blocks for naming ends
  const blockTexts = dTexts.filter(t => t.angle === 0 && !used.has(t) && !BAND_RE.test(t.str));
  let blocks = null; // built after specs consume their texts

  const nodeAt = (end, path) => {
    const { x, y, dx, dy } = end;
    // a) header strip
    const sp = stripAt(x, y, 30);
    if (sp) return { kind: 'panel', name: sp.name, way: sp.column(x).description };
    // b) a box edge: of the boxes touched, take the biggest one with a name in it
    //    (an isolator box can hold smaller boxes, e.g. around an E.S symbol)
    let boxHit = null;
    for (const r of rects.filter(r => r.edges.some(e => ptSegDist(x, y, e) < 2))) {
      const inner = dTexts.filter(t => inside(t.cx, t.cy, r) && !used.has(t)).sort((a, b) => (a.cy - b.cy) || (a.x0 - b.x0));
      const words = inner.map(t => t.str).filter(w => !NOISE_RE.test(w) && !TAG_RE.test(w));
      if (!words.length) continue;
      const area = (r.x1 - r.x0) * (r.y1 - r.y0);
      if (!boxHit || area > boxHit.area) boxHit = { r, inner, words, area };
    }
    if (boxHit) {
      const { r, inner, words } = boxHit;
      const sp2 = strips.find(st => r.y0 >= st.y1 - 5 && r.y0 - st.y1 < 30 && r.x0 > st.x0 && r.x1 < st.x1);
      if (sp2) return { kind: 'panel', name: sp2.name, way: sp2.column((r.x0 + r.x1) / 2).description };
      return { kind: 'box', name: words.join(' '), box: r, first: inner.find(t => !NOISE_RE.test(t.str)) };
    }
    // c) nearest free text block roughly in line with the cable: ahead of the line end,
    //    or very close to it. Text far off to the side belongs to something else.
    let best = null, bestScore = Infinity;
    for (const b of blocks) {
      const d = boxDist(x, y, b);
      const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
      const cross = corners.map(([px, py]) => (px - x) * dy - (py - y) * dx);
      const lateral = Math.min(...cross) < 0 && Math.max(...cross) > 0 ? 0 : Math.min(...cross.map(Math.abs));
      const along = ((b.x0 + b.x1) / 2 - x) * dx + ((b.y0 + b.y1) / 2 - y) * dy;
      const ok = along > 0 ? d <= 260 && lateral <= Math.max(45, along * 0.5) : d <= 50;
      if (!ok) continue;
      const score = d + lateral * 1.5 + (along > 0 ? 0 : 30);
      if (score < bestScore) { bestScore = score; best = b; }
    }
    if (best) {
      const raw = best.lines.filter(w => !NOISE_RE.test(w));
      const joined = raw.join(' ');
      if (/^(FROM|TO|SEE)\s+DRAWING/i.test(joined)) {
        const num = (raw.slice(1).join('').replace(/\s+/g, '').match(DWG_RE) || [''])[0];
        const note = (joined.match(/\(([^)]*)\)\s*$/) || ['', ''])[1];
        const verb = joined.match(/^(FROM|TO|SEE)/i)[1].toUpperCase();
        return { kind: 'offsheet', verb, drawing: num, note, name: '', text: joined, block: best };
      }
      if (/^FROM\s+DNO$/i.test(joined) || /^DNO\b/i.test(joined)) return { kind: 'dno', name: 'DNO', block: best };
      // controller just under a strip belongs to that board
      const sp3 = /CONTROLLER/i.test(joined) && strips.find(st => best.y0 - st.y1 < 40 && best.y0 >= st.y1 - 5 && best.x0 > st.x0 && best.x1 < st.x1);
      if (sp3) return { kind: 'panel', name: sp3.name, way: sp3.column((best.x0 + best.x1) / 2).description };
      const name = raw.filter(w => !TAG_RE.test(w)).join(' ');
      return { kind: 'device', name, block: best, first: best.texts.find(t => !NOISE_RE.test(t.str)) };
    }
    // d) nothing drawn at this end
    return { kind: 'open', name: '', at: [Math.round(x), Math.round(y)] };
  };

  // give each end a stable key (first word of its text) and tag controllers with their LIT number
  const finishNode = n => {
    if (n.first) {
      n.key = `${Math.round(n.first.x0)}_${Math.round(n.first.y0)}`;
      if (/^CONTROLLER$/i.test(n.name)) {
        const tag = dTexts.filter(t => /^LIT\d+$/i.test(t.str)).map(t => ({ t, d: boxDist(t.cx, t.cy, n.first) })).filter(o => o.d < 80).sort((a, b) => a.d - b.d)[0];
        if (tag) n.name = `Controller ${tag.t.str}`;
        n.kind = 'box';
      }
    }
    delete n.box; delete n.block; delete n.first;
  };

  // 3. spec text for each label (type + size) — on the far side of the line
  // is text u on label L's specification side: beyond its cable line, within reach?
  const onSpecSide = (L, u) => {
    const t = L.t, line = L.line, sz = t.size;
    if (!(Math.abs(t.angle) === 90 && line && isV(line)) || u.angle !== t.angle) return false;
    const side = line.x1 >= t.cx ? 1 : -1;
    return (side > 0 ? (u.x0 >= line.x1 - 1.5 && u.x0 - line.x1 < sz * 3.4) : (u.x1 <= line.x1 + 1.5 && line.x1 - u.x1 < sz * 3.4)) &&
      Math.min(u.y1, t.y1 + 60) - Math.max(u.y0, t.y0 - 60) > 0;
  };
  const specOf = (L, line) => {
    const t = L.t, sz = t.size;
    let cand = [];
    if (Math.abs(t.angle) === 90 && line && isV(line)) {
      const side = line.x1 >= t.cx ? 1 : -1;
      cand = dTexts.filter(u => !used.has(u) && !REF_RE.test(u.str) && !BAND_RE.test(u.str) && onSpecSide(L, u))
        .sort((a, b) => side * (a.cx - b.cx));
    } else {
      // horizontal label: spec on the next line or two below it (size, then type)
      const specLike = u => /(mm|PR|\dc\b|\dc\s|VENDOR|SUBCAB|XLPE|SWA|BS\d|G&Y|-Y|-X|\dG\d)/i.test(u.str);
      const below = dTexts.filter(u => !used.has(u) && u.angle === 0 && u !== t && !REF_RE.test(u.str) && !BAND_RE.test(u.str) &&
        u.y0 >= t.y1 - 1 && u.y0 - t.y1 < sz * 4 && Math.min(u.x1, t.x1 + 40) - Math.max(u.x0, t.x0 - 40) > 0)
        .sort((a, b) => a.cy - b.cy);
      cand = [];
      let prevBottom = t.y1;
      for (const u of below) {
        if (u.y0 - prevBottom > sz * 1.9 || !specLike(u) || cand.length >= 2) break;
        cand.push(u); prevBottom = u.y1;
      }
    }
    // stop at the first text that is closer to another label
    const out = [];
    for (const u of cand) {
      const mine = boxDist(u.cx, u.cy, t);
      // text that is nearer another label only belongs to it if it is on that label's spec side
      const other = labels.some(o => o !== L && o.t.angle === t.angle && boxDist(u.cx, u.cy, o.t) < mine - 1 &&
        (Math.abs(t.angle) !== 90 || onSpecSide(o, u)));
      if (other) continue;
      out.push(u);
      if (out.length >= 3) break;
    }
    out.forEach(u => used.add(u));
    return out.map(u => u.str).join(' ');
  };

  // detect leaders: horizontal label whose "line" is really a short leader ending on a cable line
  const resolved = [];
  for (const L of labels) {
    let line = pickLine(L);
    L.line = line;
  }
  for (const L of labels) L.specRaw = specOf(L, L.line);
  blocks = buildBlocks(blockTexts.filter(t => !used.has(t) && !NOISE_RE.test(t.str) && /[A-Za-z]/.test(t.str) && t.str.length > 1));

  for (const L of labels) {
    const rec = { ref: L.ref, band: L.band, ...parseSpec(L.specRaw), specRaw: L.specRaw, ends: [], flags: [], at: [Math.round(L.t.cx), Math.round(L.t.cy)] };
    let line = L.line;
    if (!line) { rec.flags.push('No cable line found next to label'); resolved.push(rec); continue; }
    let A = walk(line, false), B = walk(line, true);
    // leader: a horizontal label whose nearby line is a short leader ending in an arrow on the real cable
    const pathLen = [...new Set([...A.path, ...B.path])].reduce((a, s) => a + segLen(s), 0);
    const all = new Set([...A.path, ...B.path]);
    const rayHit = e => {
      let best = null, bd = Infinity;
      for (const s of cableSegs) {
        if (all.has(s) || segLen(s) < 20) continue;
        for (let k = 0; k <= 14; k += 0.5) {
          const px = e.x + e.dx * k, py = e.y + e.dy * k;
          if (ptSegDist(px, py, s) < 0.8 && dist(px, py, s.x1, s.y1) > 2 && dist(px, py, s.x2, s.y2) > 2) { if (k < bd) { bd = k; best = s; } break; }
        }
      }
      return best;
    };
    // a leader starts right at its label and ends (in an arrow) on the cable it labels
    const atLabel = e => boxDist(e.x, e.y, L.t) < L.t.size * 1.2;
    if (pathLen < 160 && L.t.angle === 0 && (atLabel(A) || atLabel(B))) {
      const hit = (atLabel(B) && rayHit(A)) || (atLabel(A) && rayHit(B));
      if (hit) {
        line = hit;
        A = walk(line, false); B = walk(line, true);
        rec.flags.push('Label attached by leader arrow — check it points at the right cable');
      }
    }
    let nA = nodeAt(A, A.path), nB = nodeAt(B, B.path);
    nA.pos = [Math.round(A.x), Math.round(A.y)]; nB.pos = [Math.round(B.x), Math.round(B.y)];
    for (const n of [nA, nB]) finishNode(n);
    // A cable leaving a board way with nothing drawn at its far end goes to what the
    // way's DESCRIPTION says (e.g. EXTERNAL LIGHTING). An incomer's open end is left for
    // another sheet to fill in, or left blank.
    for (const [p, o] of [[nA, nB], [nB, nA]]) {
      if (p.kind === 'panel' && o.kind === 'open' && p.way && !/INCOMER|\bFROM\b|SPARE/i.test(p.way)) {
        o.kind = 'device'; o.name = p.way; o.fromColumn = true;
        rec.flags.push(`Nothing drawn at the far end: destination taken from the board way description "${p.way}"`);
      }
    }
    rec.ends = [nA, nB];
    resolved.push(rec);
  }

  return {
    file: fileName,
    drawing: { ...tb, _titleBlockX: undefined },
    panel: strip ? { name: strip.name, rawName: strip.rawName } : null,
    cables: resolved,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Merge several drawings into one schedule
// Lower rank = supply side (source). A panel way called "MAINS INCOMER" or "LINK FROM ..." receives the cable.
const RANK = n => n.kind === 'dno' ? 0
  : n.kind === 'panel' ? (/INCOMER|\bFROM\b/i.test(n.way || '') ? 4 : 0)
  : n.kind === 'offsheet' ? 1 : n.kind === 'box' ? 2 : 3;

export function mergeDrawings(drawings, rules = DEFAULT_RULES) {
  const byClient = new Map();
  for (const d of drawings) if (d.drawing.clientNumber) byClient.set(d.drawing.clientNumber, d);
  const sheetOf = d => d.drawing.wbNumber || d.file;

  // Names learned from off-sheet notes, e.g. "TO DRAWING ...-00002 (TO EDM CONTROLLER)"
  // give the matching equipment on the other sheet its proper name.
  const alias = new Map();
  const all = [];
  for (const d of drawings) for (const c of d.cables) all.push({ c, d });
  for (const { c, d } of all) for (const n of c.ends) {
    if (n.kind !== 'offsheet' || !n.note) continue;
    const target = byClient.get(n.drawing); if (!target) continue;
    const noteName = n.note.replace(/^TO\s+|^FROM\s+/i, '').trim();
    const twin = target.cables.find(x => x.ref === c.ref);
    if (!twin) continue;
    for (const m of twin.ends) if (m.key && m.kind !== 'panel' && m.kind !== 'offsheet') {
      const firstWord = (m.name.split(/\s+/)[0] || '').toLowerCase();
      if (firstWord && noteName.toLowerCase().includes(firstWord)) alias.set(sheetOf(target) + '|' + m.key, noteName);
    }
  }
  const nameOf = (n, d) => {
    if (n.kind === 'offsheet') {
      const target = byClient.get(n.drawing);
      return target && target.panel ? rules.fullName(target.panel.name) : '';
    }
    const a = n.key && alias.get(sheetOf(d) + '|' + n.key);
    return rules.fullName(a || n.name);
  };

  const groups = new Map();
  for (const x of all) { if (!groups.has(x.c.ref)) groups.set(x.c.ref, []); groups.get(x.c.ref).push(x); }
  const rows = [];
  for (const [ref, inst] of groups) {
    const flags = [];
    const ends = [];
    const srcVotes = new Map(); // full name -> net votes (+ source / - destination)
    const seenSign = new Map();
    const vote = (name, v) => {
      if (!name) return; const k = name.toLowerCase();
      srcVotes.set(k, (srcVotes.get(k) || 0) + v);
      seenSign.set(k, (seenSign.get(k) || new Set()).add(Math.sign(v)));
    };
    for (const { c, d } of inst) {
      for (const n of c.ends) {
        ends.push({ ...n, full: nameOf(n, d), sheet: sheetOf(d) });
        if (n.kind === 'offsheet' && !byClient.has(n.drawing)) flags.push(`Refers to drawing ${n.drawing || '(unreadable number)'} which was not uploaded`);
      }
      // "FROM DRAWING X" => the far end (X) is the source; "TO DRAWING X" => local end is the source
      const off = c.ends.find(n => n.kind === 'offsheet' && n.verb !== 'SEE');
      const local = c.ends.find(n => n !== off);
      if (off && local) {
        const far = nameOf(off, d), here = nameOf(local, d);
        if (off.verb === 'FROM') { vote(far, 1); vote(here, -1); } else { vote(here, 1); vote(far, -1); }
      }
      flags.push(...c.flags);
    }
    const concrete = [];
    for (const e of ends.filter(e => e.kind !== 'offsheet' && e.full)) if (!concrete.some(x => x.full.toLowerCase() === e.full.toLowerCase())) concrete.push(e);
    const pair = concrete.slice(0, 2);
    if (concrete.length > 2) flags.push(`More than two ends found: ${concrete.map(e => e.full).join(' / ')}`);
    for (const e of ends.filter(e => e.kind === 'offsheet')) {
      if (pair.length >= 2) break;
      const nm = e.full || (e.drawing ? `Drawing ${e.drawing}` : e.text);
      if (!pair.some(p => p.full.toLowerCase() === nm.toLowerCase())) pair.push({ ...e, full: nm });
    }
    while (pair.length < 2) pair.push({ kind: 'unknown', full: '' });
    // direction: FROM/TO wording if all drawings agree, otherwise supply-side ranking
    const v0 = srcVotes.get(pair[0].full.toLowerCase()) || 0, v1 = srcVotes.get(pair[1].full.toLowerCase()) || 0;
    const votesAgree = [...seenSign.values()].every(set => set.size === 1);
    if (v0 !== v1 && votesAgree) { if (v1 > v0) pair.reverse(); }
    else {
      pair.sort((a, b) => (RANK(a) - RANK(b)) ||
        (Math.abs((a.pos?.[1] ?? 0) - (b.pos?.[1] ?? 0)) > 3 ? (a.pos?.[1] ?? 0) - (b.pos?.[1] ?? 0) : (a.pos?.[0] ?? 0) - (b.pos?.[0] ?? 0)));
      if (!votesAgree) flags.push('Drawings disagree on direction (both say FROM or both say TO) — check source/destination');
    }
    const pick = (k, label) => {
      const vals = [...new Set(inst.map(i => i.c[k]).filter(Boolean))];
      if (vals.length > 1) flags.push(`${label} differs between drawings: ${vals.map((v, i) => v).join(' vs ')} (${inst.filter(i => i.c[k]).map(i => sheetOf(i.d)).join(' vs ')})`);
      return vals[0] || '';
    };
    if (rules.direction === 'field-first') pair.reverse();
    let band = pick('band', 'Band');
    const type = pick('type', 'Cable type'), size = pick('size', 'Size');
    const pre = (ref.match(/^[A-Z]+/) || [''])[0];
    const expect = rules.prefixBand[pre];
    if (!band && expect) { band = expect; flags.push(`Band not shown on drawing — assumed ${expect} from prefix ${pre}`); }
    else if (!band) flags.push('No voltage band on drawing');
    else if (expect && !band.split('&').includes(expect)) flags.push(`Prefix ${pre} is normally ${expect}, drawing says ${band}`);
    if (!size) flags.push('No core/size found');
    if (!type) flags.push('No cable type found');
    if (!pair[0].full || !pair[1].full) {
      const incomer = pair.find(e => e.kind === 'panel' && /INCOMER/i.test(e.way || ''));
      flags.push(incomer
        ? `Incoming supply to ${incomer.full}: nothing is drawn at the other end on the uploaded drawings, so it is left blank`
        : 'Source or destination missing');
    }
    rows.push({
      ref, source: pair[0].full, destination: pair[1].full, type, size,
      voltage: voltageForBand(band, rules), band,
      length: '', cpc: '', install: '', comments: '',
      sheets: [...new Set(inst.map(i => sheetOf(i.d)))], flags: [...new Set(flags)],
    });
  }
  // same ref drawn twice on one sheet
  rows.sort(rules.sortRows);
  return { rows };
}
