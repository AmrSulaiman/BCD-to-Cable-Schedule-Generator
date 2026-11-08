// Tests for the targeted AI check, with pretend AIs (no network, no API key).
//   node test/targeted.mjs
import fs from 'fs'; import path from 'path'; import assert from 'assert';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import ExcelJS from 'exceljs';
import { readPage } from '../src/pdfread.js';
import { extractDrawing, mergeDrawings } from '../src/engine.js';
import { DEFAULT_RULES } from '../src/rules.js';
import { targetedCheck, planChecks, summarisePlan } from '../src/ai/targeted.js';

const root = path.dirname(new URL(import.meta.url).pathname);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function load(project) {
  const dir = path.join(root, 'projects', project);
  const drawings = [], sheets = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).sort()) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(dir, f))), verbosity: 0 }).promise;
    const g = await readPage(pdfjs, await doc.getPage(1));
    const d = extractDrawing(g, f);
    drawings.push(d);
    sheets.push({ drawing: d, texts: g.texts, renderRegion: async () => ({ mime: 'image/jpeg', data: 'AAAA' }) });
  }
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(dir, 'correct_schedule.xlsx'));
  const truth = new Map();
  wb.worksheets[0].eachRow((r, i) => { const ref = String(r.getCell(1).text || '').trim(); if (/^[A-Z]{1,3}\d{2}/.test(ref)) truth.set(ref, { source: r.getCell(2).text, destination: r.getCell(3).text, type: r.getCell(4).text, size: r.getCell(5).text }); });
  return { drawings, sheets, rows: mergeDrawings(drawings, DEFAULT_RULES).rows, truth };
}

// pretend AI: `answer(ref, file)` -> cable reading or null; records the requests
function fakeAI(answer, { fail = false, garbage = false } = {}) {
  const calls = [];
  return {
    name: 'fake', calls, model: async () => 'fake-model',
    async generate({ tag, text, images }) {
      calls.push({ tag, n: images.length });
      if (fail) { const e = new Error('Load failed'); e.retryable = false; throw e; }
      if (garbage) return { json: { cables: [{ image: 'x', ref: 42 }, null, 'nonsense'] } };
      const [, file, refs] = tag.match(/^check:(.+?):([^:]+)/);
      return { json: { cables: refs.split(',').map((ref, i) => ({ image: i + 1, ref, found: true, line_leaves_image: false, confidence: 'high', ...answer(ref, file) })) } };
    },
  };
}
const asEnd = e => e.kind === 'panel' ? { kind: 'board_way', name: e.name, way: e.way || '' }
  : e.kind === 'box' ? { kind: 'box', name: e.name }
  : e.kind === 'dno' ? { kind: 'dno', name: 'DNO' }
  : e.kind === 'offsheet' ? { kind: 'other_drawing', name: e.text || '', drawing_number: e.drawing || '' }
  : e.kind === 'open' ? { kind: 'unknown', name: '' }
  : { kind: 'equipment', name: e.name };
// reads exactly what the rules engine read
const echo = drawings => (ref, file) => {
  const c = drawings.find(d => d.file === file).cables.find(c => c.ref === ref);
  return { end_a: asEnd(c.ends[0]), end_b: asEnd(c.ends[1]), cores_size: c.size, cable_type: c.type, band: c.band };
};

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); } };

for (const project of ['gaskell-st', 'knutsford-dt']) {
  const P = await load(project);
  const plan = summarisePlan(planChecks(P.rows));
  console.log(`\n## ${project}: ${P.rows.length} rows — ${plan.ai} unsure (to AI), ${plan.spot} spot checks, ${plan.person} need a person, ${plan.none} sure; ${plan.requests} requests`);

  await test('a fully agreeing AI confirms every checked row and changes nothing', async () => {
    const ai = fakeAI(echo(P.drawings));
    const res = await targetedCheck({ sheets: P.sheets, drawings: P.drawings, ruleRows: P.rows, provider: ai });
    assert.strictEqual(res.summary.disputed, 0, JSON.stringify(res.rows.filter(r => r.check.status === 'disputed').map(r => [r.ref, r.check.fields])));
    for (const r of res.rows) { const o = P.rows.find(x => x.ref === r.ref); assert.deepStrictEqual([r.source, r.destination, r.type, r.size], [o.source, o.destination, o.type, o.size], r.ref); }
    assert.strictEqual(res.summary.confirmed + res.summary.unconfirmed, plan.ai + plan.spot);
    assert.ok(ai.calls.length <= plan.requests + 2, `${ai.calls.length} requests`);
    assert.ok(ai.calls.every(c => c.n <= 5));
    console.log(`     ${ai.calls.length} requests, ${res.summary.confirmed} confirmed, ${res.summary.notNeeded} not needed, ${res.summary.person} for a person`);
  });

  await test('an AI that always fails leaves the rules engine reading untouched', async () => {
    const ai = fakeAI(null, { fail: true });
    const res = await targetedCheck({ sheets: P.sheets, drawings: P.drawings, ruleRows: P.rows, provider: ai });
    assert.ok(ai.calls.length <= 3, `kept trying after the AI failed: ${ai.calls.length} requests`);
    assert.strictEqual(res.rows.length, P.rows.length);
    for (const r of res.rows) { const o = P.rows.find(x => x.ref === r.ref); assert.strictEqual(r.source, o.source); assert.strictEqual(r.destination, o.destination); }
    assert.strictEqual(res.summary.notChecked, plan.ai + plan.spot);
  });

  await test('garbage answers are ignored, not applied', async () => {
    const res = await targetedCheck({ sheets: P.sheets, drawings: P.drawings, ruleRows: P.rows, provider: fakeAI(null, { garbage: true }) });
    for (const r of res.rows) { const o = P.rows.find(x => x.ref === r.ref); assert.strictEqual(r.source, o.source); }
    assert.strictEqual(res.summary.disputed, 0);
  });

  await test('a spot check that disagrees makes the rest of that sheet get checked', async () => {
    const plans = planChecks(P.rows);
    const spot = [...plans.values()].find(p => p.kind === 'spot');
    const base = echo(P.drawings);
    const ai = fakeAI((ref, file) => ref === spot.jobs[0].ref ? { ...base(ref, file), end_b: { kind: 'equipment', name: 'SOMETHING ELSE' } } : base(ref, file));
    const res = await targetedCheck({ sheets: P.sheets, drawings: P.drawings, ruleRows: P.rows, provider: ai });
    const row = res.rows.find(r => r.ref === spot.jobs[0].ref);
    assert.strictEqual(row.check.status, 'disputed');
    assert.strictEqual(row.source + row.destination, P.rows.find(r => r.ref === row.ref).source + P.rows.find(r => r.ref === row.ref).destination, 'disputed value must not be applied');
    const onSheet = P.rows.filter(r => r.views.some(v => v.file === spot.jobs[0].file) && plans.get(r.ref).kind === 'none').length;
    const esc = res.rows.filter(r => r.check.plan === 'escalated').length;
    assert.ok(esc > 0 && esc === onSheet, `escalated ${esc}, expected ${onSheet}`);
    console.log(`     disagreement on ${spot.jobs[0].file} → ${esc} more cables checked`);
  });

  await test('an AI that reads like the correct schedule: what would it catch?', async () => {
    const base = echo(P.drawings);
    const ai = fakeAI((ref, file) => {
      const t = P.truth.get(ref), b = base(ref, file);
      if (!t) return b;
      // use the correct names for whichever end differs
      const want = [t.source, t.destination].map(norm);
      const row = P.rows.find(r => r.ref === ref);
      const have = [row.source, row.destination].map(norm);
      if (want.every(w => have.includes(w))) return b;
      return { ...b, end_a: { kind: 'equipment', name: t.source }, end_b: { kind: 'equipment', name: t.destination } };
    });
    const res = await targetedCheck({ sheets: P.sheets, drawings: P.drawings, ruleRows: P.rows, provider: ai });
    const wrong = P.rows.filter(r => { const t = P.truth.get(r.ref); return t && ![t.source, t.destination].map(norm).every(w => [r.source, r.destination].map(norm).includes(w)); });
    for (const w of wrong) {
      const r = res.rows.find(x => x.ref === w.ref);
      console.log(`     wrong ends ${w.ref}: plan ${r.check.plan}, status ${r.check.status}`);
    }
  });
}
if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll targeted-check tests passed');
