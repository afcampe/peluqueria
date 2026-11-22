// Genera los PDF de los manuales a partir de los HTML de esta carpeta con Chrome (sin dependencias).
// Uso: node docs/manuales/fuente/generar-pdf.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const manuals = [
  ['manual-cliente.html', 'Manual-cliente-Peluqueria-Armando.pdf', 'Manual del cliente'],
  ['manual-administrador.html', 'Manual-administrador-Peluqueria-Armando.pdf', 'Manual del administrador'],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9800 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(path.join(os.tmpdir(), 'manuales-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let targets;
for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');

const only = process.argv[2];
try {
  for (const [html, pdf, title] of manuals) {
    if (only && !html.includes(only)) continue;
    await send('Page.navigate', { url: 'file://' + path.join(here, html) });
    await sleep(2500);
    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>1)', awaitPromise: true });
    const foot = (side) => `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7.5px;color:#8a8a8a;padding:0 17mm;display:flex;justify-content:space-between">
      <span>Peluquería Armando · ${title}</span><span>${side}</span></div>`;
    const r = await send('Page.printToPDF', {
      printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>', footerTemplate: foot('<span class="pageNumber"></span> / <span class="totalPages"></span>'),
      generateDocumentOutline: true, generateTaggedPDF: true,
    });
    if (!r.result) throw new Error(JSON.stringify(r.error));
    writeFileSync(path.join(here, '..', pdf), Buffer.from(r.result.data, 'base64'));
    console.log('✓', pdf);
  }
} finally { ws.close(); chrome.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); }
