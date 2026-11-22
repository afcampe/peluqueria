import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requireAdmin, requireAuth } from '../lib/auth.js';
import { avatarData, avatarField } from '../lib/avatar.js';
import { prisma } from '../lib/db.js';
import { badRequest, conflict } from '../lib/errors.js';
import { emailConfigured, sendEmail } from '../notifications/email.js';
import { sendWhatsApp, waLink, whatsappApiConfigured } from '../notifications/whatsapp.js';
import { allProviders } from '../payments/registry.js';
import { cancelAppointment, cancelSeries, createAppointment, createSeries, previewSeries, refundPayment, rescheduleAppointment, withRelations } from '../services/appointments.js';
import { seriesCreateSchema, seriesPreviewSchema } from './appointments.js';
import { getSettings, saveSettings } from '../services/settings.js';
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
    onlineRevenueMonthCents: monthPayments.reduce((sum, p) => sum + p.amountCents - p.refundedCents, 0),
    integrations: { email: emailConfigured(), whatsappApi: whatsappApiConfigured(), payments: allProviders().map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured() })) },
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
  res.json(await prisma.appointment.findMany({ where, include: withRelations, orderBy: { startAt: 'asc' }, take: 500 }));
}));

adminRouter.post('/appointments', h(async (req, res) => {
  const data = z.object({
    clientId: z.string(), serviceId: z.string(), startAt: z.string(),
    paymentMethod: z.string().default('cash'), notes: z.string().max(500).optional(),
  }).parse(req.body);
  res.status(201).json(await createAppointment(ADMIN(req), data));
}));

adminRouter.post('/appointments/series/preview', h(async (req, res) => {
  res.json(await previewSeries(seriesPreviewSchema.parse(req.body)));
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
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { ...data, ...avatarData(avatar), ...(password && { passwordHash: await bcrypt.hash(password, 10) }) },
  });
  res.json(publicUser(user));
}));

/** Cancela (con reembolso) las citas futuras de un usuario. */
async function cancelFutureOf(req: Parameters<typeof actor>[0], userId: string, reason: string) {
  const future = await prisma.appointment.findMany({ where: { clientId: userId, status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] }, startAt: { gt: new Date() } } });
  for (const a of future) await cancelAppointment(ADMIN(req), a.id, { reason, refund: true });
  return future.length;
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
  const cancelled = cancelFuture ? await cancelFutureOf(req, user.id, 'Cuenta bloqueada') : 0;
  res.json({ user: publicUser(user), cancelled });
}));

adminRouter.post('/users/:id/unblock', h(async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: 'ACTIVE', blockedUntil: null, blockReason: null } });
  res.json(publicUser(user));
}));

// Baja: se conserva el historial (citas y pagos) pero la cuenta deja de funcionar.
adminRouter.delete('/users/:id', h(async (req, res) => {
  if (req.params.id === req.user!.id) throw badRequest('No puedes darte de baja a ti mismo');
  const cancelled = await cancelFutureOf(req, req.params.id, 'Baja del cliente');
  const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: 'DELETED', acceptsEmail: false } });
  res.json({ user: publicUser(user), cancelled });
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
  if (data.cancelAppointments) {
    const reason = data.reason ? `Cierre de la peluquería: ${data.reason}` : 'Cierre de la peluquería';
    for (const a of affected) await cancelAppointment(ADMIN(req), a.id, { reason, refund: true });
  }
  res.status(201).json({ closure, affected: affected.length, cancelled: data.cancelAppointments ? affected.length : 0 });
}));

adminRouter.delete('/closures/:id', h(async (req, res) => {
  await prisma.closure.delete({ where: { id: req.params.id } });
  res.status(204).end();
}));

// ---------------------------------------------------------------- Configuración y servicios
adminRouter.get('/settings', h(async (_req, res) => {
  res.json({ settings: await getSettings(), providers: allProviders().map((p) => ({ id: p.id, label: p.label, online: p.online, configured: p.isConfigured() })) });
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
  const base: Prisma.UserWhereInput = { status: { not: 'DELETED' }, role: 'CLIENT', ...(requireEmailConsent && { acceptsEmail: true }) };
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
  res.json({ count: users.length });
}));

adminRouter.post('/messages/email', h(async (req, res) => {
  const data = audienceSchema.extend({ subject: z.string().trim().min(1), body: z.string().trim().min(1) }).parse(req.body);
  const users = await resolveAudience(data, true);
  let sent = 0;
  const failed: string[] = [];
  for (const u of users) {
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
