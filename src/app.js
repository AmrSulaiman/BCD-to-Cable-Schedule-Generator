// app.js — Layer 4: the browser page. Reads dropped PDFs, shows the rows for review, exports.
// Everything runs in the viewer's browser; no drawing is uploaded anywhere.
import * as pdfjs from 'PDFJS_URL';
import { readPage } from './pdfread.js';
import { extractDrawing, mergeDrawings } from './engine.js';
import { DEFAULT_RULES, fullName } from './rules.js';
import { buildWorkbook, COLUMNS } from './excel.js';

pdfjs.GlobalWorkerOptions.workerSrc = 'PDFJS_WORKER_URL';

const $ = s => document.querySelector(s);
const state = { drawings: [], rows: [], template: null, templateName: 'Built-in template', onlyFlagged: false };

const HEAD = ['Cable ref', 'Source', 'Destination', 'Cable type', 'Cores & size', 'Voltage', 'Band'];
const EDITABLE = ['ref', 'source', 'destination', 'type', 'size', 'voltage', 'band'];

function b64ToBuf(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
state.template = b64ToBuf(document.getElementById('template-b64').textContent.trim());

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const status = (msg, kind = '') => { const el = $('#status'); el.textContent = msg; el.dataset.kind = kind; };

// ---------- reading ----------
async function readFiles(files) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name));
  if (!pdfs.length) { status('Those files are not PDFs. Drop the BCD PDFs exported from AutoCAD.', 'bad'); return; }
  for (const [i, f] of pdfs.entries()) {
    status(`Reading ${f.name} (${i + 1} of ${pdfs.length})…`);
    try {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()), verbosity: 0 }).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        const geom = await readPage(pdfjs, await doc.getPage(p));
        const d = extractDrawing(geom, doc.numPages > 1 ? `${f.name} (page ${p})` : f.name);
        d.warn = [];
        if (geom.texts.length < 10) d.warn.push('No text layer: looks like a scanned PDF. Export it again from AutoCAD as a vector PDF.');
        else if (!d.panel) d.warn.push('No board header strip found (REFERENCE / DESCRIPTION rows).');
        if (!d.cables.length && geom.texts.length >= 10) d.warn.push('No cable references found.');
        if (!d.drawing.clientNumber) d.warn.push('Client drawing number not found, so links from other sheets to this one cannot be resolved.');
        // replace an earlier copy of the same drawing
        state.drawings = state.drawings.filter(x => x.file !== d.file && !(d.drawing.wbNumber && x.drawing.wbNumber === d.drawing.wbNumber));
        state.drawings.push(d);
      }
    } catch (e) {
      console.error(e);
      status(`Could not read ${f.name}: ${e.message || e}`, 'bad');
    }
  }
  fillHeaderDefaults();
  remerge();
  status(`Read ${state.drawings.length} drawing${state.drawings.length === 1 ? '' : 's'}.`, 'good');
}

function fillHeaderDefaults() {
  const d = state.drawings.find(x => x.drawing.project || x.drawing.clientNumber);
  if (!d) return;
  const set = (id, v) => { const el = $(id); if (!el.value && v) el.value = v; };
  set('#h-title', d.drawing.project);
  const m = (d.drawing.clientNumber || '').match(/^(\d+-\d+)/);
  set('#h-number', m ? m[1] : '');
}

function remerge() {
  const rules = { ...DEFAULT_RULES, direction: $('#direction').value };
  state.rows = mergeDrawings(state.drawings, rules).rows;
  render();
}

// ---------- rendering ----------
function render() {
  // drawings
  const dl = $('#drawings');
  dl.innerHTML = state.drawings.length ? state.drawings.map((d, i) => `
    <li class="dwg">
      <div class="dwg-main">
        <strong>${esc(d.drawing.title || d.file)}</strong>
        <span class="mono">${esc(d.drawing.wbNumber || '—')}</span>
        <span class="mono muted">Client ${esc(d.drawing.clientNumber || '—')} · Rev ${esc(d.drawing.revision || '—')}</span>
        <span class="muted">${esc(d.panel ? fullName(d.panel.name) : 'No panel found')} · ${d.cables.length} cable label${d.cables.length === 1 ? '' : 's'}</span>
        ${d.warn.map(w => `<span class="warn">${esc(w)}</span>`).join('')}
      </div>
      <button class="ghost small" data-remove="${i}" aria-label="Remove ${esc(d.file)}">Remove</button>
    </li>`).join('') : '<li class="empty">No drawings yet.</li>';

  // tiles
  const flagged = state.rows.filter(r => r.flags.length).length;
  $('#t-dwg').textContent = state.drawings.length;
  $('#t-rows').textContent = state.rows.length;
  $('#t-flag').textContent = flagged;
  $('#tile-flag').dataset.kind = flagged ? 'warn' : 'good';

  // table
  const rows = state.onlyFlagged ? state.rows.filter(r => r.flags.length) : state.rows;
  $('#thead').innerHTML = `<tr><th class="sev" aria-label="Status"></th>${HEAD.map(h => `<th>${h}</th>`).join('')}<th>Sheets</th><th>Check</th></tr>`;
  $('#tbody').innerHTML = rows.length ? rows.map(r => {
    const i = state.rows.indexOf(r);
    return `<tr class="${r.flags.length ? 'flagged' : ''}">
      <td class="sev"><span class="dot" title="${r.flags.length ? 'Needs checking' : 'OK'}"></span></td>
      ${EDITABLE.map(k => `<td contenteditable="true" spellcheck="false" data-i="${i}" data-k="${k}" class="${k === 'ref' || k === 'size' ? 'mono' : ''}">${esc(r[k])}</td>`).join('')}
      <td class="sheets mono muted">${r.sheets.map(s => esc(s.replace(/^.*-W-/, 'W-'))).join('<br>')}</td>
      <td class="flags">${r.flags.map(f => `<span class="chip">${esc(f)}</span>`).join('')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="10" class="empty">${state.rows.length ? 'No rows need checking.' : 'Drop BCD PDFs above to build the schedule.'}</td></tr>`;

  const ready = state.rows.length > 0;
  for (const b of document.querySelectorAll('[data-needs-rows]')) b.disabled = !ready;
}

// ---------- export ----------
let downloadsApi;
async function saveFile(filename, data) {
  if (downloadsApi === undefined && window.claude?.use) {
    try { downloadsApi = await window.claude.use('downloads'); } catch { downloadsApi = null; }
  }
  if (downloadsApi) {
    try { await downloadsApi.save({ filename, data }); status(`Saved ${filename}.`, 'good'); }
    catch (e) { status(e?.code === 'declined' ? 'Download cancelled.' : `Could not save: ${e?.message || e?.code}`, e?.code === 'declined' ? '' : 'bad'); }
    return;
  }
  // standalone page (opened from disk or GitHub Pages)
  const blob = data instanceof Blob ? data : new Blob([data]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  status(`Downloaded ${filename}.`, 'good');
}

const header = () => ({
  projectTitle: $('#h-title').value.trim(), projectNumber: $('#h-number').value.trim(),
  documentNumber: $('#h-doc').value.trim(), revision: $('#h-rev').value.trim(),
});
const safeName = s => (s || 'Cable_Schedule').replace(/[^\w.-]+/g, '_');

async function exportXlsx() {
  const unresolved = state.rows.filter(r => r.flags.length).length;
  status('Building the Excel file…');
  const buf = await buildWorkbook(window.ExcelJS, state.template.slice(0), header(), state.rows);
  const h = header();
  await saveFile(`${safeName(h.documentNumber || h.projectTitle + '_Cable_Schedule')}.xlsx`, new Blob([buf]));
  if (unresolved) status(`Excel file ready. ${unresolved} row${unresolved === 1 ? '' : 's'} still marked for checking.`, 'warn');
}
function exportJson() {
  const out = { generated: new Date().toISOString(), header: header(), drawings: state.drawings.map(d => ({ file: d.file, drawing: d.drawing, panel: d.panel, cables: d.cables })), rows: state.rows };
  saveFile(`${safeName(header().projectTitle)}_cables.json`, JSON.stringify(out, null, 2));
}
function exportReview() {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['Cable ref', 'Source', 'Destination', 'Check'].map(q).join(',')];
  for (const r of state.rows) for (const f of r.flags) lines.push([r.ref, r.source, r.destination, f].map(q).join(','));
  saveFile(`${safeName(header().projectTitle)}_review_list.csv`, lines.join('\r\n'));
}

// ---------- events ----------
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => readFiles(e.dataTransfer.files));
$('#file').addEventListener('change', e => { readFiles(e.target.files); e.target.value = ''; });
$('#tpl').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  state.template = await f.arrayBuffer(); state.templateName = f.name;
  $('#tpl-name').textContent = f.name; e.target.value = '';
});
$('#direction').addEventListener('change', remerge);
$('#only-flagged').addEventListener('change', e => { state.onlyFlagged = e.target.checked; render(); });
$('#drawings').addEventListener('click', e => {
  const i = e.target.dataset.remove; if (i === undefined) return;
  state.drawings.splice(+i, 1); remerge();
});
$('#tbody').addEventListener('input', e => {
  const td = e.target.closest('td[data-k]'); if (!td) return;
  state.rows[+td.dataset.i][td.dataset.k] = td.textContent.trim();
});
$('#tbody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('td[contenteditable]')) { e.preventDefault(); e.target.blur(); } });
$('#btn-xlsx').addEventListener('click', exportXlsx);
$('#btn-json').addEventListener('click', exportJson);
$('#btn-csv').addEventListener('click', exportReview);
$('#btn-clear').addEventListener('click', () => { state.drawings = []; state.rows = []; render(); status('Cleared.'); });

render();
