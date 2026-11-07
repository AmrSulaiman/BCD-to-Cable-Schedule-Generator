// CLI: node run.mjs out.json a.pdf b.pdf ...
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import { readPage } from './src/pdfread.js';
import { extractDrawing, mergeDrawings } from './src/engine.js';
const [out, ...files] = process.argv.slice(2);
const drawings = [];
for (const f of files) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), verbosity: 0 }).promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const g = await readPage(pdfjs, await doc.getPage(p));
    drawings.push(extractDrawing(g, f.split('/').pop()));
  }
}
const merged = mergeDrawings(drawings);
fs.writeFileSync(out, JSON.stringify({ drawings, ...merged }, null, 1));
for (const d of drawings) console.log(d.file, JSON.stringify(d.drawing), 'panel:', d.panel?.name, 'cables:', d.cables.length);
for (const r of merged.rows) console.log([r.ref, r.source, r.destination, r.type, r.size, r.voltage, r.band].join(' | '), r.flags.length ? ' !! ' + r.flags.join('; ') : '');
