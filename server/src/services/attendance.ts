import { createHmac, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { badRequest } from '../lib/errors.js';
import { normalizePhone, sendWhatsApp } from '../notifications/whatsapp.js';
import { getSettings } from './settings.js';

/**
 * Confirmación de asistencia. Al reservar, la cita queda "Reservada"; pasa a "Confirmada"
 * solo cuando el cliente dice que va: con el enlace del email, con los botones de WhatsApp
 * o por teléfono (lo apunta el administrador). Si dice que no, se avisa en el Resumen;
 * no se cancela sola, porque puede haber devoluciones o un cambio de hora.
 */
export type Answer = 'YES' | 'NO';
export type AnswerBy = 'EMAIL' | 'WHATSAPP' | 'ADMIN';

// ---------------------------------------------------------------- Enlaces y botones firmados

// Secreto distinto al de sesión: este código solo sirve para responder por una cita concreta.
const sign = (body: string) => createHmac('sha256', `${config.jwtSecret}:asistencia`).update(body).digest('base64url').slice(0, 22);

/** Código corto (cabe en un botón de WhatsApp) ligado a la cita y a su hora: si se cambia, deja de valer. */
export function attendanceToken(a: { id: string; startAt: Date }) {
  const body = `${a.id}.${Math.floor(a.startAt.getTime() / 1000).toString(36)}`;
  return `${body}.${sign(body)}`;
}

export function readToken(token: string) {
  const [id, t, sig, extra] = token.split('.');
  if (!id || !t || !sig || extra !== undefined) return null;
  const good = Buffer.from(sign(`${id}.${t}`));
  const got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return null;
  return { id, startAt: new Date(parseInt(t, 36) * 1000) };
}

export const attendanceUrl = (a: { id: string; startAt: Date }, answer: Answer) =>
  config.publicUrl ? `${config.publicUrl}/api/public/asistencia/${attendanceToken(a)}?r=${answer === 'YES' ? 'si' : 'no'}` : null;

/** Identificadores de los botones Sí / No de WhatsApp. */
export const buttonPayload = (a: { id: string; startAt: Date }, answer: Answer) => `ATT_${answer}_${attendanceToken(a)}`;

// ---------------------------------------------------------------- Respuestas

export type Outcome = { ok: true; answer: Answer } | { ok: false; reason: 'invalid' | 'changed' | 'inactive' | 'past' };

/** Cita a la que apunta un código, si todavía se puede responder. */
export async function loadByToken(token: string) {
  const t = readToken(token);
  if (!t) return { ok: false as const, reason: 'invalid' as const };
  const a = await prisma.appointment.findUnique({ where: { id: t.id }, include: { client: { select: { name: true, phone: true } }, service: { select: { name: true } } } });
  if (!a) return { ok: false as const, reason: 'invalid' as const };
  if (a.status !== 'CONFIRMED') return { ok: false as const, reason: 'inactive' as const };
  if (Math.floor(a.startAt.getTime() / 1000) !== Math.floor(t.startAt.getTime() / 1000)) return { ok: false as const, reason: 'changed' as const };
  if (a.startAt <= new Date()) return { ok: false as const, reason: 'past' as const };
  return { ok: true as const, appointment: a };
}

async function save(id: string, startAt: Date, answer: Answer | null, by: AnswerBy) {
  // Con la misma hora: si se movió entre medias, la respuesta ya no vale.
  const r = await prisma.appointment.updateMany({
    where: { id, startAt, status: 'CONFIRMED' },
    data: { attendance: answer, attendanceAt: answer ? new Date() : null, attendanceBy: answer ? by : null },
  });
  return r.count > 0;
}

/** Respuesta del cliente con un código firmado (enlace del email o botón de WhatsApp). */
export async function answerByToken(token: string, answer: Answer, by: AnswerBy): Promise<Outcome> {
  const r = await loadByToken(token);
  if (!r.ok) return r;
  return (await save(r.appointment.id, r.appointment.startAt, answer, by)) ? { ok: true, answer } : { ok: false, reason: 'changed' };
}

/** El administrador apunta lo que le ha dicho el cliente (o lo quita). */
export async function answerByAdmin(id: string, answer: Answer | null) {
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id } });
  if (a.status !== 'CONFIRMED') throw badRequest('Solo se confirma la asistencia de citas reservadas');
  if (a.endAt <= new Date()) throw badRequest('La cita ya ha terminado');
  await save(id, a.startAt, answer, 'ADMIN');
}

// ---------------------------------------------------------------- WhatsApp

interface WaMessage {
  from?: string; type?: string;
  button?: { payload?: string };
  interactive?: { button_reply?: { id?: string } };
  text?: { body?: string };
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const YES = ['si', 'si confirmo', 'confirmo', 'confirmado', 'si voy', 'si ire'];
const NO = ['no', 'no puedo', 'no voy', 'no puedo ir', 'no ire'];

/** Última cita próxima por la que se le ha preguntado por WhatsApp a ese teléfono (solo si no hay duda). */
async function askedAppointment(phone: string) {
  const asked = await prisma.appointmentReminder.findMany({
    where: { channel: 'WHATSAPP', status: 'SENT', startAt: { gt: new Date() }, appointment: { status: 'CONFIRMED' } },
    include: { appointment: { select: { id: true, startAt: true, client: { select: { phone: true } } } } },
  });
  const mine = new Map(asked.filter((r) => r.startAt.getTime() === r.appointment.startAt.getTime() && normalizePhone(r.appointment.client.phone) === phone).map((r) => [r.appointment.id, r.appointment]));
  return mine.size === 1 ? [...mine.values()][0] : null;
}

/** Procesa los mensajes recibidos de WhatsApp. Devuelve cuántas respuestas se han apuntado. */
export async function handleWhatsAppMessages(messages: WaMessage[]) {
  let saved = 0;
  for (const m of messages) {
    const phone = normalizePhone(m.from);
    if (!phone) continue;
    let token: string | null = null;
    let answer: Answer | null = null;
    const payload = m.type === 'button' ? m.button?.payload : m.type === 'interactive' ? m.interactive?.button_reply?.id : undefined;
    const match = payload?.match(/^ATT_(YES|NO)_(.+)$/);
    if (match) {
      answer = match[1] as Answer;
      token = match[2];
      // El botón tiene que pulsarlo el teléfono del cliente.
      const r = await loadByToken(token);
      if (r.ok && normalizePhone(r.appointment.client.phone) !== phone) continue;
    } else if (m.type === 'text' && m.text?.body) {
      const t = plain(m.text.body);
      answer = YES.includes(t) ? 'YES' : NO.includes(t) ? 'NO' : null;
      const a = answer && (await askedAppointment(phone));
      token = a ? attendanceToken(a) : null;
    }
    if (!token || !answer) continue;
    const out = await answerByToken(token, answer, 'WHATSAPP');
    if (out.ok) saved++;
    sendWhatsApp(phone, await replyText(token, out)).catch((e) => console.error('[whatsapp] no se pudo responder', (e as Error).message));
  }
  return saved;
}

async function replyText(token: string, out: Outcome) {
  const s = await getSettings();
  const call = s.shopPhone ? ` Si lo necesitas, llámanos al ${s.shopPhone}.` : '';
  if (!out.ok) return `Esta cita ya no está activa o ha cambiado de hora, así que no hemos podido apuntar tu respuesta.${call}`;
  if (out.answer === 'NO') return `Gracias por avisar. Hemos apuntado que no puedes venir y te contactaremos para cancelar o cambiar tu cita.${call}`;
  const t = readToken(token)!;
  return `¡Gracias! Tu cita del ${DateTime.fromJSDate(t.startAt).setZone(s.timezone).setLocale('es').toFormat("cccc d 'de' LLLL 'a las' HH:mm")} está confirmada. Te esperamos.`;
}
