import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { sendEmailSafe } from '../notifications/email.js';
import { getProvider } from '../payments/registry.js';
import { centsToAmount } from '../payments/types.js';
import { computeSlots, localDate, type Interval } from './availability.js';
import { getSettings, type Settings } from './settings.js';

export type Actor = { id: string; role: 'CLIENT' | 'ADMIN' };
type Tx = Prisma.TransactionClient;

/** Citas que ocupan hueco: confirmadas, pasadas, o pendientes de pago con la reserva vigente. */
const occupyingWhere = (now: Date): Prisma.AppointmentWhereInput => ({
  OR: [
    { status: { in: ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] } },
    { status: 'PENDING_PAYMENT', holdExpiresAt: { gt: now } },
  ],
});

async function busyIntervals(db: Tx | typeof prisma, from: Date, to: Date, excludeId?: string) {
  const now = new Date();
  const [appointments, closures] = await Promise.all([
    db.appointment.findMany({
      where: { AND: [occupyingWhere(now), { startAt: { lt: to }, endAt: { gt: from } }, excludeId ? { id: { not: excludeId } } : {}] },
      select: { startAt: true, endAt: true },
    }),
    db.closure.findMany({ where: { startAt: { lt: to }, endAt: { gt: from } }, select: { startAt: true, endAt: true } }),
  ]);
  return { appointments, closures };
}

export async function availabilityForDate(date: string, excludeId?: string) {
  const settings = await getSettings();
  const day = DateTime.fromISO(date, { zone: settings.timezone });
  if (!day.isValid) throw badRequest('Fecha no válida');
  const { appointments, closures } = await busyIntervals(
    prisma,
    day.startOf('day').toJSDate(),
    day.endOf('day').toJSDate(),
    excludeId,
  );
  return computeSlots({ date, settings, appointments, closures });
}

/** Comprueba dentro de la transacción que el hueco sigue libre y encaja en el horario. */
async function assertSlotBookable(tx: Tx, settings: Settings, start: Date, excludeId?: string): Promise<Interval> {
  const date = localDate(start, settings.timezone);
  const day = DateTime.fromISO(date, { zone: settings.timezone });
  const { appointments, closures } = await busyIntervals(tx, day.startOf('day').toJSDate(), day.endOf('day').toJSDate(), excludeId);
  const slot = computeSlots({ date, settings, appointments, closures }).find((s) => new Date(s.start).getTime() === start.getTime());
  if (!slot) throw badRequest('Esa hora no está dentro del horario de la peluquería', 'INVALID_SLOT');
  if (!slot.available) {
    const msg = {
      PAST: 'Esa hora ya ha pasado',
      OUT_OF_RANGE: `Solo se puede reservar con ${settings.bookingHorizonDays} días de antelación como máximo`,
      CLOSED: 'La peluquería está cerrada en esa fecha',
      BOOKED: 'Ese hueco acaba de ser reservado por otra persona',
    }[slot.reason!];
    throw conflict(msg, `SLOT_${slot.reason}`);
  }
  return { startAt: new Date(slot.start), endAt: new Date(slot.end) };
}

function assertClientNotice(settings: Settings, startAt: Date, action: string) {
  const minutesLeft = (startAt.getTime() - Date.now()) / 60_000;
  if (minutesLeft < settings.clientCancelMinNoticeMinutes) {
    const h = settings.clientCancelMinNoticeMinutes;
    const notice = h % 60 === 0 ? `${h / 60} h` : `${h} min`;
    throw forbidden(`No se puede ${action} una cita con menos de ${notice} de antelación. Llama a la peluquería.`);
  }
}

const fmt = (d: Date, tz: string) =>
  DateTime.fromJSDate(d).setZone(tz).setLocale('es').toFormat("cccc d 'de' LLLL 'a las' HH:mm");

const withRelations = { client: { select: { id: true, name: true, email: true, phone: true } }, service: true, payments: { include: { refunds: true } } } as const;

export async function createAppointment(
  actor: Actor,
  input: { clientId?: string; serviceId: string; startAt: string; paymentMethod: string; notes?: string },
) {
  const settings = await getSettings();
  const clientId = actor.role === 'ADMIN' && input.clientId ? input.clientId : actor.id;
  const provider = getProvider(input.paymentMethod);
  // El admin puede apuntar citas en efectivo aunque el método esté desactivado para clientes.
  const methodAllowed = settings.paymentMethods[provider.id]?.enabled && provider.isConfigured();
  if (!methodAllowed && !(actor.role === 'ADMIN' && !provider.online)) throw badRequest('Ese método de pago no está disponible');
  if (actor.role === 'ADMIN' && provider.online && clientId !== actor.id)
    throw badRequest('El pago online lo debe hacer el propio cliente. Usa "efectivo" para citas creadas desde el panel.');

  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) throw badRequest('Fecha no válida');

  const appointment = await prisma.$transaction(async (tx) => {
    const client = await tx.user.findUnique({ where: { id: clientId } });
    if (!client || client.status === 'DELETED') throw notFound('Cliente no encontrado');
    const service = await tx.service.findFirst({ where: { id: input.serviceId, active: true } });
    if (!service) throw badRequest('Servicio no disponible');
    const { startAt, endAt } = await assertSlotBookable(tx, settings, start);

    return tx.appointment.create({
      data: {
        clientId,
        serviceId: service.id,
        startAt,
        endAt,
        priceCents: service.priceCents,
        paymentMethod: provider.id,
        notes: input.notes,
        status: provider.online ? 'PENDING_PAYMENT' : 'CONFIRMED',
        holdExpiresAt: provider.online ? new Date(Date.now() + settings.paymentHoldMinutes * 60_000) : null,
      },
      include: withRelations,
    });
  }, { isolationLevel: 'Serializable' });

  if (appointment.status === 'CONFIRMED') notifyConfirmed(appointment, settings);
  return appointment;
}

function notifyConfirmed(a: { startAt: Date; client: { email: string; name: string }; service: { name: string }; paymentMethod: string }, settings: Settings) {
  const pago = a.paymentMethod === 'cash' ? 'Pagarás en el local.' : 'El pago se ha realizado correctamente.';
  sendEmailSafe(
    a.client.email,
    'Cita confirmada',
    `Hola ${a.client.name},\n\nTu cita de ${a.service.name} es el ${fmt(a.startAt, settings.timezone)}.\n${pago}\n\nPuedes modificarla o cancelarla desde la app hasta ${settings.clientCancelMinNoticeMinutes} minutos antes.`,
  );
}

async function loadForActor(actor: Actor, id: string) {
  const a = await prisma.appointment.findUnique({ where: { id }, include: withRelations });
  if (!a) throw notFound('Cita no encontrada');
  if (actor.role !== 'ADMIN' && a.clientId !== actor.id) throw notFound('Cita no encontrada');
  return a;
}

export async function rescheduleAppointment(actor: Actor, id: string, input: { startAt: string; serviceId?: string; notes?: string }) {
  const settings = await getSettings();
  const current = await loadForActor(actor, id);
  if (!['CONFIRMED', 'PENDING_PAYMENT'].includes(current.status)) throw badRequest('Solo se pueden modificar citas activas');
  if (actor.role === 'CLIENT') assertClientNotice(settings, current.startAt, 'modificar');
  // Cambiar de servicio cambiaría el importe ya cobrado: solo se permite en citas sin pago online.
  if (input.serviceId && input.serviceId !== current.serviceId && current.payments.some((p) => p.status !== 'FAILED'))
    throw badRequest('No se puede cambiar el servicio de una cita ya pagada. Cancélala y reserva de nuevo.');

  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) throw badRequest('Fecha no válida');

  const updated = await prisma.$transaction(async (tx) => {
    const { startAt, endAt } = await assertSlotBookable(tx, settings, start, id);
    let priceCents = current.priceCents;
    if (input.serviceId && input.serviceId !== current.serviceId) {
      const s = await tx.service.findFirst({ where: { id: input.serviceId, active: true } });
      if (!s) throw badRequest('Servicio no disponible');
      priceCents = s.priceCents;
    }
    return tx.appointment.update({
      where: { id },
      data: { startAt, endAt, priceCents, serviceId: input.serviceId ?? current.serviceId, notes: input.notes ?? current.notes },
      include: withRelations,
    });
  }, { isolationLevel: 'Serializable' });

  if (updated.status === 'CONFIRMED')
    sendEmailSafe(updated.client.email, 'Cita modificada', `Hola ${updated.client.name},\n\nTu cita se ha cambiado al ${fmt(updated.startAt, settings.timezone)}.`);
  return updated;
}

/** Reembolsa (total o parcialmente) un pago. Devuelve el reembolso creado. */
export async function refundPayment(paymentId: string, opts: { amountCents?: number; reason?: string; requestedBy: 'CLIENT' | 'ADMIN' | 'SYSTEM' }) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound('Pago no encontrado');
  if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(payment.status) || !payment.providerCaptureId)
    throw badRequest('Este pago no admite reembolso');
  const remaining = payment.amountCents - payment.refundedCents;
  const amount = opts.amountCents ?? remaining;
  if (!Number.isInteger(amount) || amount <= 0 || amount > remaining)
    throw badRequest(`Importe no válido. Máximo reembolsable: ${centsToAmount(remaining)} ${payment.currency}`);

  const provider = getProvider(payment.provider);
  if (!provider.refund) throw badRequest(`${provider.label} no admite reembolsos automáticos`);
  const { refundId } = await provider.refund({
    captureId: payment.providerCaptureId,
    amountCents: amount,
    currency: payment.currency,
    idempotencyKey: randomUUID(),
    note: opts.reason,
  });

  const refundedCents = payment.refundedCents + amount;
  const [refund] = await prisma.$transaction([
    prisma.refund.create({ data: { paymentId, amountCents: amount, providerRefundId: refundId, reason: opts.reason, requestedBy: opts.requestedBy } }),
    prisma.payment.update({
      where: { id: paymentId },
      data: { refundedCents, status: refundedCents >= payment.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
    }),
  ]);
  return refund;
}

export async function cancelAppointment(
  actor: Actor | { id: null; role: 'SYSTEM' },
  id: string,
  opts: { reason?: string; refund?: boolean; notify?: boolean } = {},
) {
  const settings = await getSettings();
  const a =
    actor.role === 'SYSTEM'
      ? await prisma.appointment.findUniqueOrThrow({ where: { id }, include: withRelations })
      : await loadForActor(actor as Actor, id);
  if (!['CONFIRMED', 'PENDING_PAYMENT'].includes(a.status)) throw badRequest('La cita ya no está activa');
  if (actor.role === 'CLIENT') assertClientNotice(settings, a.startAt, 'cancelar');

  // El cliente siempre recibe reembolso completo; admin/sistema deciden (por defecto sí).
  const doRefund = actor.role === 'CLIENT' ? true : opts.refund ?? true;
  let refundedCents = 0;
  if (doRefund) {
    for (const p of a.payments.filter((p) => ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(p.status))) {
      const r = await refundPayment(p.id, { reason: opts.reason ?? 'Cancelación de cita', requestedBy: actor.role });
      refundedCents += r.amountCents;
    }
  }

  const cancelled = await prisma.appointment.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actor.role, cancelReason: opts.reason, holdExpiresAt: null },
    include: withRelations,
  });

  if (a.status === 'CONFIRMED' && opts.notify !== false) {
    const refundText = refundedCents ? `\nTe hemos devuelto ${centsToAmount(refundedCents)} ${settings.currency}. Puede tardar unos días en aparecer.` : '';
    const who = actor.role === 'CLIENT' ? 'Has cancelado' : 'La peluquería ha cancelado';
    sendEmailSafe(
      a.client.email,
      'Cita cancelada',
      `Hola ${a.client.name},\n\n${who} tu cita del ${fmt(a.startAt, settings.timezone)}.${opts.reason && actor.role !== 'CLIENT' ? `\nMotivo: ${opts.reason}` : ''}${refundText}`,
    );
  }
  return { appointment: cancelled, refundedCents };
}

/** Libera los huecos de pagos online que no se completaron a tiempo. */
export async function expirePendingPayments() {
  const res = await prisma.appointment.updateMany({
    where: { status: 'PENDING_PAYMENT', holdExpiresAt: { lte: new Date() } },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SYSTEM', cancelReason: 'Pago no completado a tiempo' },
  });
  return res.count;
}

/** Inicia el pago online de una cita pendiente. */
export async function startOnlinePayment(actor: Actor, appointmentId: string) {
  const settings = await getSettings();
  const a = await loadForActor(actor, appointmentId);
  if (a.status !== 'PENDING_PAYMENT' || !a.holdExpiresAt || a.holdExpiresAt <= new Date())
    throw badRequest('La reserva ha caducado. Vuelve a elegir hora.');
  const provider = getProvider(a.paymentMethod);
  if (!provider.createOrder) throw badRequest('Este método no requiere pago online');
  const { orderId } = await provider.createOrder({
    reference: a.id,
    description: `${a.service.name} - ${fmt(a.startAt, settings.timezone)}`,
    amountCents: a.priceCents,
    currency: settings.currency,
  });
  await prisma.payment.create({
    data: { appointmentId: a.id, provider: provider.id, providerOrderId: orderId, amountCents: a.priceCents, currency: settings.currency },
  });
  return { orderId };
}

/** Confirma el pago online tras la aprobación del cliente. */
export async function completeOnlinePayment(actor: Actor, appointmentId: string, orderId: string) {
  const settings = await getSettings();
  const a = await loadForActor(actor, appointmentId);
  const payment = a.payments.find((p) => p.providerOrderId === orderId);
  if (!payment) throw notFound('Pago no encontrado');
  if (payment.status === 'COMPLETED') return a; // idempotente
  const provider = getProvider(payment.provider);
  const capture = await provider.captureOrder!(orderId);
  if (capture.amountCents !== payment.amountCents) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
    throw badRequest('El importe cobrado no coincide');
  }
  await prisma.payment.update({ where: { id: payment.id }, data: { status: 'COMPLETED', providerCaptureId: capture.captureId } });

  // Si el hueco caducó mientras pagaba y alguien lo ha ocupado, se devuelve el dinero.
  const stillFree = await prisma.$transaction(async (tx) => {
    const fresh = await tx.appointment.findUniqueOrThrow({ where: { id: a.id } });
    if (fresh.status === 'CANCELLED') {
      if (fresh.cancelledBy !== 'SYSTEM') return false; // la canceló una persona: no se revive
      try {
        await assertSlotBookable(tx, settings, fresh.startAt, fresh.id);
      } catch {
        return false;
      }
    }
    await tx.appointment.update({ where: { id: a.id }, data: { status: 'CONFIRMED', holdExpiresAt: null, cancelledAt: null, cancelledBy: null, cancelReason: null } });
    return true;
  }, { isolationLevel: 'Serializable' });

  if (!stillFree) {
    await refundPayment(payment.id, { requestedBy: 'SYSTEM', reason: 'El hueco ya no estaba disponible' });
    throw conflict('El hueco ya no estaba disponible. Te hemos devuelto el importe íntegro.');
  }
  const confirmed = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id }, include: withRelations });
  notifyConfirmed(confirmed, settings);
  return confirmed;
}

export { withRelations };
