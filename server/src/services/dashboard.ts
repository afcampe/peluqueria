import { DateTime } from 'luxon';
import { prisma } from '../lib/db.js';
import { emailConfigured } from '../notifications/email.js';
import { normalizePhone, waLink, whatsappApiConfigured } from '../notifications/whatsapp.js';
import { computeSlots } from './availability.js';
import { reminderChannels } from './reminders.js';
import { getSettings, type Settings } from './settings.js';

/** Resumen del administrador: el día, lo que hay que resolver y cómo va el negocio. */

const PAID = ['COMPLETED', 'PARTIALLY_REFUNDED'];
/** Citas que ocupan (u ocuparon) un sillón. */
const OCCUPIES = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'];
const isPaid = (a: { payments: { status: string }[] }) => a.payments.some((p) => PAID.includes(p.status));
const paidAt = (p: { capturedAt: Date | null; createdAt: Date }) => p.capturedAt ?? p.createdAt;

const include = {
  client: { select: { id: true, name: true, email: true, phone: true, status: true, remindEmail: true, remindWhatsapp: true } },
  service: { select: { id: true, name: true } },
  payments: { select: { status: true, provider: true } },
} as const;

type Appt = Awaited<ReturnType<typeof dayAppointments>>[number];
const dayAppointments = (from: Date, to: Date) =>
  prisma.appointment.findMany({ where: { startAt: { gte: from, lte: to }, status: { in: OCCUPIES } }, include, orderBy: { startAt: 'asc' } });

const brief = (a: Appt) => ({
  id: a.id, startAt: a.startAt, endAt: a.endAt, status: a.status, priceCents: a.priceCents, paymentMethod: a.paymentMethod,
  client: { id: a.client.id, name: a.client.name, email: a.client.email, phone: a.client.phone }, service: a.service.name, paid: isPaid(a),
});

export async function dashboard(now = new Date()) {
  const s = await getSettings();
  const local = DateTime.fromJSDate(now).setZone(s.timezone);
  const from = local.startOf('day');
  const to = local.endOf('day');
  const [appts, closures, todayPayments, monthPayments, clients, upcoming] = await Promise.all([
    dayAppointments(from.toJSDate(), to.toJSDate()),
    prisma.closure.findMany({ where: { startAt: { lt: to.toJSDate() }, endAt: { gt: from.toJSDate() } } }),
    paymentsBetween(from.toJSDate(), to.toJSDate()),
    paymentsBetween(local.startOf('month').toJSDate(), to.toJSDate()),
    prisma.user.count({ where: { role: 'CLIENT', status: { not: 'DELETED' } } }),
    prisma.appointment.count({ where: { status: 'CONFIRMED', startAt: { gte: now } } }),
  ]);
  const sum = (ps: { amountCents: number; refundedCents: number }[]) => ps.reduce((n, p) => n + p.amountCents - p.refundedCents, 0);

  // Los huecos del día, con quién los ocupa. Las citas que no encajan en la rejilla van aparte.
  const slots = computeSlots({ date: from.toISODate()!, settings: s, appointments: appts, closures, now });
  const shown = new Set<string>();
  const agenda = slots.map((sl) => {
    const a = appts.filter((x) => x.startAt.toISOString() < sl.end && sl.start < x.endAt.toISOString() && new Date(x.startAt) >= new Date(sl.start));
    a.forEach((x) => shown.add(x.id));
    const covered = appts.some((x) => x.startAt < new Date(sl.end) && new Date(sl.start) < x.endAt);
    const closed = closures.some((c) => c.startAt < new Date(sl.end) && new Date(sl.start) < c.endAt);
    const state = a.length || covered ? 'booked' : closed ? 'closed' : sl.reason === 'PAST' ? 'past' : 'free';
    return { start: sl.start, end: sl.end, state, bookable: sl.available, appts: a.map(brief) };
  });
  for (const a of appts) if (!shown.has(a.id)) agenda.push({ start: a.startAt.toISOString(), end: a.endAt.toISOString(), state: 'booked', bookable: false, appts: [brief(a)] });
  agenda.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));

  const active = appts.filter((a) => a.status !== 'NO_SHOW');
  const nextAppt = await prisma.appointment.findFirst({ where: { status: 'CONFIRMED', startAt: { gt: now } }, include, orderBy: { startAt: 'asc' } });
  return {
    now, today: from.toISODate(),
    next: nextAppt && { ...brief(nextAppt), isToday: nextAppt.startAt <= to.toJSDate(), whatsappLink: waLink(nextAppt.client.phone, `Hola ${nextAppt.client.name}, te escribimos de ${s.shopName} por tu cita del ${DateTime.fromJSDate(nextAppt.startAt).setZone(s.timezone).setLocale('es').toFormat("cccc d 'de' LLLL 'a las' HH:mm")}.`) },
    agenda,
    figures: {
      done: active.filter((a) => a.endAt <= now).length,
      pending: active.filter((a) => a.endAt > now).length,
      free: agenda.filter((x) => x.bookable).length,
      collectedCents: sum(todayPayments),
      /** Citas de hoy que aún no se han cobrado. */
      toCollectCents: active.filter((a) => !isPaid(a)).reduce((n, a) => n + a.priceCents, 0),
      monthCashCents: sum(monthPayments.filter((p) => p.provider === 'cash')),
      monthOnlineCents: sum(monthPayments.filter((p) => p.provider !== 'cash')),
      clients, upcoming,
    },
    todo: await pendingTasks(s, now),
  };
}

/** Cobros (netos de devoluciones) por la fecha en que se cobraron. */
async function paymentsBetween(from: Date, to: Date) {
  return prisma.payment.findMany({
    where: {
      status: { in: [...PAID, 'REFUNDED'] },
      OR: [{ capturedAt: { gte: from, lte: to } }, { capturedAt: null, createdAt: { gte: from, lte: to } }],
    },
    select: { provider: true, amountCents: true, refundedCents: true, capturedAt: true, createdAt: true },
  });
}

async function pendingTasks(s: Settings, now: Date) {
  const local = DateTime.fromJSDate(now).setZone(s.timezone);
  const tomorrow = local.plus({ days: 1 });
  const [past, cancelled, tomorrowAppts, failed, imports, soonBusy, closures] = await Promise.all([
    // Ya pasadas (60 días) sin cobrar ni marcar como ausencia.
    prisma.appointment.findMany({
      where: { status: { in: ['CONFIRMED', 'COMPLETED'] }, endAt: { lte: now }, startAt: { gte: local.minus({ days: 60 }).toJSDate() }, payments: { none: { status: { in: PAID } } } },
      include, orderBy: { startAt: 'desc' },
    }),
    // Canceladas en las últimas 48 h que dejan libre una hora de hoy o de mañana.
    prisma.appointment.findMany({
      where: { status: 'CANCELLED', cancelledBy: { in: ['CLIENT', 'ADMIN'] }, cancelledAt: { gte: local.minus({ hours: 48 }).toJSDate() }, startAt: { gt: now, lte: tomorrow.endOf('day').toJSDate() } },
      include, orderBy: { startAt: 'asc' },
    }),
    dayAppointments(tomorrow.startOf('day').toJSDate(), tomorrow.endOf('day').toJSDate()),
    prisma.appointmentReminder.findMany({
      where: { status: 'FAILED', createdAt: { gte: local.minus({ hours: 48 }).toJSDate() }, startAt: { gt: now }, appointment: { status: 'CONFIRMED' } },
      include: { appointment: { select: { startAt: true, client: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' },
    }),
    prisma.agendaImport.count({ where: { status: { in: ['READY', 'ERROR'] } } }),
    dayAppointments(now, tomorrow.endOf('day').toJSDate()),
    prisma.closure.findMany({ where: { startAt: { lt: tomorrow.endOf('day').toJSDate() }, endAt: { gt: now } } }),
  ]);

  const seen = new Set<number>();
  const freed = cancelled.filter((a) => {
    const t = a.startAt.getTime();
    if (seen.has(t) || closures.some((c) => c.startAt < a.endAt && a.startAt < c.endAt)) return false;
    if (soonBusy.filter((b) => b.startAt < a.endAt && a.startAt < b.endAt).length >= s.capacity) return false; // ya se ha vuelto a ocupar
    seen.add(t);
    return true;
  });

  // Solo si los recordatorios están activados: quién tiene cita mañana y no lo recibirá.
  const on = reminderChannels(s);
  const noReminder = on.email || on.whatsapp
    ? tomorrowAppts.filter((a) => a.status === 'CONFIRMED' && !(
        (on.email && a.client.remindEmail && a.client.email && emailConfigured()) ||
        (on.whatsapp && a.client.remindWhatsapp && normalizePhone(a.client.phone) && whatsappApiConfigured())))
    : [];
  const warnings: string[] = [];
  if (on.email && !emailConfigured()) warnings.push('Los recordatorios por email están activados, pero falta configurar el correo (SMTP): no se envían.');
  if (on.whatsapp && !whatsappApiConfigured()) warnings.push('Los recordatorios por WhatsApp están activados, pero falta configurar la API: no se envían.');

  return {
    unpaid: { count: past.length, totalCents: past.reduce((n, a) => n + a.priceCents, 0), items: past.slice(0, 5).map(brief) },
    freed: freed.map((a) => ({ ...brief(a), cancelledBy: a.cancelledBy })),
    noReminder: noReminder.map((a) => ({ ...brief(a), whatsappLink: waLink(a.client.phone, `Hola ${a.client.name}, te recordamos tu cita de mañana a las ${DateTime.fromJSDate(a.startAt).setZone(s.timezone).toFormat('HH:mm')} en ${s.shopName}.`) })),
    failedReminders: failed.map((f) => ({ id: f.id, channel: f.channel, detail: f.detail, startAt: f.appointment.startAt, client: f.appointment.client })),
    imports, warnings,
  };
}

// ---------------------------------------------------------------- Negocio

export type Period = '7d' | '30d' | '12m';

/** Ingresos por día o mes frente al periodo anterior, y ocupación por día y hora. */
export async function business(period: Period, now = new Date()) {
  const s = await getSettings();
  const local = DateTime.fromJSDate(now).setZone(s.timezone).setLocale('es');
  const months = period === '12m';
  const days = period === '7d' ? 7 : 30;
  const from = months ? local.startOf('month').minus({ months: 11 }) : local.startOf('day').minus({ days: days - 1 });
  const prevFrom = months ? from.minus({ years: 1 }) : from.minus({ days });
  const prevTo = months ? local.minus({ years: 1 }) : local.minus({ days });

  const [pays, prev, appts, closures] = await Promise.all([
    paymentsBetween(from.toJSDate(), now),
    paymentsBetween(prevFrom.toJSDate(), prevTo.toJSDate()),
    prisma.appointment.findMany({ where: { status: { in: OCCUPIES }, startAt: { gte: from.toJSDate(), lte: local.endOf('day').toJSDate() } }, select: { startAt: true, endAt: true } }),
    prisma.closure.findMany({ where: { startAt: { lt: local.endOf('day').toJSDate() }, endAt: { gt: from.toJSDate() } } }),
  ]);

  const keyOf = (d: Date) => DateTime.fromJSDate(d).setZone(s.timezone).toFormat(months ? 'yyyy-MM' : 'yyyy-MM-dd');
  const buckets = Array.from({ length: months ? 12 : days }, (_, i) => {
    const d = months ? from.plus({ months: i }) : from.plus({ days: i });
    return {
      key: d.toFormat(months ? 'yyyy-MM' : 'yyyy-MM-dd'),
      label: d.toFormat(months ? 'LLL' : days === 7 ? 'ccc d' : 'd LLL'),
      title: d.toFormat(months ? 'LLLL yyyy' : "cccc d 'de' LLLL"),
      cashCents: 0, onlineCents: 0,
    };
  });
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const p of pays) {
    const b = byKey.get(keyOf(paidAt(p)));
    if (b) b[p.provider === 'cash' ? 'cashCents' : 'onlineCents'] += p.amountCents - p.refundedCents;
  }
  const net = (ps: typeof pays) => ps.reduce((n, p) => n + p.amountCents - p.refundedCents, 0);

  // Ocupación: minutos con cita sobre minutos abiertos, por día de la semana y hora.
  const open = new Map<string, number>();
  const busy = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (let d = from; d <= local; d = d.plus({ days: 1 })) {
    for (const sl of computeSlots({ date: d.toISODate()!, settings: s, appointments: [], closures, now: d.startOf('day').minus({ minutes: 1 }).toJSDate() })) {
      if (!sl.available) continue; // cierre
      const start = DateTime.fromISO(sl.start).setZone(s.timezone);
      const k = `${start.weekday}-${start.hour}`;
      add(open, k, s.slotMinutes * s.capacity);
      const a0 = Date.parse(sl.start);
      const a1 = Date.parse(sl.end);
      let used = 0;
      for (const a of appts) used += Math.max(0, Math.min(a1, a.endAt.getTime()) - Math.max(a0, a.startAt.getTime())) / 60_000;
      add(busy, k, Math.min(used, s.slotMinutes * s.capacity));
    }
  }
  const hours = [...new Set([...open.keys()].map((k) => Number(k.split('-')[1])))].sort((a, b) => a - b);
  const weekdays = [...new Set([...open.keys()].map((k) => Number(k.split('-')[0])))].sort((a, b) => a - b);
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    period, buckets,
    totalCents: net(pays), cashCents: net(pays.filter((p) => p.provider === 'cash')), onlineCents: net(pays.filter((p) => p.provider !== 'cash')),
    /** null = no había cobros en el periodo anterior, así que no se compara. */
    previousCents: prev.length ? net(prev) : null,
    occupancy: {
      percent: total(open) ? Math.round((total(busy) / total(open)) * 100) : null,
      hours, weekdays,
      cells: weekdays.map((w) => hours.map((hr) => { const o = open.get(`${w}-${hr}`); return o ? Math.round(((busy.get(`${w}-${hr}`) ?? 0) / o) * 100) : null; })),
    },
  };
}

export function integrations(agendaReader: boolean, payments: { id: string; label: string; configured: boolean }[]) {
  return { agendaReader, email: emailConfigured(), whatsappApi: whatsappApiConfigured(), payments };
}
