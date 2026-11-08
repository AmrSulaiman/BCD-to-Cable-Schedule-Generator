// app.js — Layer 4: the browser page. Reads dropped PDFs, shows the rows for review, exports.
// The rules engine runs entirely in the viewer's browser. The optional AI cross-check sends
// drawing images to the chosen AI provider, only when the user switches it on.
import * as pdfjs from 'PDFJS_URL';
import { readPage } from './pdfread.js';
import { extractDrawing, mergeDrawings } from './engine.js';
import { DEFAULT_RULES, fullName } from './rules.js';
import { buildWorkbook } from './excel.js';
import { renderPageForAI, renderRegion } from './ai/render.js';
import { geminiProvider } from './ai/gemini.js';
import { crossCheck, recordingProvider, replayProvider, resumeProvider } from './ai/crosscheck.js';
import { targetedCheck, planChecks, summarisePlan } from './ai/targeted.js';

pdfjs.GlobalWorkerOptions.workerSrc = 'PDFJS_WORKER_URL';

const $ = s => document.querySelector(s);
const state = {
  drawings: [], rows: [], template: null, onlyFlagged: false,
  sources: new Map(),   // file -> { bytes, page, pageText, texts }   kept so the AI can render the sheet later
  ruleRows: [],         // the rules engine's rows, before any AI check
  ai: null,             // { store, model, provider, summary, log, files }  last AI cross-check
};

const HEAD = ['Cable ref', 'Source', 'Destination', 'Cable type', 'Cores & size', 'Voltage', 'Band'];
const EDITABLE = ['ref', 'source', 'destination', 'type', 'size', 'voltage', 'band'];
const FIELD_COLS = { ends: ['source', 'destination'], type: ['type'], size: ['size'], band: ['band'] };
const FIELD_LABEL = { ends: 'Ends', type: 'Type', size: 'Size', band: 'Band' };
const STATUS = {
  confirmed: ['Confirmed', 'The AI read the same from a close-up of the drawing'],
  filled: ['AI filled in', 'The AI filled in a value the rules engine could not find — check it'],
  person: ['Needs a person', 'The information is missing or the drawings disagree; the AI cannot settle this'],
  not_needed: ['Not needed', 'A clear-cut reading, so it was not sent to the AI'],
  resolved: ['Picked by you', 'You chose between the two readings'],
  agreed: ['Agreed', 'AI and rules engine agree'],
  disputed: ['Disputed', 'AI and rules engine disagree'],
  unconfirmed: ['Unconfirmed', 'Partly confirmed by the AI'],
  ai_only: ['AI only', 'Found by the AI only'],
  rules_only: ['Rules only', 'The AI did not report this cable'],
  not_checked: ['Not checked', 'The AI check did not finish for this cable'],
};

function b64ToBuf(b64) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
state.template = b64ToBuf(document.getElementById('template-b64').textContent.trim());

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const status = (msg, kind = '') => { const el = $('#status'); el.textContent = msg; el.dataset.kind = kind; };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

// ---------- reading ----------
async function readFiles(files) {
  const pdfs = [...files].filter(f => /\.pdf$/i.test(f.name));
  if (!pdfs.length) { status('Those files are not PDFs. Drop the BCD PDFs exported from AutoCAD.', 'bad'); return; }
  for (const [i, f] of pdfs.entries()) {
    status(`Reading ${f.name} (${i + 1} of ${pdfs.length})…`);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        const geom = await readPage(pdfjs, await doc.getPage(p));
        const d = extractDrawing(geom, doc.numPages > 1 ? `${f.name} (page ${p})` : f.name);
        d.warn = [];
        if (geom.texts.length < 10) d.warn.push('No text layer: looks like a scanned PDF. Only the AI cross-check can read it.');
        else if (!d.panel) d.warn.push('No board header strip found (REFERENCE / DESCRIPTION rows).');
        if (!d.cables.length && geom.texts.length >= 10) d.warn.push('No cable references found.');
        state.drawings = state.drawings.filter(x => x.file !== d.file && !(d.drawing.wbNumber && x.drawing.wbNumber === d.drawing.wbNumber));
        state.drawings.push(d);
        state.sources.set(d.file, { bytes, page: p, pageText: geom.texts.map(t => t.str).join(' '), texts: geom.texts.map(({ str, x0, y0, x1, y1 }) => ({ str, x0, y0, x1, y1 })) });
      }
    } catch (e) {
      console.error(e);
      status(`Could not read ${f.name}: ${e.message || e}`, 'bad');
    }
  }
  fillHeaderDefaults();
  await remerge();
  const autoAI = $('#ai-on').checked && $('#ai-auto').checked && $('#ai-key').value.trim() && state.drawings.length && !aiRun?.timer;
  status(`Read ${state.drawings.length} drawing${state.drawings.length === 1 ? '' : 's'}.${$('#ai-on').checked && !autoAI ? ' Click "Run AI cross-check" to check them with the AI.' : ''}`, 'good');
  if (autoAI) runAI(false);
}

function fillHeaderDefaults() {
  const d = state.drawings.find(x => x.drawing.project || x.drawing.clientNumber);
  if (!d) return;
  const set = (id, v) => { const el = $(id); if (!el.value && v) el.value = v; };
  set('#h-title', d.drawing.project);
  const m = (d.drawing.clientNumber || '').match(/^(\d+-\d+)/);
  set('#h-number', m ? m[1] : '');
}

const rulesNow = () => ({ ...DEFAULT_RULES, direction: $('#direction').value });
const sheetsFor = () => state.drawings.map(d => {
  const src = state.sources.get(d.file);
  return {
    drawing: d, pageText: src?.pageText || '',
    getImages: async () => {
      const doc = await pdfjs.getDocument({ data: src.bytes.slice(), verbosity: 0 }).promise;
      const page = await doc.getPage(src.page);
      const r = await renderPageForAI(page, {
        area: d.page.area,
        makeCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
        mime: 'image/jpeg',   // much smaller than PNG; text stays sharp at this quality
        encode: async c => c.toDataURL('image/jpeg', 0.88).split(',')[1],
      });
      return r.images;
    },
  };
});

// For the targeted check: each sheet's words (with positions) and close-ups on demand
const pageCache = new Map();
const pageOf = async file => {
  if (!pageCache.has(file)) {
    const src = state.sources.get(file);
    pageCache.set(file, pdfjs.getDocument({ data: src.bytes.slice(), verbosity: 0 }).promise.then(doc => doc.getPage(src.page)));
  }
  return pageCache.get(file);
};
const closeUpSheets = () => state.drawings.map(d => ({
  drawing: d, texts: state.sources.get(d.file)?.texts || [],
  renderRegion: async region => renderRegion(await pageOf(d.file), region, {
    makeCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    encode: async c => c.toDataURL('image/jpeg', 0.9).split(',')[1],
  }),
}));
// a sheet with no text layer (scanned) can only be read whole by the AI
const anyScanned = () => state.drawings.some(d => (state.sources.get(d.file)?.texts.length || 0) < 10);
const runCheck = (provider, onProgress) => {
  const rules = rulesNow();
  const ruleRows = mergeDrawings(state.drawings, rules).rows;
  return anyScanned()
    ? crossCheck({ sheets: sheetsFor(), ruleRows, rules, provider, onProgress }).then(r => ({ ...r, mode: 'whole' }))
    : targetedCheck({ sheets: closeUpSheets(), drawings: state.drawings, ruleRows, rules, provider, onProgress }).then(r => ({ ...r, mode: 'targeted' }));
};

// Rebuild rows. If an AI check was run on exactly these drawings, re-apply its saved
// answers (no new AI requests), e.g. after the direction setting changes.
async function remerge() {
  const rules = rulesNow();
  const ruleRows = mergeDrawings(state.drawings, rules).rows;
  state.ruleRows = ruleRows;
  const files = state.drawings.map(d => d.file).sort().join('|');
  if (state.ai && state.ai.files === files) {
    const res = await runCheck(replayProvider(state.ai.store, state.ai.provider));
    state.rows = res.rows;
  } else {
    if (state.ai) { state.ai = null; showAI(); }
    state.rows = ruleRows;
  }
  render();
}

// ---------- AI cross-check ----------
function showAI() {
  const on = $('#ai-on').checked;
  $('#ai-panel').hidden = !on;
  const btn = $('#btn-ai');
  btn.disabled = !on || !state.drawings.length || !$('#ai-key').value.trim();
  const s = state.ai?.summary;
  // before running: say exactly what will be sent
  const plan = !s && state.ruleRows.length && !anyScanned() ? summarisePlan(planChecks(state.ruleRows)) : null;
  $('#ai-plan').innerHTML = plan ? `The AI will look at close-ups of <b>${plan.ai}</b> unsure reading${plan.ai === 1 ? '' : 's'} and <b>${plan.spot}</b> spot check${plan.spot === 1 ? '' : 's'} (${plan.requests} small request${plan.requests === 1 ? '' : 's'}). <b>${plan.none}</b> clear-cut readings are not sent. <b>${plan.person}</b> row${plan.person === 1 ? ' needs' : 's need'} a person (missing information or drawings that disagree), which the AI cannot settle.`
    : !s && anyScanned() ? 'A sheet has no text layer (scanned), so the AI will read the sheets whole. This is slower.' : '';
  const st = state.ai?.stats;
  $('#ai-result').innerHTML = s && state.ai.mode === 'targeted' ? `
    <span><b class="ok">${s.confirmed}</b> confirmed</span>
    <span><b class="warnc">${s.disputed}</b> disputed</span>
    ${s.filled ? `<span><b class="warnc">${s.filled}</b> filled in by AI</span>` : ''}
    ${s.unconfirmed ? `<span><b class="warnc">${s.unconfirmed}</b> partly confirmed</span>` : ''}
    <span><b class="warnc">${s.person}</b> need a person</span>
    <span><b>${s.notNeeded}</b> not needed</span>
    ${s.notChecked ? `<span><b class="badc">${s.notChecked}</b> not checked</span>` : ''}
    ${st ? `<span class="muted">${st.requests} request${st.requests === 1 ? '' : 's'} · ${st.seconds} s</span>` : ''}` : s ? `
    <span><b class="ok">${s.agreed}</b> agreed</span>
    <span><b class="warnc">${s.disputed}</b> disputed</span>
    ${s.unconfirmed ? `<span><b class="warnc">${s.unconfirmed}</b> partly confirmed</span>` : ''}
    ${s.aiOnly ? `<span><b class="warnc">${s.aiOnly}</b> found by AI only</span>` : ''}
    ${s.rulesOnly ? `<span><b class="warnc">${s.rulesOnly}</b> not reported by AI</span>` : ''}
    ${s.notChecked ? `<span><b class="badc">${s.notChecked}</b> not checked</span>` : ''}
    ${state.ai?.retryable ? `<button id="btn-ai-retry" class="ghost small" type="button">Retry what failed</button>` : ''}
    ${s ? `<span class="muted">${esc(state.ai.provider)} · ${esc(state.ai.model)}</span>` : ''}
    ${state.ai?.log.length ? `<details><summary>${state.ai.log.length} note${state.ai.log.length === 1 ? '' : 's'} from the check</summary><ul>${state.ai.log.map(l => `<li>${esc(l)}</li>`).join('')}</ul></details>` : ''}` : '';
}

// retry = only ask again for what failed last time (answers already received are re-used)
let aiRun = null;   // { stopped, started, timer, last }
async function runAI(retry = false) {
  const key = $('#ai-key').value.trim();
  if (!key) { status('Paste an AI key first.', 'bad'); return; }
  if ($('#ai-remember').checked) store.set('bcd-ai-key', key); else store.set('bcd-ai-key', null);
  const btn = $('#btn-ai'), stop = $('#btn-ai-stop');
  btn.disabled = true; btn.textContent = 'Checking…'; stop.hidden = false;
  // running timer next to the latest message, so it is always clear the check is alive
  aiRun = { stopped: false, started: Date.now(), last: 'Starting the AI check' };
  const clock = () => { const t = Math.round((Date.now() - aiRun.started) / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const say = m => { aiRun.last = m.replace(/…$/, ''); status(`${aiRun.last}… ${clock()}`); };
  aiRun.timer = setInterval(() => status(`${aiRun.last}… ${clock()}`), 1000);
  const files = state.drawings.map(d => d.file).sort().join('|');
  try {
    // close-ups are small, so the AI answers quickly: a short time limit per request
    // (Safari also drops requests that get no answer for about a minute)
    const live = geminiProvider({ apiKey: key, onWait: say, isStopped: () => aiRun.stopped, ...(anyScanned() ? {} : { timeoutMs: 50000, budgetMs: 150000, gapMs: 13000 }), ...(globalThis.BCD_AI_OPTIONS || {}) });
    const prov = retry && state.ai?.files === files ? resumeProvider(state.ai.store, live) : recordingProvider(live);
    const res = await runCheck(prov, say);
    const failed = res.log.filter(l => /failed|stopped/.test(l)).length;
    state.ai = { store: prov.store, model: res.model, provider: res.provider, summary: res.summary, log: res.log, raw: res.raw, files, retryable: failed > 0, mode: res.mode, stats: res.stats };
    state.rows = res.rows;
    render();
    const s = res.summary, took = clock();
    if (aiRun.stopped) status(`AI check stopped after ${took}. Rows it had not checked show "Not checked"; the rules engine's reading is unchanged. You can carry on with "Retry what failed".`, 'warn');
    else if (failed) status(`AI cross-check finished with problems after ${took}: ${s.notChecked ? `${s.notChecked} rows not checked` : 'some reviews failed'}. The rules engine's reading is unchanged for those rows. You can retry just what failed.`, 'warn');
    else if (res.mode === 'targeted') status(`AI check done in ${took}: ${s.confirmed} confirmed, ${s.disputed} disputed${s.filled ? `, ${s.filled} filled in` : ''}; ${s.person} row${s.person === 1 ? ' needs' : 's need'} a person. Check the amber rows.`, s.disputed || s.person ? 'warn' : 'good');
    else status(`AI cross-check done in ${took}: ${s.agreed} agreed, ${s.disputed} disputed. Check the amber rows.`, s.disputed ? 'warn' : 'good');
  } catch (e) {
    console.error(e);
    status(aiRun.stopped ? 'AI check stopped. The schedule shows the rules engine\'s reading.' :
      `AI cross-check could not run: ${e.message} The schedule still shows the rules engine's reading, and you can download it as normal.`, aiRun.stopped ? 'warn' : 'bad');
  } finally {
    clearInterval(aiRun.timer); aiRun.timer = null;
    btn.textContent = 'Run AI cross-check'; stop.hidden = true; stop.disabled = false;
    showAI();
  }
}

// ---------- rendering ----------
// only warn about missing client drawing numbers when some sheet refers to another by number
const usesDrawingNumbers = () => state.drawings.some(d => d.cables.some(c => c.ends.some(e => e.kind === 'offsheet' && e.drawing)));

function render() {
  const dl = $('#drawings');
  dl.innerHTML = state.drawings.length ? state.drawings.map((d, i) => `
    <li class="dwg">
      <div class="dwg-main">
        <strong>${esc(d.drawing.title || d.file)}</strong>
        <span class="mono">${esc(d.drawing.wbNumber || '—')}</span>
        <span class="mono muted">Client ${esc(d.drawing.clientNumber || '—')} · Rev ${esc(d.drawing.revision || '—')}</span>
        <span class="muted">${esc(d.panel ? fullName(d.panel.name) : 'No panel found')} · ${d.cables.length} cable label${d.cables.length === 1 ? '' : 's'}</span>
        ${[...d.warn, ...(!d.drawing.clientNumber && usesDrawingNumbers() ? ['Client drawing number not found, so "FROM/TO DRAWING" notes on other sheets cannot be linked to this one.'] : [])].map(w => `<span class="warn">${esc(w)}</span>`).join('')}
      </div>
      <button class="ghost small" data-remove="${i}" aria-label="Remove ${esc(d.file)}">Remove</button>
    </li>`).join('') : '<li class="empty">No drawings yet.</li>';

  const flagged = state.rows.filter(r => r.flags.length).length;
  $('#t-dwg').textContent = state.drawings.length;
  $('#t-rows').textContent = state.rows.length;
  $('#t-flag').textContent = flagged;
  $('#tile-flag').dataset.kind = flagged ? 'warn' : 'good';

  const rows = state.onlyFlagged ? state.rows.filter(r => r.flags.length) : state.rows;
  const withAI = !!state.ai;
  $('#thead').innerHTML = `<tr><th class="sev" aria-label="Status"></th>${withAI ? '<th>AI check</th>' : ''}${HEAD.map(h => `<th>${h}</th>`).join('')}<th>Sheets</th><th>Check</th></tr>`;
  $('#tbody').innerHTML = rows.length ? rows.map(r => {
    const i = state.rows.indexOf(r);
    const st = r.check?.status;
    const disputedCols = new Set();
    const picks = [];
    for (const [f, fld] of Object.entries(r.check?.fields || {})) {
      if (fld.status !== 'differ') continue;
      FIELD_COLS[f].forEach(c => disputedCols.add(c));
      const rv = fld.review;
      picks.push(`<div class="pick"><span class="pick-label">${FIELD_LABEL[f]}</span>
        <button class="opt${rv && (rv.choice === 'A' || rv.choice === 'both') ? ' rec' : ''}" data-i="${i}" data-f="${f}" data-v="rules">Rules: ${esc(fld.rules)}</button>
        <button class="opt${rv && rv.choice === 'B' ? ' rec' : ''}" data-i="${i}" data-f="${f}" data-v="ai">AI: ${esc(fld.ai)}</button>
        ${rv?.reason ? `<span class="why">AI review: ${esc(rv.reason)}</span>` : ''}</div>`);
    }
    const otherFlags = r.flags.filter(f => !/^AI (reads|review)/.test(f));
    if (r.check?.note && (st === 'disputed' || st === 'filled' || st === 'unconfirmed')) picks.push(`<span class="why">AI saw: ${esc(r.check.note)}</span>`);
    return `<tr class="${r.flags.length ? 'flagged' : ''}">
      <td class="sev"><span class="dot" title="${r.flags.length ? 'Needs checking' : 'OK'}"></span></td>
      ${withAI ? `<td><span class="badge" data-st="${st || 'none'}" title="${esc(STATUS[st]?.[1] || '')}">${esc(STATUS[st]?.[0] || '—')}</span></td>` : ''}
      ${EDITABLE.map(k => `<td contenteditable="true" spellcheck="false" data-i="${i}" data-k="${k}" class="${k === 'ref' || k === 'size' ? 'mono' : ''}${disputedCols.has(k) ? ' disputed' : ''}">${esc(r[k])}</td>`).join('')}
      <td class="sheets mono muted">${r.sheets.map(s => esc(s.replace(/^.*-W-/, 'W-'))).join('<br>')}</td>
      <td class="flags">${picks.join('')}${otherFlags.map(f => `<span class="chip">${esc(f)}</span>`).join('')}${(r.notes || []).map(n => `<span class="chip note">${esc(n)}</span>`).join('')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="${withAI ? 11 : 10}" class="empty">${state.rows.length ? 'No rows need checking.' : 'Drop BCD PDFs above to build the schedule.'}</td></tr>`;

  const ready = state.rows.length > 0;
  for (const b of document.querySelectorAll('[data-needs-rows]')) b.disabled = !ready;
  showAI();
}

// choose between the rules engine's and the AI's value for a disputed field
function pick(i, f, which) {
  const row = state.rows[i];
  const fld = row.check.fields[f];
  const src = which === 'ai' ? fld.ai : fld.rules;
  if (f === 'ends') {
    const [a, b] = src.split(' ↔ ');
    // keep the current direction if the chosen pair is the same two ends
    const cur = [row.source, row.destination];
    if (cur.includes(b) && cur.indexOf(b) === 0) { row.source = b; row.destination = a || ''; }
    else { row.source = a || ''; row.destination = b || ''; }
  } else {
    row[f] = src === '(not found)' ? '' : src;
    if (f === 'band') row.voltage = /B2/.test(row.band) ? (DEFAULT_RULES.bandVoltage['B2']) : row.band === 'B1' ? DEFAULT_RULES.bandVoltage['B1'] : row.voltage;
  }
  fld.status = 'resolved'; fld.chosen = which;
  const label = { ends: 'source / destination', type: 'cable type', size: 'cores & size', band: 'band' }[f];
  row.flags = row.flags.filter(x => !(/^AI (reads|review)/.test(x) && x.includes(label)));
  if (!Object.values(row.check.fields).some(x => x.status === 'differ')) {
    row.check.status = 'resolved';
    row.flags = row.flags.filter(x => !/^AI (reads|review)/.test(x));
  }
  render();
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
  const out = {
    generated: new Date().toISOString(), header: header(),
    drawings: state.drawings.map(d => ({ file: d.file, drawing: d.drawing, panel: d.panel, cables: d.cables })),
    ai: state.ai ? { provider: state.ai.provider, model: state.ai.model, mode: state.ai.mode, stats: state.ai.stats, summary: state.ai.summary, log: state.ai.log, savedAnswers: state.ai.store } : null,
    rows: state.rows,
  };
  saveFile(`${safeName(header().projectTitle)}_cables.json`, JSON.stringify(out, null, 2));
}
function exportReview() {
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['Cable ref', 'Source', 'Destination', 'AI check', 'Check'].map(q).join(',')];
  for (const r of state.rows) for (const f of r.flags) lines.push([r.ref, r.source, r.destination, STATUS[r.check?.status]?.[0] || '', f].map(q).join(','));
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
  state.template = await f.arrayBuffer();
  $('#tpl-name').textContent = f.name; e.target.value = '';
});
$('#direction').addEventListener('change', remerge);
$('#only-flagged').addEventListener('change', e => { state.onlyFlagged = e.target.checked; render(); });
$('#drawings').addEventListener('click', e => {
  const i = e.target.dataset.remove; if (i === undefined) return;
  const [d] = state.drawings.splice(+i, 1); state.sources.delete(d.file); pageCache.delete(d.file); remerge();
});
$('#tbody').addEventListener('input', e => {
  const td = e.target.closest('td[data-k]'); if (!td) return;
  state.rows[+td.dataset.i][td.dataset.k] = td.textContent.trim();
});
$('#tbody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('td[contenteditable]')) { e.preventDefault(); e.target.blur(); } });
$('#tbody').addEventListener('click', e => { const b = e.target.closest('button.opt'); if (b) pick(+b.dataset.i, b.dataset.f, b.dataset.v); });
$('#btn-xlsx').addEventListener('click', exportXlsx);
$('#btn-json').addEventListener('click', exportJson);
$('#btn-csv').addEventListener('click', exportReview);
$('#btn-clear').addEventListener('click', () => { state.drawings = []; state.rows = []; state.ruleRows = []; state.sources.clear(); pageCache.clear(); state.ai = null; render(); status('Cleared.'); });
$('#btn-ai').addEventListener('click', () => runAI(false));
$('#btn-ai-stop').addEventListener('click', () => { if (aiRun) { aiRun.stopped = true; aiRun.last = 'Stopping'; $('#btn-ai-stop').disabled = true; } });
$('#ai-result').addEventListener('click', e => { if (e.target.id === 'btn-ai-retry') runAI(true); });
$('#ai-on').addEventListener('change', () => { store.set('bcd-ai-on', $('#ai-on').checked ? '1' : null); showAI(); });
$('#ai-key').addEventListener('input', showAI);
$('#ai-remember').addEventListener('change', () => { if (!$('#ai-remember').checked) store.set('bcd-ai-key', null); else if ($('#ai-key').value.trim()) store.set('bcd-ai-key', $('#ai-key').value.trim()); });
$('#ai-key').addEventListener('change', () => { if ($('#ai-remember').checked && $('#ai-key').value.trim()) store.set('bcd-ai-key', $('#ai-key').value.trim()); });
$('#ai-auto').addEventListener('change', () => store.set('bcd-ai-auto', $('#ai-auto').checked ? null : 'off'));

// restore AI settings remembered in this browser
const savedKey = store.get('bcd-ai-key');
if (savedKey) { $('#ai-key').value = savedKey; $('#ai-remember').checked = true; }
if (store.get('bcd-ai-on')) $('#ai-on').checked = true;
if (store.get('bcd-ai-auto') === 'off') $('#ai-auto').checked = false;
render();
