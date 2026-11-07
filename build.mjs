// build.mjs — produce the single-file web page.
//   node build.mjs            -> docs/index.html  (the public page, served by GitHub Pages)
//   node build.mjs --local    -> dist/local-test.html             (libraries from node_modules, for offline testing)
import { build } from 'esbuild';
import fs from 'fs';

const local = process.argv.includes('--local');
const PDFJS_VERSION = '4.10.38', EXCELJS_VERSION = '4.4.0';
const urls = local ? {
  PDFJS_URL: '../node_modules/pdfjs-dist/legacy/build/pdf.min.mjs',
  PDFJS_WORKER_URL: '../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  EXCELJS_URL: '../node_modules/exceljs/dist/exceljs.min.js',
} : {
  PDFJS_URL: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`,
  PDFJS_WORKER_URL: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`,
  EXCELJS_URL: `https://cdnjs.cloudflare.com/ajax/libs/exceljs/${EXCELJS_VERSION}/exceljs.min.js`,
};

const res = await build({
  entryPoints: ['src/app.js'], bundle: true, format: 'esm', write: false, minify: false,
  external: [urls.PDFJS_URL, 'PDFJS_URL'],
  plugins: [{ name: 'urls', setup(b) {
    b.onLoad({ filter: /app\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8').replace(/PDFJS_WORKER_URL|PDFJS_URL/g, k => urls[k]), loader: 'js' }));
    b.onResolve({ filter: /^(https?:|\.\.\/node_modules)/ }, args => ({ path: args.path, external: true }));
  } }],
});
const app = res.outputFiles[0].text;
const tpl = fs.readFileSync(process.argv.find(a => a.endsWith('.xlsx')) || 'template/Cable_Schedule_Template.xlsx').toString('base64');
let html = fs.readFileSync('src/index.html', 'utf8')
  .replace('EXCELJS_URL', urls.EXCELJS_URL)
  .replace('TEMPLATE_B64', tpl)
  .replace('APP_JS', () => app);
fs.mkdirSync('dist', { recursive: true }); fs.mkdirSync('docs', { recursive: true });
const out = local ? 'dist/local-test.html' : 'docs/index.html';
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
