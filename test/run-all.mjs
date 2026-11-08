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

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readPage } from '../src/pdfread.js';
import { extractDrawing, mergeDrawings } from '../src/engine.js';
import { DEFAULT_RULES } from '../src/rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectsDir = path.join(here, 'projects');
const baselineFile = path.join(here, 'baseline.json');
const args = process.argv.slice(2);
const updateBaseline = args.includes('--update-baseline');
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
  const drawings = [];
  for (const f of pdfFiles) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), verbosity: 0 }).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const geom = await readPage(pdfjs, await doc.getPage(p));
      drawings.push(extractDrawing(geom, path.basename(f)));
    }
  }
  const rules = { ...DEFAULT_RULES, ...(settings.direction ? { direction: settings.direction } : {}) };
  return { drawings, rows: mergeDrawings(drawings, rules).rows };
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
  if (!pdfs.length || xlsx.length !== 1) {
    problems.push(`${name}: needs the BCD PDFs and exactly one .xlsx (the correct schedule). Found ${pdfs.length} PDF(s) and ${xlsx.length} .xlsx file(s).`);
    continue;
  }
  try {
    const correct = await readCorrectSchedule(path.join(dir, xlsx[0]));
    const { drawings, rows } = await runTool(pdfs, settings);
    results[name] = { sheets: drawings.length, ...compare(correct, rows) };
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
