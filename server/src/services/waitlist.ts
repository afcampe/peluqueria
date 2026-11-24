import { DateTime } from 'luxon';
import { prisma } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emailConfigured, sendEmailSafe } from '../notifications/email.js';
import { waLink } from '../notifications/whatsapp.js';
import { availabilityForDate } from './appointments.js';
import { localDate } from './availability.js';
import { getSettings, type Settings } from './settings.js';

/**
 * Lista de espera: clientes que quieren hora un día que está completo (todo el día,
 * la mañana o la tarde). Cuando se libera una hora, se ve en el Resumen y, si está
 * activado en Configuración, se les avisa por email (una vez por cada vez que se libera).
 */
export type Part = 'ANY' | 'MORNING' | 'AFTERNOON';
const partText: Record<Part, string> = { ANY: '', MORNING: ' por la mañana', AFTERNOON: ' por la tarde' };
const NOON = 14;

const include = { client: { select: { id: true, name: true, email: true, phone: true, status: true } } } as const;

async function freeSlots(date: string, part: Part, tz: string) {
  const hour = (iso: string) => DateTime.fromISO(iso).setZone(tz).hour;
  return (await availabilityForDate(date))
    .filter((s) => s.available && (part === 'ANY' || (part === 'MORNING' ? hour(s.start) < NOON : hour(s.start) >= NOON)))
    .map((s) => s.start);
}

const hasAppointment = async (clientId: string, date: string, tz: string) => {
  const day = DateTime.fromISO(date, { zone: tz });
  return (await prisma.appointment.count({ where: { clientId, status: { in: ['CONFIRMED', 'COMPLETED', 'PENDING_PAYMENT'] }, startAt: { gte: day.startOf('day').toJSDate(), lte: day.endOf('day').toJSDate() } } })) > 0;
};

const todayOf = (s: Settings, now = new Date()) => localDate(now, s.timezone);

export async function addToWaitlist(input: { clientId: string; date: string; part: Part; notes?: string; createdBy?: string }) {
  const s = await getSettings();
  const client = await prisma.user.findUnique({ where: { id: input.clientId } });
  if (!client || client.status === 'DELETED' || client.role !== 'CLIENT') throw notFound('Cliente no encontrado');
  if (input.date < todayOf(s)) throw badRequest('Ese día ya ha pasado');
  if (await hasAppointment(input.clientId, input.date, s.timezone)) throw conflict('Ya tiene cita ese día');
  const slots = await availabilityForDate(input.date);
  if (!slots.some((x) => x.reason === 'BOOKED')) throw badRequest('Ese día está cerrado o no tiene horas ocupadas');
  if ((await freeSlots(input.date, input.part, s.timezone)).length) throw badRequest('Todavía quedan horas libres: puedes reservarle directamente');
  if (await prisma.waitlistEntry.count({ where: { clientId: input.clientId, date: input.date, status: 'WAITING' } })) throw conflict('Ya está en la lista de espera de ese día');
  return prisma.waitlistEntry.create({ data: { clientId: input.clientId, date: input.date, part: input.part, notes: input.notes, createdBy: input.createdBy }, include });
}

export async function removeFromWaitlist(id: string) {
  await prisma.waitlistEntry.update({ where: { id }, data: { status: 'CANCELLED' } });
}

/** Quien ya tiene cita ese día sale de la lista; los días pasados caducan. */
async function refresh(s: Settings, now: Date) {
  const today = todayOf(s, now);
  await prisma.waitlistEntry.updateMany({ where: { status: 'WAITING', OR: [{ date: { lt: today } }, { client: { status: 'DELETED' } }] }, data: { status: 'EXPIRED' } });
  const waiting = await prisma.waitlistEntry.findMany({ where: { status: 'WAITING' }, include, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] });
  const out = [];
  for (const w of waiting) {
    if (await hasAppointment(w.clientId, w.date, s.timezone)) await prisma.waitlistEntry.update({ where: { id: w.id }, data: { status: 'BOOKED' } });
    else out.push(w);
  }
  return out;
}

export async function listWaitlist(now = new Date(), clientId?: string) {
  const s = await getSettings();
  const list = (await refresh(s, now)).filter((w) => !clientId || w.clientId === clientId);
  return Promise.all(list.map(async (w) => {
    const free = await freeSlots(w.date, w.part as Part, s.timezone);
    const when = DateTime.fromISO(w.date, { zone: s.timezone }).setLocale('es').toFormat("cccc d 'de' LLLL");
    return {
      id: w.id, date: w.date, part: w.part as Part, notes: w.notes, createdAt: w.createdAt, notifiedAt: w.notifiedAt, client: w.client, free,
      whatsappLink: free.length ? waLink(w.client.phone, `Hola ${w.client.name.split(' ')[0]}, se ha liberado una hora en ${s.shopName} el ${when} a las ${DateTime.fromISO(free[0]).setZone(s.timezone).toFormat('HH:mm')}. ¿Te la reservamos?`) : null,
    };
  }));
}

/** Cada minuto: avisa por email a quien espera cuando su día pasa de completo a tener hueco. */
export async function runWaitlist(now = new Date(), canEmail = emailConfigured()) {
  const s = await getSettings();
  let notified = 0;
  for (const w of await refresh(s, now)) {
    const free = await freeSlots(w.date, w.part as Part, s.timezone);
    if (!free.length) {
      // Se ha vuelto a llenar: si se libera otra vez, se avisará de nuevo.
      if (w.notifiedAt) await prisma.waitlistEntry.update({ where: { id: w.id }, data: { notifiedAt: null } });
      continue;
    }
    if (w.notifiedAt || !canEmail || !s.waitlistEmail || !w.client.email || w.client.status !== 'ACTIVE') continue;
    // Se marca antes de enviar para no repetir el aviso.
    const mine = await prisma.waitlistEntry.updateMany({ where: { id: w.id, notifiedAt: null, status: 'WAITING' }, data: { notifiedAt: now } });
    if (!mine.count) continue;
    const when = DateTime.fromISO(w.date, { zone: s.timezone }).setLocale('es').toFormat("cccc d 'de' LLLL");
    const times = free.slice(0, 5).map((f) => DateTime.fromISO(f).setZone(s.timezone).toFormat('HH:mm')).join(', ');
    sendEmailSafe(w.client.email, 'Se ha liberado una hora', `Hola ${w.client.name},\n\nEstabas en la lista de espera de ${s.shopName} para el ${when}${partText[w.part as Part]} y se ha liberado: ${times}.\n\nLa hora no está reservada: se asigna por orden de llegada. Resérvala desde la app${s.shopPhone ? ` o llámanos al ${s.shopPhone}` : ''}.`);
    notified++;
  }
  return notified;
}
