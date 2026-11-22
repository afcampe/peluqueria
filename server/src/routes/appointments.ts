import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { prisma } from '../lib/db.js';
import {
  cancelAppointment, completeOnlinePayment, createAppointment, rescheduleAppointment, startOnlinePayment, withRelations,
} from '../services/appointments.js';
import { actor, h } from './util.js';

export const appointmentsRouter = Router();
appointmentsRouter.use(requireAuth);

appointmentsRouter.get('/', h(async (req, res) => {
  res.json(await prisma.appointment.findMany({
    where: { clientId: req.user!.id, NOT: { status: 'CANCELLED', cancelledBy: 'SYSTEM' } },
    include: withRelations,
    orderBy: { startAt: 'desc' },
    take: 100,
  }));
}));

const createSchema = z.object({
  serviceId: z.string(),
  startAt: z.string(),
  paymentMethod: z.string(),
  notes: z.string().max(500).optional(),
});

appointmentsRouter.post('/', h(async (req, res) => {
  const data = createSchema.parse(req.body);
  // Un cliente siempre reserva para sí mismo.
  res.status(201).json(await createAppointment({ ...actor(req), role: 'CLIENT' }, data));
}));

appointmentsRouter.patch('/:id', h(async (req, res) => {
  const data = z.object({ startAt: z.string(), serviceId: z.string().optional(), notes: z.string().max(500).optional() }).parse(req.body);
  res.json(await rescheduleAppointment({ ...actor(req), role: 'CLIENT' }, req.params.id, data));
}));

appointmentsRouter.post('/:id/cancel', h(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
  res.json(await cancelAppointment({ ...actor(req), role: 'CLIENT' }, req.params.id, { reason }));
}));

// --- Pago online (PayPal y futuros proveedores) ---
appointmentsRouter.post('/:id/pay/start', h(async (req, res) => {
  res.json(await startOnlinePayment({ ...actor(req), role: 'CLIENT' }, req.params.id));
}));

appointmentsRouter.post('/:id/pay/complete', h(async (req, res) => {
  const { orderId } = z.object({ orderId: z.string() }).parse(req.body);
  res.json(await completeOnlinePayment({ ...actor(req), role: 'CLIENT' }, req.params.id, orderId));
}));
