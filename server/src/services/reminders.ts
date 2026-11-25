import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { emailConfigured, sendEmail } from '../notifications/email.js';
import { normalizePhone, sendWhatsApp, sendWhatsAppButtons, sendWhatsAppTemplate, whatsappApiConfigured } from '../notifications/whatsapp.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { attendanceUrl, buttonPayload } from './attendance.js';
import { getSettings, type Settings } from './settings.js';

/**
 * Recordatorios automáticos de las próximas citas (email y/o WhatsApp).
 * Se ejecuta cada minuto. Para cada cita confirmada busca la antelación
 * que ya ha llegado (la más cercana a la cita) y, si aún no se ha avisado
 * con ella, envía el aviso por cada canal activo. Cada envío queda
 * registrado, así que nunca se repite.
 */

interface ReminderAppt {
  startAt: Date;
  client: { name: string };
  service: { name: string };
}

/** Sustituye {nombre}, {fecha}, {hora}, {servicio}, {peluqueria}, {telefono} y {direccion}. */
export function renderReminder(text: string, a: ReminderAppt, s: Settings) {
  const vars = reminderVars(a, s);
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k as keyof typeof vars] : m));
}

export function reminderVars(a: ReminderAppt, s: Settings) {
  const start = DateTime.fromJSDate(a.startAt).setZone(s.timezone).setLocale('es');
  return {
    nombre: a.client.name.split(' ')[0] || a.client.name,
    fecha: start.toFormat("cccc d 'de' LLLL"),
    hora: start.toFormat('HH:mm'),
    servicio: a.service.name,
    peluqueria: s.shopName,
    telefono: s.shopPhone,
    direccion: s.shopAddress,
  };
}

/** Antelación con la que se registran los avisos enviados a mano (las automáticas son de 15 min o más). */
const MANUAL = 0;

/** Texto de la antelación: "1 día", "2 h", "30 min". */
export const offsetLabel = (m: number) =>
  m === MANUAL ? 'manual' : m % 1440 === 0 ? `${m / 1440} día${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} h` : `${m} min`;

type Channel = 'EMAIL' | 'WHATSAPP';

type Sendable = ReminderAppt & { id?: string; attendance?: string | null; client: { name: string; email: string | null; phone: string | null } };

/** Pregunta que acompaña al aviso: nada si no se pide confirmar o si ya ha respondido que sí. */
const asks = (a: Sendable, s: Settings) => s.reminders.askConfirmation && a.attendance !== 'YES';

/** Texto y enlaces que se añaden al email para confirmar la asistencia. */
function emailConfirm(a: Sendable, s: Settings) {
  if (!s.reminders.askConfirmation) return { text: '', actions: [] };
  if (a.attendance === 'YES') return { text: '\n\nYa has confirmado tu asistencia. ¡Gracias!', actions: [] };
  const yes = a.id ? attendanceUrl({ id: a.id, startAt: a.startAt }, 'YES') : null;
  const no = a.id ? attendanceUrl({ id: a.id, startAt: a.startAt }, 'NO') : null;
  if (!yes || !no) return { text: '', actions: [] }; // sin dirección pública (o en la prueba) no hay enlaces
  return { text: `\n\n${s.reminders.confirmQuestion}`, actions: [{ label: 'Sí, confirmo que voy', url: yes, primary: true }, { label: 'No puedo ir', url: no }] };
}

async function sendOne(channel: Channel, a: Sendable, s: Settings) {
  const r = s.reminders;
  if (channel === 'EMAIL') {
    if (!a.client.email) return { status: 'SKIPPED', detail: 'El cliente no tiene email' };
    const c = emailConfirm(a, s);
    await sendEmail(a.client.email, renderReminder(r.emailSubject, a, s), renderReminder(r.emailBody, a, s) + c.text, c.actions);
    return { status: 'SENT', detail: a.client.email };
  }
  if (!whatsappApiConfigured()) return { status: 'SKIPPED', detail: 'La API de WhatsApp no está configurada' };
  const phone = normalizePhone(a.client.phone);
  if (!phone) return { status: 'SKIPPED', detail: 'El cliente no tiene un teléfono válido' };
  const ref = a.id ? { id: a.id, startAt: a.startAt } : null;
  if (r.whatsappTemplate) {
    const v = reminderVars(a, s);
    // Si la plantilla lleva los botones Sí / No hay que mandar siempre sus identificadores.
    const buttons = r.askConfirmation ? (ref ? [buttonPayload(ref, 'YES'), buttonPayload(ref, 'NO')] : ['PRUEBA_SI', 'PRUEBA_NO']) : [];
    await sendWhatsAppTemplate(phone, r.whatsappTemplate, r.whatsappTemplateLang, [v.nombre, v.fecha, v.hora, v.servicio], buttons);
  } else if (asks(a, s)) {
    await sendWhatsAppButtons(phone, `${renderReminder(r.whatsappBody, a, s)}\n\n${r.confirmQuestion}`, [
      { id: ref ? buttonPayload(ref, 'YES') : 'PRUEBA_SI', title: 'Sí' }, { id: ref ? buttonPayload(ref, 'NO') : 'PRUEBA_NO', title: 'No' }]);
  } else {
    await sendWhatsApp(phone, renderReminder(r.whatsappBody, a, s));
  }
  return { status: 'SENT', detail: `+${phone}` };
}

let running = false;

export async function runReminders(now = new Date()) {
  if (running) return { sent: 0 };
  running = true;
  try {
    const s = await getSettings();
    const r = s.reminders;
    const channels: Channel[] = [...(r.email ? ['EMAIL' as const] : []), ...(r.whatsapp ? ['WHATSAPP' as const] : [])];
    if (!r.enabled || !channels.length || !r.offsetsMinutes.length) return { sent: 0 };
    const offsets = [...new Set(r.offsetsMinutes)].sort((x, y) => x - y);
    const maxOffset = offsets.at(-1)!;

    const appts = await prisma.appointment.findMany({
      where: { status: 'CONFIRMED', startAt: { gt: now, lte: new Date(now.getTime() + maxOffset * 60_000) } },
      include: {
        client: { select: { name: true, email: true, phone: true, status: true, remindEmail: true, remindWhatsapp: true } },
        service: { select: { name: true } },
        reminders: { select: { startAt: true, offsetMinutes: true } },
      },
    });

    let sent = 0;
    for (const a of appts) {
      if (a.client.status !== 'ACTIVE') continue;
      if (a.attendance === 'NO') continue; // ya ha dicho que no viene
      // Antelaciones que ya han llegado, sin contar las que vencieron antes de reservar
      // (para eso ya está el email de confirmación).
      const due = offsets.filter((o) => {
        const at = a.startAt.getTime() - o * 60_000;
        return at <= now.getTime() && a.createdAt.getTime() <= at;
      });
      if (!due.length) continue;
      const offset = due[0]; // la más cercana a la cita
      const already = a.reminders.some((x) => x.offsetMinutes === offset && x.startAt.getTime() === a.startAt.getTime());
      if (already) continue;

      // Solo los canales que el cliente tiene activados en su perfil.
      const wanted = channels.filter((c) => (c === 'EMAIL' ? a.client.remindEmail : a.client.remindWhatsapp));
      for (const channel of wanted) {
        let rec;
        try {
          // El registro se crea antes de enviar: si otro proceso ya lo tiene, no se duplica.
          rec = await prisma.appointmentReminder.create({ data: { appointmentId: a.id, startAt: a.startAt, offsetMinutes: offset, channel, status: 'SENDING' } });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
          throw e;
        }
        try {
          const res = await sendOne(channel, a, s);
          await prisma.appointmentReminder.update({ where: { id: rec.id }, data: res });
          if (res.status === 'SENT') sent++;
        } catch (e) {
          await prisma.appointmentReminder.update({ where: { id: rec.id }, data: { status: 'FAILED', detail: (e instanceof Error ? e.message : 'Error al enviar').slice(0, 300) } });
        }
      }
    }
    return { sent };
  } finally {
    running = false;
  }
}

/** Cita de la que se puede recordar: la indicada o la próxima confirmada del cliente. */
async function findRemindable(by: { appointmentId: string } | { clientId: string }) {
  const a = await prisma.appointment.findFirst({
    where: 'appointmentId' in by ? { id: by.appointmentId } : { clientId: by.clientId, status: 'CONFIRMED', startAt: { gt: new Date() } },
    orderBy: { startAt: 'asc' },
    include: { client: { select: { name: true, email: true, phone: true, status: true } }, service: { select: { name: true } } },
  });
  if (!a) throw badRequest('appointmentId' in by ? 'La cita no existe' : 'El cliente no tiene ninguna cita próxima confirmada');
  if (a.status !== 'CONFIRMED' || a.startAt <= new Date()) throw badRequest('Solo se puede recordar una cita confirmada que aún no ha pasado');
  if (a.client.status === 'DELETED') throw badRequest('El cliente está de baja');
  if (!a.client.email) throw badRequest('El cliente no tiene email');
  return { a, to: a.client.email };
}

/** Vista previa del recordatorio por email que el administrador va a enviar a mano. */
export async function previewEmailReminder(by: { appointmentId: string } | { clientId: string }) {
  const { a, to } = await findRemindable(by);
  const s = await getSettings();
  return {
    appointmentId: a.id, to, simulated: !emailConfigured(),
    subject: renderReminder(s.reminders.emailSubject, a, s), body: renderReminder(s.reminders.emailBody, a, s) + emailConfirm(a, s).text,
    actions: emailConfirm(a, s).actions.map((x) => x.label),
  };
}

/** Envía a mano el recordatorio por email. No afecta a los avisos automáticos. */
export async function sendEmailReminder(appointmentId: string) {
  const { a } = await findRemindable({ appointmentId });
  const s = await getSettings();
  const simulated = !emailConfigured();
  let res: { status: string; detail: string };
  try {
    res = await sendOne('EMAIL', a, s);
    if (simulated) res = { status: 'SKIPPED', detail: 'El SMTP no está configurado: el email no ha salido' };
  } catch (e) {
    res = { status: 'FAILED', detail: (e instanceof Error ? e.message : 'Error al enviar').slice(0, 300) };
  }
  // Un solo registro manual por cita, hora y canal: al repetirlo se actualiza.
  const key = { appointmentId: a.id, startAt: a.startAt, offsetMinutes: MANUAL, channel: 'EMAIL' };
  await prisma.appointmentReminder.upsert({
    where: { appointmentId_startAt_offsetMinutes_channel: key },
    create: { ...key, ...res }, update: { ...res, createdAt: new Date() },
  });
  if (res.status === 'FAILED') throw new HttpError(502, `No se pudo enviar el email: ${res.detail}`);
  return { to: a.client.email, simulated };
}

/** Últimos avisos para el panel. */
export async function recentReminders(limit = 30) {
  const rows = await prisma.appointmentReminder.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { appointment: { select: { id: true, startAt: true, client: { select: { id: true, name: true } } } } },
  });
  return rows.map((r) => ({ ...r, offsetLabel: offsetLabel(r.offsetMinutes) }));
}

/** Envío de prueba al propio administrador con una cita de ejemplo. */
export async function sendTestReminder(channel: Channel, to: { email?: string | null; phone?: string | null }, input?: Partial<Settings['reminders']>) {
  const base = await getSettings();
  const s = { ...base, reminders: { ...base.reminders, ...input } };
  const example = {
    startAt: DateTime.now().setZone(s.timezone).plus({ days: 1 }).set({ hour: 10, minute: 30, second: 0, millisecond: 0 }).toJSDate(),
    client: { name: 'Cliente de prueba', email: to.email ?? null, phone: to.phone ?? null },
    service: { name: 'Corte de pelo' },
  };
  const res = await sendOne(channel, example, s);
  if (res.status !== 'SENT') throw new Error(res.detail);
  return res;
}

// ---------------------------------------------------------------- Preferencias de cada cliente

/** Canales de recordatorio activados en Configuración. */
export const reminderChannels = (s: Settings) => ({
  email: s.reminders.enabled && s.reminders.email,
  whatsapp: s.reminders.enabled && s.reminders.whatsapp,
});

/** Valor inicial para un cliente nuevo: activado si el canal lo está en Configuración. */
export async function defaultReminderPrefs() {
  const c = reminderChannels(await getSettings());
  return { remindEmail: c.email, remindWhatsapp: c.whatsapp };
}

/** Un cliente no puede activar un canal que está desactivado en Configuración. */
export async function assertReminderPrefs(data: { remindEmail?: boolean; remindWhatsapp?: boolean }) {
  if (!data.remindEmail && !data.remindWhatsapp) return;
  const c = reminderChannels(await getSettings());
  if (data.remindEmail && !c.email) throw badRequest('Los recordatorios por email están desactivados en la configuración de la peluquería');
  if (data.remindWhatsapp && !c.whatsapp) throw badRequest('Los recordatorios por WhatsApp están desactivados en la configuración de la peluquería');
}

/**
 * Al cambiar los canales en Configuración se aplican a todos los clientes:
 * desactivar un canal lo apaga en todos los perfiles; volver a activarlo
 * lo enciende en todos (cada cliente puede quitarlo después).
 */
export async function syncReminderPrefs(before: Settings, after: Settings) {
  const a = reminderChannels(before);
  const b = reminderChannels(after);
  const changes: { remindEmail?: boolean; remindWhatsapp?: boolean } = {};
  if (a.email !== b.email) changes.remindEmail = b.email;
  if (a.whatsapp !== b.whatsapp) changes.remindWhatsapp = b.whatsapp;
  if (!Object.keys(changes).length) return 0;
  const r = await prisma.user.updateMany({ where: { role: 'CLIENT' }, data: changes });
  return r.count;
}
