// Compare engine output with a known-correct schedule.
// node test/compare.mjs test/answer_key.xlsx out.json
import ExcelJS from 'exceljs';
import fs from 'fs';
const [keyFile, outFile] = process.argv.slice(2);
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(keyFile);
const ws = wb.getWorksheet('Cable Schedule');
const key = new Map();
ws.eachRow((row, i) => {
  if (i < 6) return;
  const v = c => String(row.getCell(c).value ?? '').trim();
  if (!v(1)) return;
  key.set(v(1), { ref: v(1), source: v(2), destination: v(3), type: v(4), size: v(5), voltage: v(6), band: v(7) });
});
const out = JSON.parse(fs.readFileSync(outFile));
const got = new Map(out.rows.map(r => [r.ref, r]));
const n = s => String(s || '').toLowerCase().replace(/²/g, '2').replace(/×/g, 'x').replace(/[\s.]+/g, '');
let ok = 0, total = 0; const diffs = [];
const cnt = { refs: 0, ends: 0, dir: 0, type: 0, size: 0, voltage: 0, band: 0 };
for (const [ref, k] of key) {
  const g = got.get(ref);
  if (!g) { diffs.push(`${ref}: MISSING from output`); continue; }
  cnt.refs++;
  const line = [];
  const sameEnds = n(k.source) === n(g.source) && n(k.destination) === n(g.destination);
  const swapped = n(k.source) === n(g.destination) && n(k.destination) === n(g.source);
  if (sameEnds) { cnt.ends++; cnt.dir++; }
  else if (swapped) { cnt.ends++; line.push(`direction reversed (key: ${k.source} -> ${k.destination})`); }
  else line.push(`ends: key "${k.source}" -> "${k.destination}" | got "${g.source}" -> "${g.destination}"`);
  for (const f of ['type', 'size', 'voltage', 'band']) {
    if (n(k[f]) === n(g[f])) cnt[f]++; else line.push(`${f}: key "${k[f]}" | got "${g[f]}"`);
  }
  if (line.length) diffs.push(`${ref}: ` + line.join('; ') + (g.flags.length ? `   [tool flagged: ${g.flags.join(' / ')}]` : ''));
}
for (const r of out.rows) if (!key.has(r.ref)) diffs.push(`${r.ref}: EXTRA in output (not in key)`);
const N = key.size;
console.log(`Answer key rows: ${N}   output rows: ${out.rows.length}`);
for (const [k, v] of Object.entries(cnt)) console.log(`${k.padEnd(8)} ${v}/${N}`);
console.log('\nDifferences:'); diffs.forEach(d => console.log(' - ' + d));
