// excel.js — Layer 3: write the merged rows into the company cable schedule template.
// Uses ExcelJS so the template's logo, merged header, borders and column widths are kept.

export const COLUMNS = ['ref', 'source', 'destination', 'type', 'size', 'voltage', 'band', 'length', 'cpc', 'install', 'comments'];
const FIRST_ROW = 6;            // first data row in the template
const SHEET = 'Cable Schedule'; // template sheet name

export async function buildWorkbook(ExcelJS, templateBuffer, header, rows) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuffer);
  const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];
  // remove any other sheets (the template carries an old scratch sheet)
  for (const other of [...wb.worksheets]) if (other.id !== ws.id) wb.removeWorksheet(other.id);

  // header block
  ws.getCell('I1').value = header.projectTitle || '';
  ws.getCell('I2').value = header.projectNumber || '';
  ws.getCell('I3').value = header.documentNumber || '';
  ws.getCell('I4').value = header.revision || '';
  ws.getCell('A3').value = header.projectTitle || '';

  // style template = first data row
  const proto = ws.getRow(FIRST_ROW);
  const styles = COLUMNS.map((_, i) => JSON.parse(JSON.stringify(proto.getCell(i + 1).style || {})));
  const height = proto.height;

  // clear existing data area
  for (let r = FIRST_ROW; r <= Math.max(ws.rowCount, FIRST_ROW + rows.length); r++)
    for (let c = 1; c <= COLUMNS.length; c++) ws.getRow(r).getCell(c).value = null;

  rows.forEach((row, i) => {
    const r = ws.getRow(FIRST_ROW + i);
    COLUMNS.forEach((k, c) => {
      const cell = r.getCell(c + 1);
      cell.value = row[k] === '' || row[k] == null ? null : row[k];
      cell.style = JSON.parse(JSON.stringify(styles[c]));
    });
    if (height) r.height = height;
  });

  const last = FIRST_ROW + Math.max(rows.length, 1) - 1;
  ws.pageSetup = { ...(ws.pageSetup || {}), printArea: `A1:K${last}` };
  return wb.xlsx.writeBuffer();
}
