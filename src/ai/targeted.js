// targeted.js — the AI check, only for the rows the rules engine is unsure of.
//
// The rules engine records, for every cable, what it is unsure of (engine.js:
// `uncertain`) and the area of the sheet around the cable (`region`). So:
//
//   1. PLAN     Every row is one of:
//                 ai          amber because the reading may be wrong (leader arrow, far-away
//                             name, nothing at an end, size not found…) → close-up to the AI
//                 person      amber because information is missing or the drawings disagree
//                             → no picture can settle it, so it is not sent
//                 none        a clear-cut reading → not sent
//               For each "ai" row the plan also says WHICH fields are in doubt: the ends,
//               or the size/type. Only those fields are compared with the AI.
//   2. CROP     For each cable, only its area of the sheet is rendered, plus the exact words
//               the PDF prints there.
//   3. ASK      One request per sheet with all that sheet's close-ups, every sheet at the
//               same time. The AI is not told what the rules engine read.
//   4. CHECK    The answer is checked by code: right cable, right image, known kinds of
//               end. A "name" that is only symbol lettering (M, 3~, E.S, TH, SL…) is
//               treated as "could not read". If the line ran off the close-up, it is
//               asked once more with a wider area.
//   5. COMPARE  The AI's reading goes through the same merge and naming rules, then the
//               fields in doubt are compared. Other fields keep the rules engine's value.
//
// Nothing the AI says is applied silently. Rows it disagrees with stay amber and show
// both readings for a person to pick.

import { mergeDrawings, classifyFlag, NOISE_RE } from '../engine.js';
import { DEFAULT_RULES } from '../rules.js';
import { toSheetScale } from './render.js';
import { CHECK_VERSION, CHECK_SYSTEM, CHECK_SCHEMA, checkUserText } from './prompt.js';
import { FIELDS, toCable, fieldText, compareField, clean } from './crosscheck.js';

const MAX_PER_REQUEST = 15;   // close-ups in one request (a sheet with more is split)

// which fields each kind of doubt is about
const FIELDS_FOR = { leader: ['ends'], loose: ['ends'], column: ['ends'], open: ['ends'], spec: ['type', 'size'], 'no-line': ['ends', 'type', 'size', 'band'] };

/** Sort rows into ai / person / none. Returns an array of plans, one per row (same order). */
export function planChecks(ruleRows) {
  return ruleRows.map(r => {
    const kinds = r.flagKinds || (r.flags || []).map(classifyFlag);
    const reading = r.flags.filter((f, i) => kinds[i] === 'reading');
    const person = r.flags.filter((f, i) => kinds[i] === 'missing' || kinds[i] === 'conflict');
    const views = r.views || [];
    let jobs = views.filter(v => v.uncertain.length);
    const fields = new Set(jobs.flatMap(v => v.uncertain.flatMap(u => FIELDS_FOR[u.code] || ['ends'])));
    // an amber reading flag without a recorded doubt (e.g. from the merge): look at every view
    if (!jobs.length && reading.length) {
      jobs = views;
      if (reading.some(f => /source|destination|line/i.test(f))) fields.add('ends');
      if (reading.some(f => /size|type/i.test(f))) { fields.add('type'); fields.add('size'); }
      if (!fields.size) fields.add('ends');
    }
    jobs = jobs.filter(v => v.region);
    const kind = jobs.length ? 'ai' : person.length ? 'person' : 'none';
    return {
      ref: r.ref, kind, person, fields: [...fields],
      jobs: jobs.map(v => ({ ref: r.ref, sheet: v.sheet, file: v.file, region: v.region, openEnd: v.uncertain.some(u => u.code === 'column' || u.code === 'open') })),
      reasons: [...new Set(jobs.flatMap(v => v.uncertain.map(u => u.text)).concat(jobs.length && !jobs.some(v => v.uncertain.length) ? reading : []))],
    };
  });
}

export const summarisePlan = plans => {
  const c = { ai: 0, person: 0, none: 0, requests: 0 };
  const perFile = new Map();
  for (const p of plans) {
    c[p.kind]++;
    for (const j of p.jobs) if (p.kind === 'ai') perFile.set(j.file, (perFile.get(j.file) || 0) + 1);
  }
  for (const n of perFile.values()) c.requests += Math.ceil(n / MAX_PER_REQUEST);
  return c;
};

const widen = ([x0, y0, x1, y1], W, H) => {
  const w = x1 - x0, h = y1 - y0;
  return [Math.max(0, x0 - w / 2), Math.max(0, y0 - h / 2), Math.min(W, x1 + w / 2), Math.min(H, y1 + h / 2)].map(Math.round);
};

// "M 3~", "E.S", "TH SL": lettering inside a symbol, not a name
const symbolOnly = name => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  return !w.length || w.every(x => NOISE_RE.test(x) || /^\d~$/.test(x));
};

/**
 * sheets: [{ drawing, texts: [{str,x0,y0,x1,y1}], renderRegion: async ([x0,y0,x1,y1]) => { mime, data } }]
 * drawings: the rules engine's drawings (extractDrawing results), ruleRows: mergeDrawings(drawings).rows
 */
export async function targetedCheck({ sheets, drawings, ruleRows, rules = DEFAULT_RULES, provider, onProgress = () => {} }) {
  const t0 = Date.now();
  const log = [];
  const raw = { promptVersion: CHECK_VERSION, check: {} };
  const plans = planChecks(ruleRows);
  const sheetOf = new Map(sheets.map(s => [s.drawing.file, s]));
  const failedJobs = new Set();          // `${file}|${ref}`
  const answers = new Map();             // `${file}|${ref}` -> AI cable (toCable) + raw
  let requests = 0, stopped = false, gaveUp = false, okCount = 0, failCount = 0, usage = { input: 0, output: 0 };

  const wordsIn = (s, [x0, y0, x1, y1]) => {
    const out = [];
    for (const t of s.texts || []) if (t.x1 > x0 && t.x0 < x1 && t.y1 > y0 && t.y0 < y1) {
      const w = t.str.trim(); if (w && !out.includes(w)) out.push(w);
    }
    return out.slice(0, 120);
  };

  // ---- ask about a list of jobs on one sheet, in batches
  const runJobs = async (jobs, label) => {
    const byFile = new Map();
    for (const j of jobs) { if (!byFile.has(j.file)) byFile.set(j.file, []); byFile.get(j.file).push(j); }
    const batches = [];
    for (const [file, list] of byFile) for (let i = 0; i < list.length; i += MAX_PER_REQUEST) batches.push({ file, list: list.slice(i, i + MAX_PER_REQUEST) });
    let done = 0;
    const one = async ({ file, list }, wide = false) => {
      const s = sheetOf.get(file);
      const d = s?.drawing;
      if (!d) { list.forEach(j => failedJobs.add(`${file}|${j.ref}`)); return; }
      const W = d.page.width, H = d.page.height;
      const items = [], images = [];
      for (const [i, j] of list.entries()) {
        const region = wide ? widen(j.region, W, H) : j.region;
        const cable = d.cables.find(c => c.ref === j.ref);
        const img = await s.renderRegion(region);
        const tl = toSheetScale(region[0], region[1], W, H), br = toSheetScale(region[2], region[3], W, H);
        images.push({ name: `${i + 1}`, box: [...tl, ...br], mime: img.mime, data: img.data });
        items.push({ n: i + 1, ref: j.ref, at: cable ? toSheetScale(cable.at[0], cable.at[1], W, H) : [Math.round((tl[0] + br[0]) / 2), Math.round((tl[1] + br[1]) / 2)], words: wordsIn(s, region) });
      }
      const tag = `check:${file}:${list.map(j => j.ref).join(',')}${wide ? ':wide' : ''}`;
      try {
        requests++;
        const res = await provider.generate({ tag, system: CHECK_SYSTEM, text: checkUserText({ ...d.drawing, file }, d.panel?.name || '', items), images, schema: CHECK_SCHEMA });
        raw.check[tag] = res.json; okCount++;
        if (res.usage) { usage.input += res.usage.promptTokenCount || 0; usage.output += res.usage.candidatesTokenCount || 0; }
        const got = Array.isArray(res.json?.cables) ? res.json.cables : [];
        const retry = [];
        for (const [i, j] of list.entries()) {
          const ref = j.ref;
          // match by image number, falling back to the reference
          const a = got.find(c => Number(c?.image) === i + 1 && String(c?.ref || '').replace(/\s+/g, '').toUpperCase() === ref)
            || got.find(c => String(c?.ref || '').replace(/\s+/g, '').toUpperCase() === ref);
          if (!a || a.found === false) {
            if (!wide) { retry.push(j); continue; }
            log.push(`${file}: the AI could not find ${ref} in its close-up`);
            failedJobs.add(`${file}|${ref}`); continue;
          }
          const unknownEnd = [a.end_a, a.end_b].some(e => !e || e.kind === 'unknown');
          // line ran off the close-up: look once more with a wider area (not when the
          // rules engine already found nothing drawn at that end — wider will not help)
          if (!wide && !j.openEnd && (a.line_leaves_image || unknownEnd)) { retry.push(j); continue; }
          const cab = toCable({ ...a, ref });
          // symbol lettering is not a name: treat that end as unread
          cab.ends = cab.ends.map(e => (['device', 'box'].includes(e.kind) && symbolOnly(e.name) ? { kind: 'unknown', name: '' } : e));
          answers.set(`${file}|${ref}`, { ...cab, confidence: a.confidence, note: clean(a.note), wide });
        }
        if (retry.length) { log.push(`${file}: looking again with a wider area for ${retry.map(j => j.ref).join(', ')}`); await one({ file, list: retry }, true); }
      } catch (e) {
        if (e.stopped) stopped = true;
        // the first requests all failed: the service is unreachable or the key is wrong,
        // so stop instead of making the user wait for every request to fail
        else if (++failCount >= 2 && okCount === 0 && !gaveUp) { gaveUp = true; log.push(`The AI service failed on the first requests (${e.message.replace(/ Gave up.*$/, '')}), so the rest were not sent.`); }
        log.push(`${file}: AI check ${e.stopped ? 'stopped' : 'failed'} for ${list.map(j => j.ref).join(', ')}: ${e.message}`);
        list.forEach(j => failedJobs.add(`${file}|${j.ref}`));
      }
      if (!wide) { done++; onProgress(`${label}: ${done} of ${batches.length} request${batches.length === 1 ? '' : 's'} done`); }
    };
    onProgress(`${label}: 0 of ${batches.length} request${batches.length === 1 ? '' : 's'} done`);
    const queue = [...batches];
    // every request at once: there are few, and they are small
    await Promise.all(Array.from({ length: queue.length }, async () => {
      while (queue.length && !stopped && !gaveUp) await one(queue.shift());
    }));
    for (const b of queue) b.list.forEach(j => failedJobs.add(`${b.file}|${j.ref}`)); // left over after Stop
  };

  // ---- compare one row: the AI's readings replace the rules engine's on the checked sheets
  const compareRow = (r, p) => {
    const got = p.jobs.filter(j => answers.has(`${j.file}|${j.ref}`));
    if (!got.length) return null;
    const swapped = drawings.map(d => {
      const j = got.find(x => x.file === d.file);
      if (!j) return d;
      const a = answers.get(`${d.file}|${r.ref}`);
      // same small rules the engine applies to its own reading of a sheet
      let ends = a.ends.map(e => (e.kind === 'panel' && !e.name ? { ...e, name: d.panel?.name || '' } : e));
      for (const [i, o] of [[0, 1], [1, 0]]) {
        const pe = ends[i];
        if (pe.kind === 'panel' && ends[o].kind === 'unknown' && pe.way && !/INCOMER|\bFROM\b|SPARE/i.test(pe.way)) ends[o] = { kind: 'device', name: pe.way };
      }
      // an end the AI names the same as the rules engine keeps the engine's end, so the
      // sheet's notes (e.g. "LIT003 = EDM controller") still apply to it
      const mine = d.cables.find(c => c.ref === r.ref);
      const nn = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      ends = ends.map(e => mine?.ends.find(m => (m.name && nn(m.name) === nn(e.name)) || (m.kind === 'panel' && e.kind === 'panel' && nn(m.name) === nn(e.name))) || e);
      return { ...d, cables: d.cables.map(c => (c.ref === r.ref ? { ...c, ...a, ends, flags: [], at: c.at, region: c.region, uncertain: [] } : c)) };
    });
    const aRow = mergeDrawings(swapped, rules).rows.find(x => x.ref === r.ref);
    if (!aRow) return null;
    // only the fields in doubt are compared; the rest keep the rules engine's reading
    const fields = {};
    for (const [f] of FIELDS) if (p.fields.includes(f)) fields[f] = { status: compareField(f, r, aRow), rules: fieldText(r, f), ai: fieldText(aRow, f) };
    return { aRow, fields, notes: got.map(j => answers.get(`${j.file}|${j.ref}`).note).filter(Boolean) };
  };

  const jobs = plans.filter(p => p.kind === 'ai').flatMap(p => p.jobs);
  if (jobs.length) await runJobs(jobs, 'AI checking the unsure readings');

  // 5. compare and give every row a status
  const out = [];
  for (const [i, r] of ruleRows.entries()) {
    const p = plans[i];
    const row = { ...r, flags: [...r.flags] };
    const reasons = p.reasons;
    if (p.kind === 'none') { row.check = { status: 'not_needed', plan: 'none' }; out.push(row); continue; }
    if (p.kind === 'person') { row.check = { status: 'person', plan: 'person', why: p.person }; out.push(row); continue; }
    const c = compareRow(r, p);
    if (!c) {
      row.check = { status: 'not_checked', plan: p.kind, why: reasons };
      if (p.kind === 'ai') row.flags.push('AI check could not be done for this cable; please check it on the drawing');
      out.push(row); continue;
    }
    const { aRow, fields, notes } = c;
    for (const [f, label] of FIELDS) {
      const fl = fields[f];
      if (!fl) continue;
      if (fl.status === 'filled') {
        if (f === 'ends') { row.source = aRow.source; row.destination = aRow.destination; }
        else { row[f] = aRow[f]; if (f === 'band') row.voltage = aRow.voltage; }
        row.flags.push(`AI filled in ${label.toLowerCase()}: ${fl.ai}`);
      } else if (fl.status === 'differ') {
        row.flags.push(`AI reads ${label.toLowerCase()} as "${fl.ai}" (rules engine: "${fl.rules}")`);
      }
    }
    const sts = Object.values(fields).map(x => x.status);
    const differ = sts.includes('differ');
    const status = differ ? 'disputed'
      : sts.includes('filled') ? 'filled'
      : sts.every(x => x === 'agree' || x === 'both_empty') ? 'confirmed'
      : 'unconfirmed';
    // the AI confirming an unsure reading clears the "please check" flags it was sent for
    // (but not "No size found" etc.: if neither found it, it is still missing)
    if (status === 'confirmed' && p.kind === 'ai') {
      row.flags = row.flags.filter(f => classifyFlag(f) !== 'reading' || /^No /.test(f));
      row.notes = [...(row.notes || []), `Confirmed by the AI from a close-up (it was checked because ${reasons.join('; ')})`];
    }
    row.check = { status, plan: p.kind, why: reasons, fields, note: notes.join(' ') };
    if (p.person.length) row.check.person = p.person;
    out.push(row);
  }
  out.sort(rules.sortRows);
  const count = st => out.filter(r => r.check?.status === st).length;
  if (stopped) log.push('Stopped: cables not checked yet show the rules engine\'s reading only.');
  return {
    rows: out, log, raw, model: await provider.model(), provider: provider.name,
    stats: { requests, seconds: Math.round((Date.now() - t0) / 1000), tokens: usage, planned: summarisePlan(plans) },
    summary: {
      confirmed: count('confirmed'), disputed: count('disputed'), filled: count('filled'), unconfirmed: count('unconfirmed'),
      person: count('person'), notNeeded: count('not_needed'), notChecked: count('not_checked'),
    },
  };
}
