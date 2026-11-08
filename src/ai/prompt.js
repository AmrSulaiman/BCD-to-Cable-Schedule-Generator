// prompt.js — the fixed instructions and answer formats for the AI.
//
// Two jobs:
//   1. READ   (blind fill): given the drawing images and the list of cable references
//             the rules engine found, report each cable's ends, type, size and band.
//             The AI is NOT shown the rules engine's answers, so its reading is independent.
//   2. REVIEW (disputed rows only): given the drawing images and two candidate answers
//             for a field (A = rules engine, B = AI reading), say which matches the drawing.
//
// Change PROMPT_VERSION whenever the wording changes, so saved results can be told apart.

export const PROMPT_VERSION = 'read-v1';

export const READ_SYSTEM = `You are an experienced electrical engineer reading a block cable diagram (BCD) to produce a cable schedule. You read drawings carefully and literally, and you never guess.

HOW THESE DRAWINGS ARE LAID OUT
- A board schedule (header strip) runs across the top of the diagram. Its rows are titled REFERENCE (the board name, e.g. "Detention Tank LCP - Form 2a"), COMPARTMENT, TYPE/SIZE, WB REF, DESCRIPTION and TAG or WAY. Each column is one way of that board, and its DESCRIPTION says what it feeds (e.g. "STORM RETURN PUMP NO.1", "MAINS INCOMER").
- Each cable is a line. Beside the line is its label: a cable reference such as L25NA1001, usually followed by a voltage band in brackets, (B1), (B2) or (B1&B2). On the other side of the line is the cable specification, e.g. "4c x 2.5mm² XLPE/SWA BS5467": the cores and size ("4c x 2.5mm²") then the cable type ("XLPE/SWA BS5467").
- Some labels are horizontal and connect to their cable with a leader line ending in an arrow.
- A cable line that starts at the bottom of a header-strip column is connected to that board, at that way. A small controller box drawn directly under a column belongs to that board.
- Other ends are: rectangular boxes with text inside (JB P01, ISO T01, TELEMETRY OUTSTATION, CONTROLLER), equipment symbols with a name written below or beside them (STORM RETURN PUMP NO.1, SMOKE DETECTOR), notes such as "FROM DRAWING 80065564-01-WAB-42056-NA-DR-E-00005" or "TO DRAWING ..." that mean the cable continues on another sheet, or "FROM DNO".
- Vendor-supplied cables have references starting LC or ending -1 and may say "VENDOR CABLE" instead of a size.

YOUR TASK
For every cable reference in the list you are given, follow its line in both directions and report what is at each end, plus its cores and size, cable type and band.

RULES
- Copy text exactly as it appears on the drawing (spelling, capitals, mm², symbols).
- For an end:
  - board_way: name = the board name from the REFERENCE row; way = that column's DESCRIPTION.
  - box: name = all the text inside the box, e.g. "JB P01".
  - equipment: name = the label of the equipment, without power ratings like "5.5 kW".
  - other_drawing: name = the note as written; drawing_number = the full drawing number.
  - dno: for "FROM DNO" or similar.
  - unknown: when you cannot see where the line ends. Do not guess.
- The two ends may be given in either order.
- cores_size: only the cores and size text (e.g. "4c x 2.5mm²", "1PR x 0.75mm²", "3 x 1c x 10mm²"). For vendor cables with no size, use "VENDOR CABLE".
- cable_type: the rest of the specification (e.g. "XLPE/SWA BS5467", "6181-Y", "G&Y", "VENDOR CABLE", "SUBCAB").
- band: exactly "B1", "B2" or "B1&B2" as shown after the reference; empty string if none is shown.
- If you cannot read a value clearly, use "unknown" and set confidence to "low".
- Report each listed reference exactly once. Never invent a reference. If you see cable references on the sheet that are not in the list, put them only in other_refs_seen.

POSITIONS
Positions are given on a 0–1000 scale across the whole sheet: x from left to right, y from top to bottom. Each image states which part of the sheet it shows. Use the given label positions to find each cable.`;

export const READ_SYSTEM_NO_LIST = READ_SYSTEM.replace(
  'For every cable reference in the list you are given, follow its line',
  'This sheet has no readable text layer, so you are not given a list. Find every cable reference label on the sheet; for each one, follow its line',
).replace(
  '- Report each listed reference exactly once. Never invent a reference. If you see cable references on the sheet that are not in the list, put them only in other_refs_seen.',
  '- Report each cable reference you can read exactly once. Never invent a reference. Leave other_refs_seen empty.',
);

const END_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['board_way', 'box', 'equipment', 'other_drawing', 'dno', 'unknown'] },
    name: { type: 'string' },
    way: { type: 'string' },
    drawing_number: { type: 'string' },
  },
  required: ['kind', 'name'],
};

export const READ_SCHEMA = {
  type: 'object',
  properties: {
    board_name: { type: 'string', description: 'The board name in the REFERENCE row of the header strip, as written. Empty if none.' },
    cables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          end_a: END_SCHEMA,
          end_b: END_SCHEMA,
          cores_size: { type: 'string' },
          cable_type: { type: 'string' },
          band: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string', description: 'Anything unclear about this cable. Empty if nothing.' },
        },
        required: ['ref', 'end_a', 'end_b', 'cores_size', 'cable_type', 'band', 'confidence'],
      },
    },
    other_refs_seen: { type: 'array', items: { type: 'string' } },
  },
  required: ['board_name', 'cables', 'other_refs_seen'],
};

export function readUserText(sheet, refs) {
  const lines = [
    `Sheet: ${sheet.title || sheet.file}${sheet.wbNumber ? ` (${sheet.wbNumber})` : ''}${sheet.clientNumber ? `, client drawing ${sheet.clientNumber}` : ''}.`,
  ];
  if (refs.length) {
    lines.push('', 'Cable references on this sheet and where their labels are (x, y on the 0–1000 scale):');
    for (const r of refs) lines.push(`- ${r.ref} at (${r.at[0]}, ${r.at[1]})`);
  }
  lines.push('', 'The images follow: first an overview, then close-up tiles.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------- review
export const REVIEW_SYSTEM = `You are an experienced electrical engineer checking a cable schedule against its block cable diagram (BCD). Two readings of the same drawing disagree on some values. For each disputed value, look at the drawing and decide which reading matches it.

Read the drawing literally. A cable is a line with its reference label beside it and its specification (cores, size, type) on the other side. Follow the line to see what is at each end: a header-strip column (that board), a box (the text inside it), an equipment symbol (its name), or a FROM/TO DRAWING note (another sheet).

For each item answer:
- "A" if reading A matches the drawing,
- "B" if reading B matches the drawing,
- "both" if they say the same thing in different words,
- "neither" if neither matches, and give the correct value as written on the drawing,
- "unclear" if the drawing does not let you decide.
Give a one-sentence reason that points to what you see on the drawing. Never guess: use "unclear" when unsure.`;

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          choice: { type: 'string', enum: ['A', 'B', 'both', 'neither', 'unclear'] },
          value: { type: 'string', description: 'Only when choice is "neither": the correct value as written on the drawing.' },
          reason: { type: 'string' },
        },
        required: ['id', 'choice', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

export function reviewUserText(sheet, items) {
  const lines = [`Sheet: ${sheet.title || sheet.file}${sheet.wbNumber ? ` (${sheet.wbNumber})` : ''}.`, '', 'Disputed values:'];
  for (const it of items) {
    lines.push(`- id ${it.id}: cable ${it.ref} (label at ${it.at[0]}, ${it.at[1]}), ${it.label}.`);
    lines.push(`    A: ${it.a}`);
    lines.push(`    B: ${it.b}`);
  }
  lines.push('', 'The images follow: first an overview, then close-up tiles.');
  return lines.join('\n');
}
