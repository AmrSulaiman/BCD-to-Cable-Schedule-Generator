// Render the close-ups the AI check would send, for looking at them.
//   node tools/crops.mjs <project-dir> <out-dir> [--all]
import fs from 'fs'; import path from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { readPage } from '../src/pdfread.js';
import { extractDrawing, mergeDrawings } from '../src/engine.js';
import { renderRegion } from '../src/ai/render.js';
import { planChecks, summarisePlan } from '../src/ai/targeted.js';
const [dir, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const ds = [], pages = new Map();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).sort()) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(dir, f))), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const d = extractDrawing(await readPage(pdfjs, page), f); ds.push(d); pages.set(f, page);
}
const rows = mergeDrawings(ds).rows;
const plans = planChecks(rows);
console.log(summarisePlan(plans));
for (const [ref, p] of plans) {
  if (p.kind === 'none') continue;
  console.log(p.kind.padEnd(6), ref, p.jobs.map(j => `${j.file} ${j.region}`).join(' | '), p.person.join(' / '));
  for (const j of p.jobs) {
    const img = await renderRegion(pages.get(j.file), j.region, { makeCanvas: (w, h) => createCanvas(w, h), encode: async c => (await c.encode('jpeg', 88)).toString('base64') });
    fs.writeFileSync(path.join(out, `${p.kind}-${ref}-${j.file.replace('.pdf', '')}.jpg`), Buffer.from(img.data, 'base64'));
  }
}
