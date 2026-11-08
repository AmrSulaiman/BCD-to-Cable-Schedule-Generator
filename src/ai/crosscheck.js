// crosscheck.js — the AI cross-check.
//
//   1. READ    Each sheet goes to the AI with the list of cable references the rules engine
//              found (not its answers). The AI reports each cable's ends, size, type and band.
//   2. CHECK   The AI's answer is checked by code before it is trusted (format, no invented
//              cables, every reference must appear in the drawing's own text).
//   3. COMPARE The AI's reading goes through the same merge and naming rules as the rules
//              engine, then the two are compared field by field.
//   4. REVIEW  Only fields where they disagree go back to the AI with both candidates and
//              the drawing, to say which one the drawing shows and why.
//   5. RESULT  Every row gets a status. Nothing the AI decided is applied silently: such
//              rows stay marked for checking, with the reason.
//
// The provider (gemini.js or a test double) is passed in, so this file never talks to
// the network itself.

import { mergeDrawings, parseSpec, DWG_RE } from '../engine.js';
import { DEFAULT_RULES } from '../rules.js';
import { toSheetScale } from './render.js';
import { PROMPT_VERSION, READ_SYSTEM, READ_SYSTEM_NO_LIST, READ_SCHEMA, readUserText, REVIEW_SYSTEM, REVIEW_SCHEMA, reviewUserText } from './prompt.js';

export const REF_RE = /^[A-Z]{1,3}\d{2}[A-Z]{2}[0-9X]{3,5}(?:-\d+)?$/;
export const FIELDS = [['ends', 'Source / destination'], ['type', 'Cable type'], ['size', 'Cores & size'], ['band', 'Band']];
const blank = v => !v || /^unknown$/i.test(String(v).trim());
export const clean = v => (blank(v) ? '' : String(v).replace(/\s+/g, ' ').trim());
const normName = s => String(s || '').toLowerCase().replace(/²/g, '2').replace(/×/g, 'x').replace(/[^a-z0-9&+]/g, '');
export const normBand = b => {
  const m = String(b || '').toUpperCase().replace(/\s+/g, '').match(/^\(?(B1&B2|B1\+B2|B1\/B2|B1|B2)\)?$/);
  return m ? m[1].replace(/[+\/]/, '&') : '';
};

// ------------------------------------------------------------------ 2. checking the AI's reading
function sanitiseRead(json, sheet, listed) {
  const notes = [];
  const listedSet = new Set(listed);
  const text = (sheet.pageText || '').replace(/\s+/g, '');
  const seen = new Set();
  const cables = [], extras = [];
  for (const c of Array.isArray(json?.cables) ? json.cables : []) {
    const ref = String(c?.ref || '').replace(/\s+/g, '').toUpperCase();
    if (!REF_RE.test(ref)) { notes.push(`Ignored "${c?.ref}": not a valid cable reference`); continue; }
    if (seen.has(ref)) { notes.push(`Ignored a second reading of ${ref}`); continue; }
    seen.add(ref);
    if (listed.length && !listedSet.has(ref)) { extras.push({ ...c, ref }); continue; }
    cables.push({ ...c, ref });
  }
  for (const r of Array.isArray(json?.other_refs_seen) ? json.other_refs_seen : []) {
    const ref = String(r || '').replace(/\s+/g, '').toUpperCase();
    if (REF_RE.test(ref) && !seen.has(ref) && !listedSet.has(ref)) { seen.add(ref); extras.push({ ref, end_a: { kind: 'unknown', name: '' }, end_b: { kind: 'unknown', name: '' } }); }
  }
  // evidence check: a reference the rules engine did not list must exist in the drawing's text
  const keptExtras = [];
  for (const e of extras) {
    if (!text || text.includes(e.ref)) keptExtras.push(e);
    else notes.push(`Ignored ${e.ref}: the AI reported it but it is not in the drawing's text`);
  }
  const missing = listed.filter(r => !seen.has(r));
  return { board: clean(json?.board_name), cables, extras: keptExtras, missing, notes };
}

export function toEnd(e) {
  const kind = e?.kind, name = clean(e?.name);
  if (kind === 'board_way') return { kind: 'panel', name: name.replace(/\s*-\s*FORM\s*\w+\s*$/i, ''), way: clean(e?.way) };
  if (kind === 'box') return { kind: 'box', name };
  if (kind === 'equipment') return { kind: 'device', name: name.replace(/\s*[\d.]+\s*kW\b/ig, '').trim() };
  if (kind === 'dno') return { kind: 'dno', name: 'DNO' };
  if (kind === 'other_drawing') {
    const all = `${e?.drawing_number || ''} ${name}`.replace(/\s+/g, '');
    const verb = (name.match(/^(FROM|TO|SEE)/i) || ['', 'SEE'])[1].toUpperCase();
    const note = (name.match(/\(([^)]*)\)\s*$/) || ['', ''])[1];
    return { kind: 'offsheet', verb, drawing: (all.match(DWG_RE) || [''])[0], note, name: '', text: name };
  }
  return { kind: 'unknown', name: '' };
}

export function toCable(c) {
  let size = clean(c.cores_size), type = clean(c.cable_type);
  // avoid repeating the type when the AI put the whole specification in the size field
  if (size && type && normName(size).includes(normName(type))) type = '';
  const spec = parseSpec(`${size} ${type}`.trim());
  return {
    ref: c.ref, band: normBand(c.band), type: spec.type, size: spec.size,
    ends: [toEnd(c.end_a), toEnd(c.end_b)], flags: [], confidence: c.confidence || '', note: clean(c.note),
  };
}

// ------------------------------------------------------------------ 3. comparing
export function fieldText(row, f) {
  if (f === 'ends') return [row.source, row.destination].filter(Boolean).join(' ↔ ') || '(not found)';
  return row[f] || '(not found)';
}
export function compareField(f, r, a) {
  if (f === 'ends') {
    const R = [r.source, r.destination].filter(Boolean).map(normName);
    const A = [a.source, a.destination].filter(Boolean).map(normName);
    if (!A.length) return R.length ? 'ai_empty' : 'both_empty';
    if (!R.length) return 'filled';
    if (R.length === 2 && A.length === 2 && R.every(x => A.includes(x))) return 'agree';
    if (R.length < 2 && R.every(x => A.includes(x)) && A.length === 2) return 'filled';
    return 'differ';
  }
  const x = normName(r[f]), y = normName(a[f]);
  if (!y) return x ? 'ai_empty' : 'both_empty';
  if (!x) return 'filled';
  return x === y ? 'agree' : 'differ';
}

// ------------------------------------------------------------------ main
/**
 * sheets: [{ drawing, pageText, getImages: async () => images }]  (drawing = extractDrawing result)
 * ruleRows: mergeDrawings(rules drawings).rows
 * provider: { name, model(), generate({ system, text, images, schema, tag }) }
 */
export async function crossCheck({ sheets, ruleRows, rules = DEFAULT_RULES, provider, onProgress = () => {}, review = true, parallel = 2 }) {
  const stopNote = new Set();
  const log = [];
  const raw = { promptVersion: PROMPT_VERSION, read: {}, review: {} };
  const model = await provider.model();
  const sheetKey = s => `${s.drawing.file}`;
  const imageCache = new Map();
  const images = async s => { if (!imageCache.has(s)) imageCache.set(s, await s.getImages()); return imageCache.get(s); };

  // 1–2. read each sheet
  const aiDrawings = [], failed = new Set(), missingByRef = new Map();
  // read up to `parallel` sheets at the same time
  let done = 0;
  const readSheet = async (s, i) => {
    const d = s.drawing;
    onProgress(`AI reading the drawings: ${done} of ${sheets.length} sheets done`);
    const refs = d.cables.map(c => ({ ref: c.ref, at: toSheetScale(c.at[0], c.at[1], d.page.width, d.page.height) }));
    const noList = refs.length === 0;
    try {
      const imgs = await images(s);
      const res = await provider.generate({
        tag: `read:${sheetKey(s)}`, system: noList ? READ_SYSTEM_NO_LIST : READ_SYSTEM,
        text: readUserText({ ...d.drawing, file: d.file }, refs), images: imgs, schema: READ_SCHEMA,
      });
      raw.read[sheetKey(s)] = res.json;
      const r = sanitiseRead(res.json, s, refs.map(x => x.ref));
      for (const n of r.notes) log.push(`${d.file}: ${n}`);
      for (const ref of r.missing) missingByRef.set(ref, d.file);
      const posOf = new Map(d.cables.map(c => [c.ref, c.at]));
      aiDrawings.push({
        file: d.file, drawing: d.drawing,
        panel: { name: r.board || d.panel?.name || '' },
        cables: [...r.cables, ...r.extras].map(c => ({ ...toCable(c), at: posOf.get(c.ref) || null, aiOnly: !posOf.has(c.ref) })),
      });
    } catch (e) {
      failed.add(d.file);
      if (e.stopped) stopNote.add(d.file);
      log.push(`${d.file}: AI reading ${e.stopped ? 'stopped' : 'failed'}: ${e.message}`);
    }
    done++;
    onProgress(`AI reading the drawings: ${done} of ${sheets.length} sheets done`);
  };
  const queue = sheets.map((s, i) => [s, i]);
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) { const [s, i] = queue.shift(); await readSheet(s, i); }
  }));
  // keep sheets in their original order for the merge
  aiDrawings.sort((a, b) => sheets.findIndex(s => s.drawing.file === a.file) - sheets.findIndex(s => s.drawing.file === b.file));

  // 3. same merge + naming rules as the rules engine, then compare
  const aiRows = new Map(mergeDrawings(aiDrawings, rules).rows.map(r => [r.ref, r]));
  const aiOnlyRefs = new Set(aiDrawings.flatMap(d => d.cables.filter(c => c.aiOnly).map(c => c.ref)));
  const refSheets = new Map(); // ref -> [{ sheet, at }]
  for (const s of sheets) for (const c of s.drawing.cables) {
    if (!refSheets.has(c.ref)) refSheets.set(c.ref, []);
    refSheets.get(c.ref).push({ s, at: c.at });
  }

  const out = [];
  const disputes = [];
  for (const r of ruleRows) {
    const row = { ...r, flags: [...r.flags] };
    const a = aiRows.get(r.ref);
    const onSheets = (refSheets.get(r.ref) || []).map(x => x.s.drawing.file);
    if (onSheets.length && onSheets.every(f => failed.has(f))) {
      row.check = { status: 'not_checked' };
      out.push(row); continue;
    }
    if (!a) {
      row.check = { status: 'rules_only' };
      row.flags.push('AI cross-check: the AI did not report this cable');
      out.push(row); continue;
    }
    const fields = {};
    for (const [f, label] of FIELDS) {
      const st = compareField(f, r, a);
      fields[f] = { status: st, rules: fieldText(r, f), ai: fieldText(a, f) };
      if (st === 'filled') {
        if (f === 'ends') { row.source = a.source; row.destination = a.destination; }
        else { row[f] = a[f]; if (f === 'band') row.voltage = a.voltage; }
        row.flags.push(`AI filled in ${label.toLowerCase()}: ${fields[f].ai}`);
      } else if (st === 'differ') {
        row.flags.push(`AI reads ${label.toLowerCase()} as "${fields[f].ai}" (rules engine: "${fields[f].rules}")`);
        disputes.push({ row, f, label, a });
      } else if (st === 'ai_empty') {
        row.flags.push(`AI could not read ${label.toLowerCase()}; rules engine value not confirmed`);
      }
    }
    const sts = Object.values(fields).map(x => x.status);
    row.check = {
      status: sts.includes('differ') ? 'disputed' : sts.some(s => s === 'filled' || s === 'ai_empty') ? 'unconfirmed' : 'agreed',
      fields,
    };
    out.push(row);
  }
  // cables only the AI found (they passed the evidence check)
  for (const [ref, a] of aiRows) {
    if (ruleRows.some(r => r.ref === ref)) continue;
    if (!aiOnlyRefs.has(ref)) continue;
    out.push({ ...a, flags: [...a.flags, 'Found by the AI only: the rules engine did not find this cable'], check: { status: 'ai_only' } });
  }

  // 4. review disputed fields, one request per sheet
  if (review && disputes.length) {
    const bySheet = new Map();
    disputes.forEach((d, i) => {
      const loc = (refSheets.get(d.row.ref) || [])[0];
      if (!loc || failed.has(loc.s.drawing.file)) return;
      const id = String(i + 1);
      const item = { id, ref: d.row.ref, at: toSheetScale(loc.at[0], loc.at[1], loc.s.drawing.page.width, loc.s.drawing.page.height), label: d.label.toLowerCase(), a: d.row.check.fields[d.f].rules, b: d.row.check.fields[d.f].ai, d };
      if (!bySheet.has(loc.s)) bySheet.set(loc.s, []);
      bySheet.get(loc.s).push(item);
    });
    let n = 0;
    for (const [s, items] of bySheet) {
      n++;
      onProgress(`AI reviewing ${items.length} disputed value${items.length === 1 ? '' : 's'} (sheet ${n} of ${bySheet.size})`);
      try {
        const res = await provider.generate({
          tag: `review:${sheetKey(s)}`, system: REVIEW_SYSTEM,
          text: reviewUserText({ ...s.drawing.drawing, file: s.drawing.file }, items), images: await images(s), schema: REVIEW_SCHEMA,
        });
        raw.review[sheetKey(s)] = res.json;
        const byId = new Map((res.json?.decisions || []).map(x => [String(x.id), x]));
        for (const it of items) {
          const dec = byId.get(it.id);
          const { row, f, label, a } = it.d;
          const fld = row.check.fields[f];
          if (!dec) { fld.review = { choice: 'none', reason: 'The AI review gave no answer for this value.' }; continue; }
          fld.review = { choice: dec.choice, reason: clean(dec.reason), value: clean(dec.value) };
          if (dec.choice === 'B') {
            if (f === 'ends') { row.source = a.source; row.destination = a.destination; }
            else { row[f] = a[f]; if (f === 'band') row.voltage = a.voltage; }
            row.flags.push(`AI review changed ${label.toLowerCase()} to "${fld.ai}": ${fld.review.reason}`);
          } else if (dec.choice === 'neither' && fld.review.value && f !== 'ends') {
            const v = f === 'size' ? parseSpec(fld.review.value).size || fld.review.value : f === 'band' ? normBand(fld.review.value) || fld.review.value : fld.review.value;
            row[f] = v;
            row.flags.push(`AI review says the drawing shows ${label.toLowerCase()} "${v}" (neither reading): ${fld.review.reason}`);
          } else if (dec.choice === 'A' || dec.choice === 'both') {
            row.flags.push(`AI review kept the rules engine's ${label.toLowerCase()}: ${fld.review.reason}`);
          } else {
            row.flags.push(`AI review could not decide ${label.toLowerCase()}${fld.review.value ? ` (suggests "${fld.review.value}")` : ''}: ${fld.review.reason}`);
          }
        }
      } catch (e) {
        log.push(`${s.drawing.file}: AI review ${e.stopped ? 'stopped' : 'failed'}: ${e.message}`);
        if (e.stopped) break;
      }
    }
  }

  for (const f of failed) log.push(`${f}: not checked by the AI; its rows show the rules engine's reading only`);
  out.sort(rules.sortRows);
  const count = st => out.filter(r => r.check?.status === st).length;
  return {
    rows: out, aiRows: [...aiRows.values()], log, raw, model: await provider.model(), provider: provider.name,
    summary: { agreed: count('agreed'), disputed: count('disputed'), unconfirmed: count('unconfirmed'), aiOnly: count('ai_only'), rulesOnly: count('rules_only'), notChecked: count('not_checked') },
  };
}

// ------------------------------------------------------------------ recording / replaying (tests)
// Saves every AI answer by tag so tests can replay them without calling the AI.
export function recordingProvider(inner, store = {}) {
  return {
    name: inner.name, model: () => inner.model(), store,
    async generate(args) { const r = await inner.generate(args); store[args.tag] = { model: r.model, json: r.json }; return r; },
  };
}
// Re-uses answers already received and only asks the AI for the rest, e.g. to retry
// just the sheets that failed without spending the free limit on the others again.
export function resumeProvider(store, live) {
  return {
    name: live.name, model: () => live.model(), store,
    async generate(args) {
      if (store[args.tag]) return store[args.tag];
      const r = await live.generate(args);
      store[args.tag] = { model: r.model, json: r.json };
      return r;
    },
  };
}
export function replayProvider(store, name = 'Saved AI answers') {
  const first = Object.values(store)[0];
  return {
    name, model: async () => first?.model || 'replay',
    async generate({ tag }) { if (!store[tag]) throw new Error(`No saved AI answer for ${tag}`); return store[tag]; },
  };
}
