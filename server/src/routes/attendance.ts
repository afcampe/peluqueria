import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { answerByToken, handleWhatsAppMessages, loadByToken, type Answer } from '../services/attendance.js';
import { getSettings, type Settings } from '../services/settings.js';
import { h } from './util.js';

// ---------------------------------------------------------------- Enlace del email

/**
 * Página sencilla para confirmar la asistencia sin iniciar sesión. Abrir el enlace no
 * cambia nada (los filtros de correo abren los enlaces solos): hay que pulsar el botón.
 */
export const attendanceRouter = Router();
attendanceRouter.use(express.urlencoded({ extended: false, limit: '2kb' }));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (s: Settings, title: string, body: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)} · ${esc(s.shopName)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f4f2;color:#121212;font:17px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;padding:16px;box-sizing:border-box}
main{background:#fff;border:1px solid #e3e1de;border-top:4px solid #a9813f;border-radius:8px;max-width:460px;width:100%;padding:28px;box-sizing:border-box}
small{color:#8a6a33;text-transform:uppercase;letter-spacing:.08em;font-weight:600}h1{font-size:1.45rem;line-height:1.25;margin:.4rem 0 .8rem}.when{background:#f5f4f2;border-radius:6px;padding:14px 16px;margin:0 0 18px}.when b{display:block;font-size:1.1rem}
form{display:grid;gap:10px}button{font:inherit;font-weight:600;padding:14px;border-radius:6px;border:1px solid #121212;cursor:pointer;background:#fff;color:#121212}button.yes{background:#121212;color:#fff}p{margin:0 0 14px}p.muted{color:#6b6b6b;font-size:.9rem;margin:16px 0 0}a{color:inherit}
</style></head><body><main><small>${esc(s.shopName)}</small>${body}</main></body></html>`;

const why = {
  invalid: 'Este enlace no es válido. Comprueba que lo has copiado entero.',
  changed: 'Esta cita ha cambiado de hora. Usa el enlace del último aviso que hayas recibido.',
  inactive: 'Esta cita ya no está activa.',
  past: 'Esta cita ya ha empezado o ha pasado.',
};
const contact = (s: Settings) => (s.shopPhone ? `<p class="muted">¿Necesitas algo? Llámanos al <a href="tel:${esc(s.shopPhone)}">${esc(s.shopPhone)}</a>.</p>` : '');

attendanceRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  next();
});

attendanceRouter.get('/:token', h(async (req, res) => {
  const s = await getSettings();
  const r = await loadByToken(req.params.token);
  if (!r.ok) return void res.status(r.reason === 'invalid' ? 404 : 410).send(page(s, 'Asistencia', `<h1>No se puede responder</h1><p>${why[r.reason]}</p>${contact(s)}`));
  const a = r.appointment;
  const when = DateTime.fromJSDate(a.startAt).setZone(s.timezone).setLocale('es');
  const done = a.attendance === 'YES' ? '<p>Ya has confirmado tu asistencia. Puedes cambiar la respuesta.</p>' : a.attendance === 'NO' ? '<p>Nos dijiste que no puedes venir. Puedes cambiar la respuesta.</p>' : '';
  const yes = '<button class="yes" name="r" value="si">Sí, confirmo que voy</button>';
  const no = '<button name="r" value="no">No puedo ir</button>';
  res.send(page(s, 'Confirmar asistencia', `<h1>${esc(s.reminders.confirmQuestion)}</h1>
<p class="when"><b>${esc(when.toFormat("cccc d 'de' LLLL"))}, ${when.toFormat('HH:mm')}</b>${esc(a.service.name)} · ${esc(a.client.name)}</p>${done}
<form method="post">${req.query.r === 'no' ? no + yes : yes + no}</form>${contact(s)}`));
}));

attendanceRouter.post('/:token', h(async (req, res) => {
  const s = await getSettings();
  const answer: Answer | null = req.body?.r === 'si' ? 'YES' : req.body?.r === 'no' ? 'NO' : null;
  if (!answer) return void res.status(400).send(page(s, 'Asistencia', '<h1>Elige una respuesta</h1>'));
  const r = await answerByToken(req.params.token, answer, 'EMAIL');
  if (!r.ok) return void res.status(r.reason === 'invalid' ? 404 : 410).send(page(s, 'Asistencia', `<h1>No se puede responder</h1><p>${why[r.reason]}</p>${contact(s)}`));
  res.send(page(s, 'Gracias', answer === 'YES'
    ? `<h1>¡Gracias! Tu cita está confirmada</h1><p>Te esperamos${s.shopAddress ? ` en ${esc(s.shopAddress)}` : ''}.</p>${contact(s)}`
    : `<h1>Gracias por avisar</h1><p>Hemos apuntado que no puedes venir. La cita todavía no está cancelada: puedes cancelarla o cambiarla desde la app, o esperar a que te contactemos.</p>${contact(s)}`));
}));

// ---------------------------------------------------------------- Webhook de WhatsApp (Meta)

export const whatsappWebhook = Router();

/** Meta comprueba la dirección al configurarla. */
whatsappWebhook.get('/', (req, res) => {
  const q = req.query;
  if (config.whatsapp.verifyToken && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.whatsapp.verifyToken) return void res.type('text/plain').send(String(q['hub.challenge'] ?? ''));
  res.sendStatus(403);
});

whatsappWebhook.post('/', express.raw({ type: '*/*', limit: '1mb' }), h(async (req, res) => {
  // Sin el secreto de la app no se puede comprobar quién llama: no se acepta nada.
  if (!config.whatsapp.appSecret) return void res.sendStatus(503);
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const want = Buffer.from(`sha256=${createHmac('sha256', config.whatsapp.appSecret).update(body).digest('hex')}`);
  const got = Buffer.from(String(req.headers['x-hub-signature-256'] ?? ''));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return void res.sendStatus(401);
  let data: { entry?: { changes?: { value?: { metadata?: { phone_number_id?: string }; messages?: never[] } }[] }[] };
  try { data = JSON.parse(body.toString('utf8')); } catch { return void res.sendStatus(400); }
  const messages = (data.entry ?? []).flatMap((e) => e.changes ?? [])
    .filter((c) => !config.whatsapp.phoneNumberId || c.value?.metadata?.phone_number_id === config.whatsapp.phoneNumberId)
    .flatMap((c) => c.value?.messages ?? []);
  await handleWhatsAppMessages(messages);
  res.sendStatus(200);
}));
