import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { enabledProviders } from '../payments/registry.js';
import { availabilityForDate } from '../services/appointments.js';
import { getSettings } from '../services/settings.js';
import { ensureTicketFile, verifyTicketSig } from '../services/tickets.js';
import { forbidden, notFound } from '../lib/errors.js';
import { h } from './util.js';

export const publicRouter = Router();

publicRouter.get('/config', h(async (_req, res) => {
  const s = await getSettings();
  const services = await prisma.service.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  res.json({
    shop: { name: s.shopName, phone: s.shopPhone, email: s.shopEmail, address: s.shopAddress },
    timezone: s.timezone,
    currency: s.currency,
    slotMinutes: s.slotMinutes,
    bookingHorizonDays: s.bookingHorizonDays,
    clientCancelMinNoticeMinutes: s.clientCancelMinNoticeMinutes,
    recurring: { enabled: s.recurringEnabled, maxAppointments: s.recurringMaxAppointments },
    weeklySchedule: s.weeklySchedule,
    services,
    paymentMethods: enabledProviders(s).map((p) => ({ id: p.id, label: p.label, online: p.online, config: p.publicConfig() })),
  });
}));

// Fotos de perfil. Se sirven sin sesión para poder usarlas en <img>; el id es aleatorio.
publicRouter.get('/avatars/:id', h(async (req, res) => {
  const u = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { avatar: true, avatarMime: true, status: true },
  });
  if (!u?.avatar || !u.avatarMime || u.status === 'DELETED') return void res.status(404).end();
  res.set({
    'Content-Type': u.avatarMime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(Buffer.from(u.avatar));
}));

publicRouter.get('/availability', h(async (req, res) => {
  const { date, excludeId } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), excludeId: z.string().optional() }).parse(req.query);
  res.json(await availabilityForDate(date, excludeId));
}));

// PDF de un ticket con enlace firmado y temporal (ver /api/tickets/:id/link).
publicRouter.get('/tickets/:id/pdf', h(async (req, res) => {
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!verifyTicketSig(req.params.id, sig)) throw forbidden('El enlace de descarga no es válido o ha caducado');
  const t = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!t) throw notFound('Ticket no encontrado');
  const file = await ensureTicketFile(t);
  res.setHeader('Cache-Control', 'private, no-store');
  res.download(file, `ticket-${t.number}.pdf`);
}));
