import ExcelJS from 'exceljs';
import fs from 'fs';
import { buildWorkbook } from '../src/excel.js';
const out = JSON.parse(fs.readFileSync('test/out.json'));
const buf = await buildWorkbook(ExcelJS, fs.readFileSync('template/Cable_Schedule_Template.xlsx'),
  { projectTitle: 'Gaskell St CSO', projectNumber: '80065564-01', documentNumber: '80065564-01-WAB-42056-NA-SC-E-00003', revision: 'CR.C01' }, out.rows);
fs.writeFileSync('test/output_schedule.xlsx', Buffer.from(buf));
console.log('written', buf.byteLength);
