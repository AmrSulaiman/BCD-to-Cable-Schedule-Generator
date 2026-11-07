// rules.js — company conventions. Edit this file to change how the schedule is written.

// Words kept in capitals when names are converted from "STORM RETURN PUMP NO.1" to "Storm Return Pump No.1"
export const ACRONYMS = ['JB', 'LCP', 'MCC', 'CSO', 'DT', 'DB', 'MDB', 'DNO', 'EDM', 'SPD', 'RCD', 'ISO', 'MCB', 'VSD', 'DOL',
  'UPS', 'PLC', 'HMI', 'LV', 'HV', 'PSU', 'DC', 'AC', 'T1', 'T2', 'T3', 'IO', 'I/O', 'RTU', 'CCTV', 'PIR', 'LED', 'MI', 'SWA', 'XLPE'];

// Abbreviations written out in full (whole name match, case-insensitive)
export const FULL_NAMES = {
  'EB': 'Earth Bar',
  'MDB': 'Main Distribution Board',
  'BS DB': 'Building Services Distribution Board',
  'BUILDING SERVICES DB': 'Building Services Distribution Board',
  'LIGHTS': 'Lights',
};

export function titleCase(s) {
  if (!s) return '';
  if (/[a-z]/.test(s)) return s.trim(); // already mixed case: keep as drawn
  const acr = new Set(ACRONYMS);
  return s.trim().split(/(\s+|(?=\()|(?<=\())/).map(w => {
    if (!w.trim()) return w;
    const bare = w.replace(/[()]/g, '');
    if (acr.has(bare)) return w;
    if (/^[A-Z]{1,3}\d+[A-Z]?\d*$/.test(bare)) return w;          // tags like P01, FS01, L05, T01
    if (/^NO\.?\d*$/.test(bare)) return w.replace(/^NO/, 'No');    // NO.1
    if (/\d/.test(bare) && !/^[A-Z]+$/.test(bare)) return w;       // mixed codes
    return w.charAt(0) + w.slice(1).toLowerCase();
  }).join('').replace(/\s+/g, ' ');
}

export function fullName(name) {
  const n = (name || '').replace(/\s+/g, ' ').trim();
  const hit = FULL_NAMES[n.toUpperCase()];
  return hit || titleCase(n);
}

// Voltage band -> voltage text. "B1&B2" counts as 400V.
export const BAND_VOLTAGE = { 'B1': '24V', 'B2': '400V', 'B1&B2': '400V' };
export function voltageForBand(band, rules = DEFAULT_RULES) {
  if (!band) return '';
  const b = band.replace(/\s+/g, '').toUpperCase();
  if (rules.bandVoltage[b]) return rules.bandVoltage[b];
  if (b.includes('B2')) return rules.bandVoltage['B2'];
  return '';
}

// "4c x 2.5mm²" -> "4c x 2.5mm2"; "5PR x 0.75" -> "5PR x 0.75mm2"; "3 x 1c x 10mm²" -> "3 x 1c x 10mm2"
export function normaliseSize(s) {
  let t = (s || '').replace(/×/g, 'x').replace(/\s+/g, ' ').trim();
  t = t.replace(/mm²/g, 'mm2');
  t = t.replace(/\s*x\s*/gi, ' x ');
  t = t.replace(/(\d)\s*(c|pr|g)\b/gi, (m, d, u) => d + (u.toLowerCase() === 'pr' ? 'PR' : u.toLowerCase() === 'g' ? 'G' : 'c'));
  if (/\d$/.test(t) && !/mm2$/.test(t)) t += 'mm2';
  t = t.replace(/(\d)\s*mm2/, '$1mm2');
  return t;
}

// Row order: numeric part of the ref, then prefix order, then -n suffix
const PREFIX_ORDER = ['L', 'CE', 'LC', 'E'];
function sortKey(ref) {
  const m = ref.match(/^([A-Z]+)\d{2}[A-Z]{2}([0-9X]+)(?:-(\d+))?/) || [];
  const num = parseInt((m[2] || '').replace(/X/g, '0'), 10) || 0;
  const p = PREFIX_ORDER.indexOf(m[1]);
  return [num, m[3] ? +m[3] : 0, p < 0 ? 99 : p];
}
export function sortRows(a, b) {
  const ka = sortKey(a.ref), kb = sortKey(b.ref);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.ref.localeCompare(b.ref);
}

export const DEFAULT_RULES = {
  fullName,
  // 'supply-first': Source = supplying end (panel/MDB/JB), Destination = load/field end
  // 'field-first' : Source = field end, Destination = panel (the reverse)
  direction: 'supply-first',
  bandVoltage: BAND_VOLTAGE,
  prefixBand: { L: 'B2', LC: 'B2', CE: 'B1' },
  sortRows,
};
