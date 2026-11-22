import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requireAdmin, requireAuth } from '../lib/auth.js';
import { avatarData, avatarField } from '../lib/avatar.js';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { mergeClient } from '../services/agendaImport.js';
import { recentReminders, sendTestReminder } from '../services/reminders.js';
import { remindersSchema } from '../services/settings.js';
import { badRequest, conflict } from '../lib/errors.js';
import { emailConfigured, sendEmail } from '../notifications/email.js';
import { sendWhatsApp, waLink, whatsappApiConfigured } from '../notifications/whatsapp.js';
import { allProviders } from '../payments/registry.js';
import { availabilityForDate, cancelAppointment, cancelSeries, createAppointment, createSeries, isPaidWithTicket, previewSeries, refundCashPayment, refundOnlineAppointment, refundPayment, rescheduleAppointment, withRelations } from '../services/appointments.js';
import { seriesCreateSchema, seriesPreviewSchema } from './appointments.js';
import { getSettings, saveSettings } from '../services/settings.js';
import { issueTicket } from '../services/tickets.js';
import { actor, h, publicUser } from './util.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const ADMIN = (req: Parameters<typeof actor>[0]) => ({ ...actor(req), role: 'ADMIN' as const });

/** Convierte "YYYY-MM-DD" o "YYYY-MM-DDTHH:mm" (hora local de la peluquería) a Date. */
const localToDate = (s: string, tz: string, endOfDay = false) => {
  const dt = DateTime.fromISO(s, { zone: tz });
  if (!dt.isValid) throw badRequest(`Fecha no válida: ${s}`);
  return (s.length === 10 && endOfDay ? dt.endOf('day') : dt).toJSDate();
};

// ---------------------------------------------------------------- Resumen
adminRouter.get('/dashboard', h(async (_req, res) => {
  const s = await getSettings();
  const now = DateTime.now().setZone(s.timezone);
  const [today, upcoming, monthPayments, clients] = await Promise.all([
    prisma.appointment.count({ where: { status: 'CONFIRMED', startAt: { gte: now.startOf('day').toJSDate(), lte: now.endOf('day').toJSDate() } } }),
    prisma.appointment.count({ where: { status: 'CONFIRMED', startAt: { gte: now.toJSDate() } } }),
    prisma.payment.findMany({ where: { status: { in: ['COMPLETED', 'PARTIALLY_REFUNDED'] }, createdAt: { gte: now.startOf('month').toJSDate() } } }),
    prisma.user.count({ where: { role: 'CLIENT', status: { not: 'DELETED' } } }),
  ]);
  res.json({
    today,
    upcoming,
    clients,
    onlineRevenueMonthCents: monthPayments.filter((p) => p.provider !== 'cash').reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0),
    cashRevenueMonthCents: monthPayments.filter((p) => p.provider === 'cash').reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0),
    integrations: { agendaReader: config.anthropicConfigured, email: emailConfigured(), whatsappApi: whatsappApiConfigured(), payments: allProviders().map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured() })) },
  });
}));

// ---------------------------------------------------------------- Citas
adminRouter.get('/appointments', h(async (req, res) => {
  const s = await getSettings();
  const q = z.object({ from: z.string().optional(), to: z.string().optional(), status: z.string().optional(), clientId: z.string().optional() }).parse(req.query);
  const where: Prisma.AppointmentWhereInput = {
    NOT: { status: 'CANCELLED', cancelledBy: 'SYSTEM' },
    ...(q.status && { status: q.status }),
    ...(q.clientId && { clientId: q.clientId }),
    startAt: {
      ...(q.from && { gte: localToDate(q.from, s.timezone) }),
      ...(q.to && { lte: localToDate(q.to, s.timezone, true) }),
    },
  };
  res.json(await prisma.appointment.findMany({ where, include: withRelations, orderBy: { startAt: 'asc' }, take: 3000 }));
}));

adminRouter.post('/appointments', h(async (req, res) => {
  const data = z.object({
    clientId: z.string(), serviceId: z.string(), startAt: z.string(),
    paymentMethod: z.string().default('cash'), notes: z.string().max(500).optional(),
  }).parse(req.body);
  res.status(201).json(await createAppointment(ADMIN(req), data));
}));

adminRouter.post('/appointments/series/preview', h(async (req, res) => {
  res.json(await previewSeries(seriesPreviewSchema.parse(req.body), true));
}));

// Disponibilidad con el nombre del cliente que ocupa cada hora.
adminRouter.get('/availability', h(async (req, res) => {
  const { date, excludeId } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), excludeId: z.string().optional() }).parse(req.query);
  res.json(await availabilityForDate(date, excludeId, true));
}));

/** Registra que una cita en efectivo se ha cobrado en el local (y, si se pide, emite su ticket). */
adminRouter.post('/appointments/:id/mark-paid', h(async (req, res) => {
  const { ticket } = z.object({ ticket: z.boolean().default(false) }).parse(req.body ?? {});
  const s = await getSettings();
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id }, include: { payments: true } });
  if (a.paymentMethod !== 'cash') throw badRequest('Solo se marcan como cobradas las citas que se pagan en el local');
  if (a.status === 'CANCELLED') throw badRequest('La cita está cancelada');
  let cash = a.payments.find((p) => p.provider === 'cash' && p.status === 'COMPLETED');
  if (!cash) {
    cash = await prisma.payment.create({ data: { appointmentId: a.id, provider: 'cash', amountCents: a.priceCents, currency: s.currency, status: 'COMPLETED' } });
  }
  if (ticket && !cash.ticketId) await issueTicket([cash.id], 'SHOP');
  res.json(await prisma.appointment.findUniqueOrThrow({ where: { id: a.id }, include: withRelations }));
}));

adminRouter.post('/appointments/:id/unmark-paid', h(async (req, res) => {
  const ticketed = await prisma.payment.findFirst({ where: { appointmentId: req.params.id, provider: 'cash', ticketId: { not: null } }, include: { ticket: true } });
  if (ticketed) throw conflict(`El cobro ya tiene el ticket ${ticketed.ticket!.number} y no se puede deshacer (la numeración debe ser consecutiva).`, 'TICKET_EXISTS');
  await prisma.payment.deleteMany({ where: { appointmentId: req.params.id, provider: 'cash', refundedCents: 0 } });
  res.json(await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id }, include: withRelations }));
}));

/** Emite el ticket de una cita ya cobrada (en el local u online) que aún no lo tenga. */
adminRouter.post('/appointments/:id/ticket', h(async (req, res) => {
  const a = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id }, include: { payments: true } });
  const paid = a.payments.find((p) => p.status === 'COMPLETED');
  if (!paid) throw badRequest('La cita no está cobrada. Márcala como cobrada antes de emitir el ticket.');
  if (paid.ticketId) throw conflict('Esta cita ya tiene ticket', 'TICKET_EXISTS');
  // Si el cobro online cubría varias citas (serie), el ticket las incluye todas.
  const group = paid.providerOrderId
    ? await prisma.payment.findMany({ where: { providerOrderId: paid.providerOrderId, status: 'COMPLETED', ticketId: null }, select: { id: true } })
    : [paid];
  await issueTicket(group.map((p) => p.id), paid.provider === 'cash' ? 'SHOP' : 'ONLINE');
  res.json(await prisma.appointment.findUniqueOrThrow({ where: { id: a.id }, include: withRelations }));
}));

adminRouter.post('/appointments/series', h(async (req, res) => {
  const data = seriesCreateSchema.extend({ clientId: z.string(), paymentMethod: z.string().default('cash') }).parse(req.body);
  res.status(201).json(await createSeries(ADMIN(req), data));
}));

adminRouter.post('/series/:id/cancel', h(async (req, res) => {
  const opts = z.object({
    fromAppointmentId: z.string().optional(), reason: z.string().max(300).optional(),
    refund: z.boolean().default(true), notify: z.boolean().default(true),
  }).parse(req.body ?? {});
  res.json(await cancelSeries(ADMIN(req), req.params.id, opts));
}));

adminRouter.patch('/appointments/:id', h(async (req, res) => {
  const data = z.object({
    startAt: z.string().optional(), serviceId: z.string().optional(), notes: z.string().max(500).optional(),
    status: z.enum(['COMPLETED', 'NO_SHOW', 'CONFIRMED']).optional(),
  }).parse(req.body);
  if (data.startAt) await rescheduleAppointment(ADMIN(req), req.params.id, { startAt: data.startAt, serviceId: data.serviceId, notes: data.notes });
  else if (data.notes !== undefined) await prisma.appointment.update({ where: { id: req.params.id }, data: { notes: data.notes } });
  if (data.status) {
    const a = await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id } });
    if (a.status === 'CANCELLED' || a.status === 'PENDING_PAYMENT') throw badRequest('No se puede cambiar el estado de esta cita');
    await prisma.appointment.update({ where: { id: a.id }, data: { status: data.status } });
  }
  res.json(await prisma.appointment.findUniqueOrThrow({ where: { id: req.params.id }, include: withRelations }));
}));

adminRouter.post('/appointments/:id/cancel', h(async (req, res) => {
  const opts = z.object({ reason: z.string().max(300).optional(), refund: z.boolean().default(true), notify: z.boolean().default(true) }).parse(req.body ?? {});
  res.json(await cancelAppointment(ADMIN(req), req.params.id, opts));
}));

/** Reembolso de un cobro en efectivo (se devuelve en mano). La cita queda pendiente de cobro. */
adminRouter.post('/appointments/:id/refund-cash', h(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(255).optional() }).parse(req.body ?? {});
  res.json(await refundCashPayment(req.params.id, { reason }));
}));

/** Reembolso de un pago online (PayPal), con o sin anular la cita. */
adminRouter.post('/appointments/:id/refund', h(async (req, res) => {
  const opts = z.object({
    amountCents: z.number().int().positive().optional(), reason: z.string().max(255).optional(),
    cancel: z.boolean().default(true), notify: z.boolean().default(true),
  }).parse(req.body ?? {});
  res.json(await refundOnlineAppointment(ADMIN(req), req.params.id, opts));
}));

adminRouter.post('/payments/:id/refund', h(async (req, res) => {
  const { amountCents, reason } = z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().max(255).optional() }).parse(req.body ?? {});
  res.json(await refundPayment(req.params.id, { amountCents, reason, requestedBy: 'ADMIN' }));
}));

// ---------------------------------------------------------------- Usuarios
adminRouter.get('/users', h(async (req, res) => {
  const { q, status, role } = z.object({ q: z.string().optional(), status: z.string().optional(), role: z.string().optional() }).parse(req.query);
  const users = await prisma.user.findMany({
    where: {
      ...(status ? { status } : { status: { not: 'DELETED' } }),
      ...(role && { role }),
      ...(q && { OR: [{ name: { contains: q } }, { email: { contains: q } }, { phone: { contains: q } }] }),
    },
    orderBy: { name: 'asc' },
    take: 500,
  });
  res.json(users.map((u) => ({ ...publicUser(u), whatsappLink: waLink(u.phone) })));
}));

const userSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().optional(),
  role: z.enum(['CLIENT', 'ADMIN']).default('CLIENT'),
  password: z.string().min(8),
  acceptsEmail: z.boolean().default(true),
  avatar: avatarField,
});

adminRouter.get('/users/:id', h(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.params.id } });
  res.json({ ...publicUser(u), whatsappLink: waLink(u.phone) });
}));

adminRouter.post('/users', h(async (req, res) => {
  const { password, avatar, ...data } = userSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing && existing.status !== 'DELETED') throw conflict('Ya existe un usuario con ese email');
  const fields = { ...data, status: 'ACTIVE', blockedUntil: null, blockReason: null, passwordHash: await bcrypt.hash(password, 10), ...avatarData(avatar) };
  // Si estaba dado de baja se reactiva la misma cuenta (conserva su historial).
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: fields })
    : await prisma.user.create({ data: fields });
  res.status(201).json(publicUser(user));
}));

adminRouter.patch('/users/:id', h(async (req, res) => {
  const { password, avatar, ...data } = userSchema.partial().parse(req.body);
  if (req.params.id === req.user!.id && data.role === 'CLIENT') throw badRequest('No puedes quitarte tu propio rol de administrador');
  if (data.email) {
    const other = await prisma.user.findUnique({ where: { email: data.email } });
    if (other && other.id !== req.params.id) throw conflict('Ya existe un usuario con ese email');
  }
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { ...data, ...avatarData(avatar), ...(password && { passwordHash: await bcrypt.hash(password, 10) }) },
  });
  res.json(publicUser(user));
}));

/** Une una ficha sin cuenta (importada de la agenda en papel) con un cliente registrado. */
adminRouter.post('/users/:id/merge', h(async (req, res) => {
  const { targetId } = z.object({ targetId: z.string() }).parse(req.body);
  res.json(await mergeClient(req.params.id, targetId));
}));

/** Cancela (con reembolso) las citas futuras de un usuario. */
async function cancelFutureOf(req: Parameters<typeof actor>[0], userId: string, reason: string) {
  const future = await prisma.appointment.findMany({ where: { clientId: userId, status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] }, startAt: { gt: new Date() } } });
  return cancelMany(req, future.map((a) => a.id), reason);
}

/** Cancela varias citas con reembolso. Las cobradas en efectivo con ticket se dejan (hay que reembolsarlas antes). */
async function cancelMany(req: Parameters<typeof actor>[0], ids: string[], reason: string) {
  let cancelled = 0;
  let skippedPaid = 0;
  for (const id of ids) {
    try {
      await cancelAppointment(ADMIN(req), id, { reason, refund: true });
      cancelled++;
    } catch (e) {
      if (!isPaidWithTicket(e)) throw e;
      skippedPaid++;
    }
  }
  return { cancelled, skippedPaid };
}

adminRouter.post('/users/:id/block', h(async (req, res) => {
  const s = await getSettings();
  const { until, reason, cancelFuture } = z.object({
    until: z.string().optional(), // fecha local; vacío = indefinido
    reason: z.string().max(300).optional(),
    cancelFuture: z.boolean().default(false),
  }).parse(req.body ?? {});
  if (req.params.id === req.user!.id) throw badRequest('No puedes bloquearte a ti mismo');
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { status: 'BLOCKED', blockedUntil: until ? localToDate(until, s.timezone, true) : null, blockReason: reason },
  });
  const r = cancelFuture ? await cancelFutureOf(req, user.id, 'Cuenta bloqueada') : { cancelled: 0, skippedPaid: 0 };
  res.json({ user: publicUser(user), ...r });
}));

adminRouter.post('/users/:id/unblock', h(async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: 'ACTIVE', blockedUntil: null, blockReason: null } });
  res.json(publicUser(user));
}));

// Baja: se conserva el historial (citas y pagos) pero la cuenta deja de funcionar.
adminRouter.delete('/users/:id', h(async (req, res) => {
  if (req.params.id === req.user!.id) throw badRequest('No puedes darte de baja a ti mismo');
  const r = await cancelFutureOf(req, req.params.id, 'Baja del cliente');
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: 'DELETED', acceptsEmail: false } });
  res.json({ user: publicUser(user), ...r });
}));

// ---------------------------------------------------------------- Anulaciones y ausencias
/**
 * Histórico por cliente de citas anuladas (por el cliente o por la peluquería) y de
 * ausencias ("no vino"). Las citas nunca se borran; no cuentan los pagos online caducados.
 */
adminRouter.get('/reports/incidents', h(async (req, res) => {
  const s = await getSettings();
  const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
  const startAt = { ...(q.from && { gte: localToDate(q.from, s.timezone) }), ...(q.to && { lte: localToDate(q.to, s.timezone, true) }) };
  const rows = await prisma.appointment.groupBy({
    by: ['clientId', 'status', 'cancelledBy'],
    where: { startAt, NOT: { status: 'CANCELLED', cancelledBy: 'SYSTEM' } },
    _count: { _all: true },
    _max: { startAt: true },
  });
  type Row = { total: number; cancelledByClient: number; cancelledByShop: number; noShow: number; lastIncidentAt: Date | null };
  const per = new Map<string, Row>();
  for (const r of rows) {
    const x = per.get(r.clientId) ?? { total: 0, cancelledByClient: 0, cancelledByShop: 0, noShow: 0, lastIncidentAt: null };
    const n = r._count._all;
    x.total += n;
    const incident = r.status === 'NO_SHOW' || r.status === 'CANCELLED';
    if (r.status === 'NO_SHOW') x.noShow += n;
    if (r.status === 'CANCELLED') r.cancelledBy === 'CLIENT' ? (x.cancelledByClient += n) : (x.cancelledByShop += n);
    if (incident && r._max.startAt && (!x.lastIncidentAt || r._max.startAt > x.lastIncidentAt)) x.lastIncidentAt = r._max.startAt;
    per.set(r.clientId, x);
  }
  const ids = [...per].filter(([, x]) => x.noShow + x.cancelledByClient + x.cancelledByShop > 0).map(([id]) => id);
  const users = await prisma.user.findMany({ where: { id: { in: ids } } });
  res.json(
    users
      .map((u) => ({ client: publicUser(u), ...per.get(u.id)! }))
      .sort((a, b) => b.noShow + b.cancelledByClient - (a.noShow + a.cancelledByClient) || b.cancelledByShop - a.cancelledByShop),
  );
}));

// ---------------------------------------------------------------- Cierres temporales
adminRouter.get('/closures', h(async (_req, res) => {
  res.json(await prisma.closure.findMany({ where: { endAt: { gte: new Date() } }, orderBy: { startAt: 'asc' } }));
}));

adminRouter.post('/closures', h(async (req, res) => {
  const s = await getSettings();
  const data = z.object({
    start: z.string(), end: z.string(), reason: z.string().max(300).optional(),
    cancelAppointments: z.boolean().default(false),
  }).parse(req.body);
  const startAt = localToDate(data.start, s.timezone);
  const endAt = localToDate(data.end, s.timezone, true);
  if (endAt <= startAt) throw badRequest('La fecha de fin debe ser posterior a la de inicio');
  const closure = await prisma.closure.create({ data: { startAt, endAt, reason: data.reason } });

  const affected = await prisma.appointment.findMany({
    where: { status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] }, startAt: { lt: endAt }, endAt: { gt: startAt } },
    include: { client: { select: { name: true, email: true, phone: true } } },
  });
  let result = { cancelled: 0, skippedPaid: 0 };
  if (data.cancelAppointments) {
    const reason = data.reason ? `Cierre de la peluquería: ${data.reason}` : 'Cierre de la peluquería';
    result = await cancelMany(req, affected.map((a) => a.id), reason);
  }
  res.status(201).json({ closure, affected: affected.length, ...result });
}));

adminRouter.delete('/closures/:id', h(async (req, res) => {
  await prisma.closure.delete({ where: { id: req.params.id } });
  res.status(204).end();
}));

// ---------------------------------------------------------------- Configuración y servicios
// ---------------------------------------------------------------- Recordatorios
adminRouter.get('/reminders', h(async (_req, res) => { res.json(await recentReminders(40)); }));

/** Manda un recordatorio de ejemplo al propio administrador (email) o al teléfono indicado. */
adminRouter.post('/reminders/test', h(async (req, res) => {
  const { channel, phone, reminders } = z.object({
    channel: z.enum(['EMAIL', 'WHATSAPP']), phone: z.string().optional(), reminders: remindersSchema.partial().optional(),
  }).parse(req.body);
  const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  try {
    res.json(await sendTestReminder(channel, { email: me.email, phone: phone || me.phone }, reminders));
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : 'No se pudo enviar');
  }
}));

adminRouter.get('/settings', h(async (_req, res) => {
  res.json({
    settings: await getSettings(),
    providers: allProviders().map((p) => ({ id: p.id, label: p.label, online: p.online, configured: p.isConfigured() })),
    channels: { email: emailConfigured(), whatsappApi: whatsappApiConfigured() },
  });
}));

adminRouter.put('/settings', h(async (req, res) => {
  res.json(await saveSettings(req.body));
}));

const serviceSchema = z.object({
  name: z.string().trim().min(1),
  priceCents: z.number().int().min(0),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

adminRouter.get('/services', h(async (_req, res) => {
  res.json(await prisma.service.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
}));
adminRouter.post('/services', h(async (req, res) => {
  res.status(201).json(await prisma.service.create({ data: serviceSchema.parse(req.body) }));
}));
adminRouter.patch('/services/:id', h(async (req, res) => {
  res.json(await prisma.service.update({ where: { id: req.params.id }, data: serviceSchema.partial().parse(req.body) }));
}));

// ---------------------------------------------------------------- Avisos por email
const audienceSchema = z.object({
  audience: z.enum(['all', 'selected', 'date']),
  userIds: z.array(z.string()).optional(),
  date: z.string().optional(), // clientes con cita ese día
});

async function resolveAudience(a: z.infer<typeof audienceSchema>, requireEmailConsent: boolean) {
  const s = await getSettings();
  const base: Prisma.UserWhereInput = { status: { not: 'DELETED' }, role: 'CLIENT', email: { not: null }, ...(requireEmailConsent && { acceptsEmail: true }) };
  if (a.audience === 'selected') {
    if (!a.userIds?.length) throw badRequest('Selecciona al menos un cliente');
    // Seleccionados a mano: se respeta la baja pero no hace falta consentimiento de marketing.
    return prisma.user.findMany({ where: { id: { in: a.userIds }, status: { not: 'DELETED' } } });
  }
  if (a.audience === 'date') {
    if (!a.date) throw badRequest('Indica la fecha');
    const from = localToDate(a.date, s.timezone);
    const to = localToDate(a.date, s.timezone, true);
    return prisma.user.findMany({
      where: { status: { not: 'DELETED' }, appointments: { some: { status: 'CONFIRMED', startAt: { gte: from, lte: to } } } },
    });
  }
  return prisma.user.findMany({ where: base });
}

adminRouter.post('/messages/email/preview', h(async (req, res) => {
  const users = await resolveAudience(audienceSchema.parse(req.body), true);
  res.json({ count: users.filter((u) => u.email).length });
}));

adminRouter.post('/messages/email', h(async (req, res) => {
  const data = audienceSchema.extend({ subject: z.string().trim().min(1), body: z.string().trim().min(1) }).parse(req.body);
  const users = await resolveAudience(data, true);
  let sent = 0;
  const failed: string[] = [];
  for (const u of users) {
    if (!u.email) continue; // fichas sin cuenta (sin email)
    try {
      await sendEmail(u.email, data.subject, data.body.replaceAll('{nombre}', u.name));
      sent++;
    } catch {
      failed.push(u.email);
    }
  }
  await prisma.messageLog.create({ data: { channel: 'EMAIL', subject: data.subject, body: data.body, recipients: sent, sentBy: req.user!.id } });
  res.json({ sent, failed, simulated: !emailConfigured() });
}));

// ---------------------------------------------------------------- WhatsApp
adminRouter.get('/whatsapp/status', h(async (_req, res) => {
  res.json({ apiConfigured: whatsappApiConfigured() });
}));

/** Devuelve enlaces wa.me personalizados (funciona siempre, sin API). */
adminRouter.post('/whatsapp/links', h(async (req, res) => {
  const data = audienceSchema.extend({ body: z.string().default('') }).parse(req.body);
  const users = await resolveAudience(data, false);
  res.json(users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, link: waLink(u.phone, data.body.replaceAll('{nombre}', u.name)) })));
}));

/** Envío automático mediante WhatsApp Cloud API (requiere configuración). */
adminRouter.post('/whatsapp/send', h(async (req, res) => {
  const data = audienceSchema.extend({ body: z.string().trim().min(1) }).parse(req.body);
  const users = await resolveAudience(data, false);
  let sent = 0;
  const failed: { name: string; error: string }[] = [];
  for (const u of users) {
    try {
      if (!u.phone) throw new Error('Sin teléfono');
      await sendWhatsApp(u.phone, data.body.replaceAll('{nombre}', u.name));
      sent++;
    } catch (e) {
      failed.push({ name: u.name, error: (e as Error).message });
    }
  }
  await prisma.messageLog.create({ data: { channel: 'WHATSAPP', body: data.body, recipients: sent, sentBy: req.user!.id } });
  res.json({ sent, failed });
}));

adminRouter.get('/messages', h(async (_req, res) => {
  res.json(await prisma.messageLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }));
}));
