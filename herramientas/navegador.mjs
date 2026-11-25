// Chrome sin ventana para probar la app de ejemplo y hacer capturas (sin dependencias).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const URL_APP = 'http://localhost:4557';
export const OUT = path.resolve(process.env.OUT ?? path.join(raiz, '.ejemplo/capturas'));
mkdirSync(OUT, { recursive: true });

/** Token de sesión de la app de ejemplo: 'admin' o un cliente ('javier0', 'carlos1'…). */
export async function entrar(quien = 'admin') {
  const body = quien === 'admin' ? { email: 'admin@peluqueriaarmando.es', password: 'admin1234' } : { email: `${quien}@example.com`, password: 'cliente1234' };
  const r = await fetch(`${URL_APP}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`No se pudo entrar como ${quien}: ${r.status}. ¿Está arrancada? (herramientas/app.sh start)`);
  return (await r.json()).token;
}

export async function browser({ width = 1280, height = 860, scale = 1.5, mobile = false } = {}) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), `cap-${port}`)}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 80)} → ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const api = {
    send, ev,
    async go(path, { token = '', theme = 'light', view = 'list' } = {}) {
      await send('Page.navigate', { url: 'http://localhost:4557/robots.txt' }); await sleep(300);
      await ev(`localStorage.setItem('pa_token',${JSON.stringify(token)});localStorage.setItem('pa_theme','${theme}');localStorage.setItem('pa_agenda_view','${view}');return 1`);
      await send('Page.navigate', { url: 'http://localhost:4557' + path }); await sleep(2000);
    },
    /** Pulsa el primer elemento que coincide con el selector (y, si se da, contiene el texto). */
    async click(sel, text, wait = 700) {
      await ev(`const els=[...document.querySelectorAll(${JSON.stringify(sel)})]; const t=${JSON.stringify(text ?? null)};
        const el=els.find(e=>t===null||e.textContent.trim().includes(t)); if(!el) throw new Error('no encontrado: '+${JSON.stringify(sel)}+' '+t); el.scrollIntoView({block:'center'}); el.click(); return true;`);
      await sleep(wait);
    },
    async type(sel, value, wait = 300) {
      await ev(`const el=document.querySelector(${JSON.stringify(sel)}); const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true;`);
      await sleep(wait);
    },
    async scroll(y) { await ev(`window.scrollTo(0, ${y}); return 1`); await sleep(300); },
    /** Captura: toda la ventana, la página entera (full) o recortada a un elemento (el). */
    async shot(name, { el, pad = 12, full = false, nth = 0 } = {}) {
      let clip;
      if (el) {
        const r = await ev(`const e=[...document.querySelectorAll(${JSON.stringify(el)})][${nth}]; if(!e) throw new Error('sin elemento ${el}'); const b=e.getBoundingClientRect();
          return {x:b.left+scrollX, y:b.top+scrollY, w:b.width, h:b.height, W:document.documentElement.scrollWidth}`);
        const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
        clip = { x, y, width: Math.min(r.w + pad * 2, r.W - x), height: r.h + pad * 2, scale: 1 };
      }
      const res = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82, captureBeyondViewport: !!(el || full), ...(clip && { clip }) });
      if (!res.result) throw new Error(`captura ${name}: ${JSON.stringify(res.error)}`);
      writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(res.result.data, 'base64'));
      console.log('✓', name);
    },
    async close() { ws.close(); chrome.kill(); },
  };
  return api;
}
