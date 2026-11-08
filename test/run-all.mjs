// run-all.mjs — automated accuracy tests.
//
// Every folder in test/projects/ is one test project:
//   test/projects/<name>/*.pdf        the BCDs for one cable schedule
//   test/projects/<name>/*.xlsx       the checked, correct cable schedule
//   test/projects/<name>/settings.json  (optional) { "direction": "supply-first" | "field-first" }
//
// For each project the tool builds the schedule from the PDFs and compares it,
// cable by cable, with the correct schedule. Results are printed, written to
// test/results.md, and (on GitHub Actions) shown on the run's summary page.
//
// test/baseline.json holds the scores last accepted as good. If any score drops
// below its baseline the run fails, so a change that breaks an old project is caught.
//
//   node test/run-all.mjs                    run all projects
//   node test/run-all.mjs gaskell-st         run one project
//   node test/run-all.mjs --update-baseline  accept the current scores as the new baseline
//
// AI cross-check:
//   If a project has ai-answers.json (the AI's saved answers), the cross-check is replayed
//   from it, free and repeatable, and scored as "AI alone" and "Rules + AI".
//   GEMINI_API_KEY=... node test/run-all.mjs --ai-live gaskell-st
//     asks the AI again and saves its answers to ai-answers.json.

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readPage } from '../src/pdfread.js';
import { extractDrawing, mergeDrawings } from '../src/engine.js';
import { DEFAULT_RULES } from '../src/rules.js';
import { crossCheck, recordingProvider, replayProvider } from '../src/ai/crosscheck.js';
import { renderPageForAI } from '../src/ai/render.js';
import { geminiProvider } from '../src/ai/gemini.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectsDir = path.join(here, 'projects');
const baselineFile = path.join(here, 'baseline.json');
const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
const updateSnapshot = args.includes('--update-snapshot');
const aiLive = args.includes('--ai-live');
const only = args.filter(a => !a.startsWith('--'));

const METRICS = [
  ['refs', 'Cables found'],
  ['ends', 'Right two ends'],
  ['direction', 'Right direction'],
  ['type', 'Cable type'],
  ['size', 'Cores & size'],
  ['voltage', 'Voltage'],
  ['band', 'Band'],
];

// ---------------------------------------------------------------- reading the correct schedule
async function readCorrectSchedule(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets.find(w => /cable\s*schedule/i.test(w.name)) || wb.worksheets[0];
  const text = v => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map(r => r.text).join('');
      if (v.result != null) return String(v.result);
      if (v.text != null) return String(v.text);
    }
    return String(v);
  };
  // header row = first row whose column A mentions the cable reference
  let headerRow = 0;
  ws.eachRow((row, i) => { if (!headerRow && /cable\s*(ref|id|no|number|tag)/i.test(text(row.getCell(1).value))) headerRow = i; });
  if (!headerRow) headerRow = 5;
  const head = ws.getRow(headerRow);
  const col = {};
  head.eachCell((cell, c) => {
    const h = text(cell.value).toLowerCase();
    if (/source|from/.test(h) && !col.source) col.source = c;
    else if (/destination|\bto\b/.test(h) && !col.destination) col.destination = c;
    else if (/type/.test(h) && !/install/.test(h) && !col.type) col.type = c;
    else if (/cores|size/.test(h) && !col.size) col.size = c;
    else if (/band/.test(h) && !col.band) col.band = c;
    else if (/voltage/.test(h) && !col.voltage) col.voltage = c;
  });
  const fallback = { source: 2, destination: 3, type: 4, size: 5, voltage: 6, band: 7 };
  for (const k of Object.keys(fallback)) col[k] = col[k] || fallback[k];
  const rows = new Map();
  for (let i = headerRow + 1; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const ref = text(row.getCell(1).value).trim();
    if (!ref) continue;
    const r = { ref };
    for (const k of Object.keys(fallback)) r[k] = text(row.getCell(col[k]).value).trim();
    rows.set(ref, r);
  }
  return rows;
}

// ---------------------------------------------------------------- running the tool
async function runTool(pdfFiles, settings) {
  const drawings = [], sheets = [];
  for (const f of pdfFiles) {
    const bytes = fs.readFileSync(f);
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const geom = await readPage(pdfjs, await doc.getPage(p));
      const d = extractDrawing(geom, doc.numPages > 1 ? `${path.basename(f)} (page ${p})` : path.basename(f));
      drawings.push(d);
      sheets.push({
        drawing: d, pageText: geom.texts.map(t => t.str).join(' '),
        getImages: async () => {
          const { createCanvas } = await import('@napi-rs/canvas');
          const doc2 = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
          const r = await renderPageForAI(await doc2.getPage(p), { area: d.page.area, makeCanvas: createCanvas, encode: async c => (await c.encode('png')).toString('base64') });
          return r.images;
        },
      });
    }
  }
  const rules = { ...DEFAULT_RULES, ...(settings.direction ? { direction: settings.direction } : {}) };
  return { drawings, sheets, rules, rows: mergeDrawings(drawings, rules).rows };
}

// ---------------------------------------------------------------- comparing
const norm = s => String(s || '').toLowerCase().replace(/²/g, '2').replace(/×/g, 'x').replace(/[\s.]+/g, '');

function compare(correct, rows) {
  const got = new Map(rows.map(r => [r.ref, r]));
  const score = Object.fromEntries(METRICS.map(([k]) => [k, 0]));
  const diffs = [];
  for (const [ref, k] of correct) {
    const g = got.get(ref);
    if (!g) { diffs.push({ ref, what: 'Missing: the tool did not find this cable' }); continue; }
    score.refs++;
    const same = norm(k.source) === norm(g.source) && norm(k.destination) === norm(g.destination);
    const swapped = norm(k.source) === norm(g.destination) && norm(k.destination) === norm(g.source);
    if (same) { score.ends++; score.direction++; }
    else if (swapped) { score.ends++; diffs.push({ ref, what: `Direction reversed. Correct: ${k.source} → ${k.destination}` }); }
    else diffs.push({ ref, what: `Ends. Correct: ${k.source} → ${k.destination}. Tool: ${g.source} → ${g.destination}` });
    for (const f of ['type', 'size', 'voltage', 'band']) {
      if (norm(k[f]) === norm(g[f])) score[f]++;
      else diffs.push({ ref, what: `${f[0].toUpperCase() + f.slice(1)}. Correct: "${k[f]}". Tool: "${g[f]}"` });
    }
  }
  const extra = rows.filter(r => !correct.has(r.ref)).map(r => r.ref);
  for (const ref of extra) diffs.push({ ref, what: 'Extra: the tool found a cable that is not in the correct schedule' });
  return { total: correct.size, score, extra: extra.length, flagged: rows.filter(r => r.flags.length).length, diffs };
}

// ---------------------------------------------------------------- main
const projects = fs.existsSync(projectsDir)
  ? fs.readdirSync(projectsDir).filter(d => fs.statSync(path.join(projectsDir, d)).isDirectory()).filter(d => !only.length || only.includes(d)).sort()
  : [];
if (!projects.length) { console.error('No test projects found in test/projects/'); process.exit(1); }

const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
const results = {};
const problems = [];

for (const name of projects) {
  const dir = path.join(projectsDir, name);
  const files = fs.readdirSync(dir);
  const pdfs = files.filter(f => /\.pdf$/i.test(f)).map(f => path.join(dir, f));
  const xlsx = files.filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  const settings = files.includes('settings.json') ? JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) : {};
  // A project without a checked schedule can use a snapshot: the tool's output as last
  // checked by hand (snapshot.json). It does not prove the output is right, only that a
  // change did not make it worse. --update-snapshot writes it.
  const snapFile = path.join(dir, 'snapshot.json');
  const useSnap = !xlsx.length && (fs.existsSync(snapFile) || updateSnapshot);
  if (!pdfs.length || (xlsx.length !== 1 && !useSnap)) {
    problems.push(`${name}: needs the BCD PDFs and exactly one .xlsx (the correct schedule), or a snapshot.json. Found ${pdfs.length} PDF(s) and ${xlsx.length} .xlsx file(s).`);
    continue;
  }
  try {
    let correct;
    if (useSnap) {
      if (updateSnapshot) {
        const { rows } = await runTool(pdfs, settings);
        fs.writeFileSync(snapFile, JSON.stringify({ note: 'Tool output checked by hand against the drawings; not an issued schedule.', rows: rows.map(r => ({ ref: r.ref, source: r.source, destination: r.destination, type: r.type, size: r.size, voltage: r.voltage, band: r.band })) }, null, 1) + '\n');
        console.error(`${name}: snapshot written`);
      }
      correct = new Map();
      for (const r of JSON.parse(fs.readFileSync(snapFile, 'utf8')).rows) if (!correct.has(r.ref)) correct.set(r.ref, r);
    } else correct = await readCorrectSchedule(path.join(dir, xlsx[0]));
    const { drawings, sheets, rules, rows } = await runTool(pdfs, settings);
    results[name] = { sheets: drawings.length, ...compare(correct, rows) };
    // AI cross-check: live (records answers) or replayed from saved answers
    const answersFile = path.join(dir, 'ai-answers.json');
    let provider = null, recorder = null;
    if (aiLive) {
      if (!process.env.GEMINI_API_KEY) throw new Error('--ai-live needs GEMINI_API_KEY');
      recorder = recordingProvider(geminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }));
      provider = recorder;
      console.error(`${name}: asking the AI (${await provider.model()})…`);
    } else if (fs.existsSync(answersFile)) {
      provider = replayProvider(JSON.parse(fs.readFileSync(answersFile, 'utf8')).answers);
    }
    if (provider) {
      const res = await crossCheck({ sheets, ruleRows: rows, rules, provider, onProgress: m => aiLive && console.error('  ' + m) });
      if (recorder) fs.writeFileSync(answersFile, JSON.stringify({ model: res.model, promptVersion: res.raw.promptVersion, recorded: new Date().toISOString(), answers: recorder.store }, null, 1) + '\n');
      const final = compare(correct, res.rows), alone = compare(correct, res.aiRows);
      // how trustworthy is an "agreed" row?
      const agreed = res.rows.filter(r => r.check?.status === 'agreed');
      const agreedRight = agreed.filter(r => { const k = correct.get(r.ref); return k && ['type', 'size', 'band'].every(f => norm(k[f]) === norm(r[f])) &&
        [norm(k.source), norm(k.destination)].sort().join('|') === [norm(r.source), norm(r.destination)].sort().join('|'); }).length;
      results[name].ai = { model: res.model, alone, final, summary: res.summary, agreed: agreed.length, agreedRight, log: res.log };
    }
  } catch (e) {
    problems.push(`${name}: crashed: ${e.stack || e}`);
  }
}

// regressions against the baseline
const regressions = [];
for (const [name, r] of Object.entries(results)) {
  const b = baseline[name];
  if (!b) continue;
  for (const [k, label] of METRICS) if (r.score[k] < (b[k] ?? 0)) regressions.push(`${name}: ${label} dropped from ${b[k]} to ${r.score[k]} (of ${r.total})`);
  if (r.extra > (b.extra ?? 0)) regressions.push(`${name}: extra cables rose from ${b.extra ?? 0} to ${r.extra}`);
}

// ---------------------------------------------------------------- report
const pct = (n, t) => t ? `${n}/${t} (${Math.round(100 * n / t)}%)` : '—';
const lines = [];
lines.push('# Cable schedule accuracy', '');
lines.push(`| Project | Sheets | ${METRICS.map(m => m[1]).join(' | ')} | Extra | Flagged for checking |`);
lines.push(`|---|---|${METRICS.map(() => '---').join('|')}|---|---|`);
const tot = { total: 0, extra: 0, ...Object.fromEntries(METRICS.map(([k]) => [k, 0])) };
for (const [name, r] of Object.entries(results)) {
  const b = baseline[name];
  const cell = k => {
    const v = pct(r.score[k], r.total);
    if (!b) return v;
    return r.score[k] > b[k] ? `${v} ⬆` : r.score[k] < b[k] ? `${v} ⬇` : v;
  };
  lines.push(`| ${name}${b ? '' : ' (new)'} | ${r.sheets} | ${METRICS.map(([k]) => cell(k)).join(' | ')} | ${r.extra} | ${r.flagged} |`);
  tot.total += r.total; tot.extra += r.extra;
  for (const [k] of METRICS) tot[k] += r.score[k];
}
if (Object.keys(results).length > 1)
  lines.push(`| **All projects** | | ${METRICS.map(([k]) => `**${pct(tot[k], tot.total)}**`).join(' | ')} | **${tot.extra}** | |`);
lines.push('');
if (regressions.length) lines.push('## ❌ Accuracy went down', '', ...regressions.map(r => `- ${r}`), '');
if (problems.length) lines.push('## ❌ Problems', '', ...problems.map(p => `- ${p}`), '');
const newOnes = Object.keys(results).filter(n => !baseline[n]);
if (newOnes.length && !updateBaseline) lines.push(`New project(s) with no baseline yet: ${newOnes.join(', ')}. Their scores are reported but cannot fail the run until the baseline is updated.`, '');
const withAI = Object.entries(results).filter(([, r]) => r.ai);
if (withAI.length) {
  lines.push('## AI cross-check', '');
  lines.push(`| Project | Model | Reading | ${METRICS.map(m => m[1]).join(' | ')} |`);
  lines.push(`|---|---|---|${METRICS.map(() => '---').join('|')}|`);
  for (const [name, r] of withAI) {
    lines.push(`| ${name} | ${r.ai.model} | Rules alone | ${METRICS.map(([k]) => pct(r.score[k], r.total)).join(' | ')} |`);
    lines.push(`| | | AI alone | ${METRICS.map(([k]) => pct(r.ai.alone.score[k], r.total)).join(' | ')} |`);
    lines.push(`| | | **Rules + AI** | ${METRICS.map(([k]) => `**${pct(r.ai.final.score[k], r.total)}**`).join(' | ')} |`);
  }
  lines.push('');
  for (const [name, r] of withAI) {
    const s = r.ai.summary;
    lines.push(`**${name}:** ${s.agreed} rows agreed (${r.ai.agreedRight} of them fully match the correct schedule), ${s.disputed} disputed, ${s.unconfirmed} partly confirmed, ${s.aiOnly} found by AI only, ${s.rulesOnly} not reported by AI, ${s.notChecked} not checked.`);
  }
  lines.push('');
}
lines.push('## Differences by project', '');
for (const [name, r] of Object.entries(results)) {
  lines.push(`<details><summary><b>${name}</b>: ${r.diffs.length} difference${r.diffs.length === 1 ? '' : 's'}</summary>`, '');
  for (const d of r.diffs) lines.push(`- \`${d.ref}\` ${d.what}`);
  lines.push('', '</details>', '');
}
const report = lines.join('\n');
fs.writeFileSync(path.join(here, 'results.md'), report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

// console version (without the long difference lists)
console.log(report.split('## Differences by project')[0]);
console.log('Full list of differences: test/results.md');

if (updateBaseline) {
  const next = { ...baseline };
  for (const [name, r] of Object.entries(results)) next[name] = { ...r.score, extra: r.extra, total: r.total };
  fs.writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n');
  console.log('Baseline updated: test/baseline.json');
}

process.exit(regressions.length || problems.length ? 1 : 0);
