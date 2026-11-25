// Captura rápida. Uso:
//   node herramientas/captura.mjs <ruta> <nombre> [--de admin|javier0] [--el '.selector'] [--n 0] [--movil] [--oscuro] [--entera] [--alto 900] [--clic 'selector|texto'] [--vista list|week|month]
// Guarda en .ejemplo/capturas/<nombre>.jpg y avisa si la página se sale por los lados.
import { browser, entrar, OUT } from './navegador.mjs';
const [ruta, nombre, ...r] = process.argv.slice(2);
if (!ruta || !nombre) { console.error('Uso: captura.mjs <ruta> <nombre> [opciones]'); process.exit(1); }
const o = { clic: [] };
for (let i = 0; i < r.length; i++) {
  const k = r[i].replace(/^--/, '');
  if (['movil', 'oscuro', 'entera'].includes(k)) o[k] = true;
  else if (k === 'clic') o.clic.push(r[++i]);
  else o[k] = r[++i];
}
const b = await browser(o.movil ? { width: 390, height: Number(o.alto ?? 844), scale: 1.5, mobile: true } : { width: 1280, height: Number(o.alto ?? 900), scale: 1.2 });
try {
  await b.go(ruta, { token: o.de === 'nadie' ? '' : await entrar(o.de ?? 'admin'), theme: o.oscuro ? 'dark' : 'light', view: o.vista ?? 'list' });
  for (const c of o.clic) { const [sel, texto] = c.split('|'); await b.click(sel, texto, 900); }
  await b.shot(nombre, { el: o.el, nth: Number(o.n ?? 0), pad: 6, full: o.entera });
  const [w, v] = await b.ev('return [document.documentElement.scrollWidth, innerWidth]');
  console.log(`${OUT}/${nombre}.jpg`, w > v ? `¡se sale por los lados! (${w} > ${v})` : 'ancho correcto');
} finally { await b.close(); }
