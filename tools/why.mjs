// Debug: show how the tool read particular cables.
//   node tools/why.mjs <pdf> <ref regex>
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import { readPage } from '../src/pdfread.js';
import { extractDrawing } from '../src/engine.js';
const [file, pat] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
const g = await readPage(pdfjs, await doc.getPage(1));
const d = extractDrawing(g, file);
const re = new RegExp(pat);
for (const c of d.cables.filter(c => re.test(c.ref))) {
  console.log(`${c.ref}  label at ${c.at}  spec "${c.specRaw}"`);
  for (const e of c.ends) console.log(`   end at ${e.pos}: ${e.kind} "${e.name || e.way || ''}"`);
  if (c.flags.length) console.log('   flags:', c.flags.join(' | '));
  for (const e of c.ends) {
    const near = g.texts.filter(t => t.angle === 0 && Math.hypot(t.cx - e.pos[0], t.cy - e.pos[1]) < 200).map(t => `"${t.str}"@${Math.round(t.cx)},${Math.round(t.cy)}`);
    console.log(`   text within 200pt of ${e.pos}: ${near.slice(0, 8).join('  ')}`);
  }
}
