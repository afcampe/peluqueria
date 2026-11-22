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

const canClientChange = (settings: Settings, startAt: Date) =>
  (startAt.getTime() - Date.now()) / 60_000 >= settings.clientCancelMinNoticeMinutes;

function assertClientNotice(settings: Settings, startAt: Date, action: string) {
  if (!canClientChange(settings, startAt)) {
    const h = settings.clientCancelMinNoticeMinutes;
    const notice = h % 60 === 0 ? `${h / 60} h` : `${h} min`;
    throw forbidden(`No se puede ${action} una cita con menos de ${notice} de antelación. Llama a la peluquería.`);
  }
}

const fmt = (d: Date, tz: string) =>
  DateTime.fromJSDate(d).setZone(tz).setLocale('es').toFormat("cccc d 'de' LLLL 'a las' HH:mm");

const withRelations = {
  client: { select: { id: true, name: true, email: true, phone: true } },
  service: true,
  payments: { include: { refunds: true } },
  series: { select: { id: true, intervalDays: true } },
} as const;

/** Valida la forma de pago para quien reserva (el admin solo puede apuntar pagos en el local). */
function resolvePaymentMethod(actor: Actor, settings: Settings, method: string, clientId: string) {
  const provider = getProvider(method);
  // El admin puede apuntar citas en efectivo aunque el método esté desactivado para clientes.
  const methodAllowed = settings.paymentMethods[provider.id]?.enabled && provider.isConfigured();
  if (!methodAllowed && !(actor.role === 'ADMIN' && !provider.online)) throw badRequest('Ese método de pago no está disponible');
  if (actor.role === 'ADMIN' && provider.online && clientId !== actor.id)
    throw badRequest('El pago online lo debe hacer el propio cliente. Usa "efectivo" para citas creadas desde el panel.');
  return provider;
}

export async function createAppointment(
  actor: Actor,
  input: { clientId?: string; serviceId: string; startAt: string; paymentMethod: string; notes?: string },
) {
  const settings = await getSettings();
  const clientId = actor.role === 'ADMIN' && input.clientId ? input.clientId : actor.id;
  const provider = resolvePaymentMethod(actor, settings, input.paymentMethod, clientId);

  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) throw badRequest('Fecha no válida');

  const appointment = await prisma.$transaction(async (tx) => {
    const client = await tx.user.findUnique({ where: { id: clientId } });
    if (!client || client.status === 'DELETED') throw notFound('Cliente no encontrado');
    if (client.role !== 'CLIENT') throw badRequest('Las cuentas de administrador no tienen citas. Elige un cliente.');
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

// ============================================================== Pago online

type ApptWithRelations = Awaited<ReturnType<typeof loadForActor>>;

/** Crea un único pedido online para una o varias citas pendientes (p. ej. una serie). */
async function startPaymentFor(appts: ApptWithRelations[], reference: string, description: string) {
  const settings = await getSettings();
  if (!appts.length) throw badRequest('No hay citas pendientes de pago');
  const now = new Date();
  if (appts.some((a) => a.status !== 'PENDING_PAYMENT' || !a.holdExpiresAt || a.holdExpiresAt <= now))
    throw badRequest('La reserva ha caducado. Vuelve a elegir hora.');
  const provider = getProvider(appts[0].paymentMethod);
  if (!provider.createOrder) throw badRequest('Este método no requiere pago online');
  const total = appts.reduce((sum, a) => sum + a.priceCents, 0);
  const { orderId } = await provider.createOrder({ reference, description, amountCents: total, currency: settings.currency });
  // Un registro de pago por cita (comparten pedido y cobro) para poder reembolsar cada una por separado.
  await prisma.payment.createMany({
    data: appts.map((a) => ({ appointmentId: a.id, provider: provider.id, providerOrderId: orderId, amountCents: a.priceCents, currency: settings.currency })),
  });
  return { orderId, amountCents: total };
}

/** Inicia el pago online de una cita pendiente. */
export async function startOnlinePayment(actor: Actor, appointmentId: string) {
  const settings = await getSettings();
  const a = await loadForActor(actor, appointmentId);
  return startPaymentFor([a], a.id, `${a.service.name} - ${fmt(a.startAt, settings.timezone)}`);
}

/** Inicia el pago conjunto de todas las citas pendientes de una serie. */
export async function startSeriesPayment(actor: Actor, seriesId: string) {
  const series = await loadSeriesForActor(actor, seriesId);
  const appts = await prisma.appointment.findMany({ where: { seriesId: series.id, status: 'PENDING_PAYMENT' }, include: withRelations, orderBy: { startAt: 'asc' } });
  return startPaymentFor(appts, series.id, `${appts.length} citas de ${appts[0]?.service.name ?? 'peluquería'} (cada ${series.intervalDays} días)`);
}

/**
 * Cobra un pedido aprobado por el cliente y confirma todas sus citas.
 * Si alguna cita perdió el hueco mientras se pagaba, se le devuelve su parte.
 */
async function completeOrder(actor: Actor, orderId: string) {
  const settings = await getSettings();
  const payments = await prisma.payment.findMany({
    where: { providerOrderId: orderId, ...(actor.role !== 'ADMIN' && { appointment: { clientId: actor.id } }) },
  });
  if (!payments.length) throw notFound('Pago no encontrado');

  if (payments.some((p) => p.status !== 'COMPLETED')) {
    const provider = getProvider(payments[0].provider);
    const capture = await provider.captureOrder!(orderId);
    const expected = payments.reduce((sum, p) => sum + p.amountCents, 0);
    if (capture.amountCents !== expected) {
      await prisma.payment.updateMany({ where: { providerOrderId: orderId }, data: { status: 'FAILED' } });
      throw badRequest('El importe cobrado no coincide');
    }
    await prisma.payment.updateMany({ where: { providerOrderId: orderId }, data: { status: 'COMPLETED', providerCaptureId: capture.captureId } });
  }

  const confirmed: string[] = [];
  const lost: string[] = [];
  for (const p of payments) {
    const ok = await prisma.$transaction(async (tx) => {
      const fresh = await tx.appointment.findUniqueOrThrow({ where: { id: p.appointmentId } });
      if (fresh.status === 'CONFIRMED') return true; // ya confirmada (reintento)
      if (fresh.status === 'CANCELLED') {
        if (fresh.cancelledBy !== 'SYSTEM') return false; // la canceló una persona: no se revive
        try {
          await assertSlotBookable(tx, settings, fresh.startAt, fresh.id);
        } catch {
          return false;
        }
      }
      await tx.appointment.update({ where: { id: fresh.id }, data: { status: 'CONFIRMED', holdExpiresAt: null, cancelledAt: null, cancelledBy: null, cancelReason: null } });
      return true;
    }, { isolationLevel: 'Serializable' });
    (ok ? confirmed : lost).push(p.appointmentId);
  }

  let lostRefundCents = 0;
  for (const id of lost) {
    const p = await prisma.payment.findFirstOrThrow({ where: { providerOrderId: orderId, appointmentId: id } });
    if (p.refundedCents < p.amountCents) {
      lostRefundCents += (await refundPayment(p.id, { requestedBy: 'SYSTEM', reason: 'El hueco ya no estaba disponible' })).amountCents;
    }
    await prisma.appointment.update({ where: { id }, data: { status: 'CANCELLED', cancelledBy: 'SYSTEM', cancelReason: 'El hueco ya no estaba disponible al completar el pago' } });
  }

  const appointments = await prisma.appointment.findMany({ where: { id: { in: confirmed } }, include: withRelations, orderBy: { startAt: 'asc' } });
  if (appointments.length === 1) notifyConfirmed(appointments[0], settings);
  else if (appointments.length > 1) notifySeriesConfirmed(appointments, settings);
  return { appointments, lostCount: lost.length, lostRefundCents };
}

/** Confirma el pago online de una cita suelta. */
export async function completeOnlinePayment(actor: Actor, appointmentId: string, orderId: string) {
  const a = await loadForActor(actor, appointmentId);
  if (!a.payments.some((p) => p.providerOrderId === orderId)) throw notFound('Pago no encontrado');
  const r = await completeOrder(actor, orderId);
  if (r.lostCount) throw conflict('El hueco ya no estaba disponible. Te hemos devuelto el importe íntegro.');
  return r.appointments[0];
}

/** Confirma el pago conjunto de una serie. */
export async function completeSeriesPayment(actor: Actor, seriesId: string, orderId: string) {
  await loadSeriesForActor(actor, seriesId);
  return completeOrder(actor, orderId);
}

// ============================================================== Citas periódicas

async function loadSeriesForActor(actor: Actor, id: string) {
  const series = await prisma.appointmentSeries.findUnique({ where: { id } });
  if (!series || (actor.role !== 'ADMIN' && series.clientId !== actor.id)) throw notFound('Serie no encontrada');
  return series;
}

export interface Occurrence {
  /** Hora pedida según la periodicidad. */
  requested: string;
  /** Hora propuesta (igual a la pedida o la alternativa más cercana); null si no hay hueco. */
  start: string | null;
  status: 'OK' | 'MOVED' | 'UNAVAILABLE';
  reason?: string;
}

const reasonText: Record<string, string> = {
  BOOKED: 'Ocupado a esa hora',
  CLOSED: 'La peluquería está cerrada',
  PAST: 'Hora ya pasada',
  OUT_OF_RANGE: 'Fuera del plazo de reserva',
};

/**
 * Calcula las fechas de una serie: cada `intervalDays` días a la misma hora,
 * hasta `until` (fecha local) o `count` citas, sin pasar del horizonte de reserva.
 * Si la hora pedida no está libre propone la más cercana ese día o en los 3 días siguientes.
 */
export async function previewSeries(input: { firstStart: string; intervalDays: number; count?: number; until?: string }) {
  const settings = await getSettings();
  const first = DateTime.fromISO(input.firstStart, { zone: settings.timezone });
  if (!first.isValid) throw badRequest('Fecha no válida');
  if (!Number.isInteger(input.intervalDays) || input.intervalDays < 1 || input.intervalDays > 365) throw badRequest('La periodicidad debe estar entre 1 y 365 días');
  const max = settings.recurringMaxAppointments;
  const horizon = DateTime.now().setZone(settings.timezone).endOf('day').plus({ days: settings.bookingHorizonDays });
  const until = input.until ? DateTime.fromISO(input.until, { zone: settings.timezone }).endOf('day') : horizon;
  const limit = Math.min(input.count ?? max, max);

  // Fechas pedidas. `plus({ days })` conserva la hora local aunque cambie el horario de verano.
  const requested: DateTime[] = [];
  for (let i = 0; requested.length < limit; i++) {
    const d = first.plus({ days: i * input.intervalDays });
    if (d > until || d > horizon) break;
    requested.push(d);
  }

  // Una sola consulta para todo el periodo.
  const from = first.startOf('day').toJSDate();
  const to = (requested.at(-1) ?? first).plus({ days: 4 }).endOf('day').toJSDate();
  const { appointments, closures } = await busyIntervals(prisma, from, to);
  const busy: Interval[] = [...appointments];

  const slotsFor = (day: DateTime) => computeSlots({ date: day.toISODate()!, settings, appointments: busy, closures });
  const minutesOfDay = (d: DateTime) => d.hour * 60 + d.minute;

  const result: Occurrence[] = requested.map((req) => {
    const daySlots = slotsFor(req);
    const exact = daySlots.find((sl) => DateTime.fromISO(sl.start).toMillis() === req.toMillis());
    let start: string | null = null;
    let status: Occurrence['status'] = 'UNAVAILABLE';
    let reason: string | undefined;

    if (exact?.available) {
      start = exact.start;
      status = 'OK';
    } else {
      reason = exact?.reason ? reasonText[exact.reason] : daySlots.length ? 'Hora fuera del horario' : 'Cerrado ese día';
      // Buscar el hueco libre más cercano a la misma hora: ese día y, si no, los 3 siguientes.
      for (let shift = 0; shift <= 3 && !start; shift++) {
        const day = req.plus({ days: shift });
        const target = minutesOfDay(req);
        const free = (shift === 0 ? daySlots : slotsFor(day))
          .filter((sl) => sl.available)
          .sort((a, b) =>
            Math.abs(minutesOfDay(DateTime.fromISO(a.start, { zone: settings.timezone })) - target) -
            Math.abs(minutesOfDay(DateTime.fromISO(b.start, { zone: settings.timezone })) - target));
        if (free[0]) {
          start = free[0].start;
          status = 'MOVED';
        }
      }
    }
    // Reservar en memoria el hueco elegido para que dos fechas de la serie no coincidan.
    if (start) busy.push({ startAt: new Date(start), endAt: new Date(new Date(start).getTime() + settings.slotMinutes * 60_000) });
    return { requested: req.toUTC().toISO()!, start, status, ...(reason && { reason }) };
  });

  return { occurrences: result, maxAppointments: max, truncated: requested.length === max && (input.count ?? Infinity) > max };
}

/** Reserva todas las citas de una serie de una vez: o se crean todas o ninguna. */
export async function createSeries(
  actor: Actor,
  input: { clientId?: string; serviceId: string; intervalDays: number; starts: string[]; paymentMethod: string; notes?: string },
) {
  const settings = await getSettings();
  if (!settings.recurringEnabled && actor.role !== 'ADMIN') throw badRequest('Las reservas periódicas no están disponibles');
  const clientId = actor.role === 'ADMIN' && input.clientId ? input.clientId : actor.id;
  const provider = resolvePaymentMethod(actor, settings, input.paymentMethod, clientId);

  const starts = [...new Set(input.starts)].map((x) => new Date(x)).sort((a, b) => a.getTime() - b.getTime());
  if (starts.some((d) => Number.isNaN(d.getTime()))) throw badRequest('Alguna fecha no es válida');
  if (starts.length < 2) throw badRequest('Una serie necesita al menos 2 citas');
  if (starts.length > settings.recurringMaxAppointments) throw badRequest(`Como máximo se pueden reservar ${settings.recurringMaxAppointments} citas a la vez`);

  const created = await prisma.$transaction(async (tx) => {
    const client = await tx.user.findUnique({ where: { id: clientId } });
    if (!client || client.status === 'DELETED') throw notFound('Cliente no encontrado');
    if (client.role !== 'CLIENT') throw badRequest('Las cuentas de administrador no tienen citas. Elige un cliente.');
    const service = await tx.service.findFirst({ where: { id: input.serviceId, active: true } });
    if (!service) throw badRequest('Servicio no disponible');
    const series = await tx.appointmentSeries.create({ data: { clientId, intervalDays: input.intervalDays } });
    const holdExpiresAt = provider.online ? new Date(Date.now() + settings.paymentHoldMinutes * 60_000) : null;

    for (const start of starts) {
      let slot: Interval;
      try {
        // Las citas ya creadas en esta transacción cuentan como ocupadas.
        slot = await assertSlotBookable(tx, settings, start);
      } catch (e) {
        (e as Error).message = `Cita del ${fmt(start, settings.timezone)}: ${(e as Error).message}`;
        throw e;
      }
      await tx.appointment.create({
        data: {
          clientId, serviceId: service.id, seriesId: series.id, startAt: slot.startAt, endAt: slot.endAt,
          priceCents: service.priceCents, paymentMethod: provider.id, notes: input.notes,
          status: provider.online ? 'PENDING_PAYMENT' : 'CONFIRMED', holdExpiresAt,
        },
      });
    }
    return series;
  }, { isolationLevel: 'Serializable', timeout: 20_000 });

  const appointments = await prisma.appointment.findMany({ where: { seriesId: created.id }, include: withRelations, orderBy: { startAt: 'asc' } });
  if (!provider.online) notifySeriesConfirmed(appointments, settings);
  return {
    series: created,
    appointments,
    totalCents: appointments.reduce((sum, a) => sum + a.priceCents, 0),
    pendingPayment: provider.online,
  };
}

function notifySeriesConfirmed(appts: { startAt: Date; client: { email: string; name: string }; service: { name: string }; paymentMethod: string }[], settings: Settings) {
  const a = appts[0];
  const list = appts.map((x) => `  • ${fmt(x.startAt, settings.timezone)}`).join('\n');
  const pago = a.paymentMethod === 'cash' ? 'Pagarás cada cita en el local.' : 'El pago se ha realizado correctamente.';
  sendEmailSafe(
    a.client.email,
    `${appts.length} citas confirmadas`,
    `Hola ${a.client.name},\n\nHemos reservado ${appts.length} citas de ${a.service.name}:\n\n${list}\n\n${pago}\nPuedes cambiar o cancelar cada una desde la app hasta ${settings.clientCancelMinNoticeMinutes} minutos antes.`,
  );
}

/**
 * Cancela las citas activas de una serie (todas las futuras, o desde una cita concreta).
 * Al cliente se le saltan las que ya no cumplen la antelación mínima.
 */
export async function cancelSeries(actor: Actor, seriesId: string, opts: { fromAppointmentId?: string; reason?: string; refund?: boolean; notify?: boolean } = {}) {
  const settings = await getSettings();
  await loadSeriesForActor(actor, seriesId);
  let from = new Date();
  if (opts.fromAppointmentId) {
    const a = await prisma.appointment.findFirst({ where: { id: opts.fromAppointmentId, seriesId } });
    if (!a) throw notFound('Cita no encontrada en la serie');
    from = a.startAt;
  }
  const appts = await prisma.appointment.findMany({
    where: { seriesId, status: { in: ['CONFIRMED', 'PENDING_PAYMENT'] }, startAt: { gte: from } },
    orderBy: { startAt: 'asc' },
    include: { client: { select: { name: true, email: true } } },
  });

  const cancelled: Date[] = [];
  let skipped = 0;
  let refundedCents = 0;
  for (const a of appts) {
    if (actor.role === 'CLIENT' && !canClientChange(settings, a.startAt)) {
      skipped++;
      continue;
    }
    const r = await cancelAppointment(actor, a.id, { reason: opts.reason, refund: opts.refund, notify: false });
    refundedCents += r.refundedCents;
    if (a.status === 'CONFIRMED') cancelled.push(a.startAt);
  }

  if (cancelled.length && opts.notify !== false) {
    const who = actor.role === 'CLIENT' ? 'Has cancelado' : 'La peluquería ha cancelado';
    const refundText = refundedCents ? `\n\nTe hemos devuelto ${centsToAmount(refundedCents)} ${settings.currency}. Puede tardar unos días en aparecer.` : '';
    sendEmailSafe(
      appts[0].client.email,
      `${cancelled.length} citas canceladas`,
      `Hola ${appts[0].client.name},\n\n${who} estas citas:\n\n${cancelled.map((d) => `  • ${fmt(d, settings.timezone)}`).join('\n')}${opts.reason && actor.role !== 'CLIENT' ? `\n\nMotivo: ${opts.reason}` : ''}${refundText}`,
    );
  }
  return { cancelled: appts.length - skipped, skipped, refundedCents };
}

export { withRelations };
