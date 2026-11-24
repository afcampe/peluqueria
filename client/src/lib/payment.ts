import { methodLabel, money } from './format';
import type { Appointment, Payment, TicketRef } from './types';

export type PaymentKind = 'paid' | 'partial' | 'refunded' | 'unpaid' | 'none';

const ACTIVE = ['COMPLETED', 'PARTIALLY_REFUNDED'];

/** Pago vigente: cobrado y no devuelto del todo. */
export const activePayment = (a: Appointment) => a.payments.find((p) => ACTIVE.includes(p.status));

/** ¿Se puede apuntar que no vino? Cuando ya ha llegado la hora y no se ha cobrado en el local (si pagó allí, vino). Pagar online no implica venir. */
export const canMarkNoShow = (a: Appointment) => ['CONFIRMED', 'COMPLETED'].includes(a.status) && new Date(a.startAt) <= new Date() && !a.payments.some((p) => p.provider === 'cash' && ACTIVE.includes(p.status));

/** Resume si una cita está pagada, cómo y si se ha devuelto algo. */
export function paymentInfo(a: Appointment): { kind: PaymentKind; label: string; method: string } {
  const method = methodLabel(a.paymentMethod);
  const p = activePayment(a);
  const refunded = a.payments.filter((x) => x.status === 'REFUNDED').reduce((n, x) => n + x.refundedCents, 0);
  if (p?.status === 'PARTIALLY_REFUNDED') return { kind: 'partial', label: `Pagada ${money(p.amountCents)}, devueltos ${money(p.refundedCents)}`, method };
  if (p) return { kind: 'paid', label: p.provider === 'cash' ? `Cobrada en el local (${money(p.amountCents)})` : `Pagada (${money(p.amountCents)})`, method };
  if (refunded && (a.status === 'CANCELLED' || a.status === 'NO_SHOW')) return { kind: 'refunded', label: `Reembolsada (${money(refunded)})`, method };
  if (a.status === 'CANCELLED' || a.status === 'NO_SHOW') return { kind: 'none', label: 'Sin pago', method };
  if (a.status === 'PENDING_PAYMENT') return { kind: 'unpaid', label: 'Pago online sin completar', method };
  const pending = a.paymentMethod === 'cash' ? 'Pendiente de cobro en el local' : 'No pagada';
  return { kind: 'unpaid', label: refunded ? `${pending} · reembolsados ${money(refunded)}` : pending, method };
}

/** Pago online vigente: al cancelar la cita se devuelve por la plataforma (el efectivo, en mano). */
export const onlinePayment = (a: Appointment): Payment | undefined =>
  a.payments.find((p) => p.provider !== 'cash' && ACTIVE.includes(p.status));

export const cashPayment = (a: Appointment) => a.payments.find((p) => p.provider === 'cash' && p.status === 'COMPLETED');

/** Pago vigente con ticket emitido. */
const ticketedPayment = (a: Appointment) => a.payments.find((p) => ACTIVE.includes(p.status) && p.ticket);

/** Ticket vigente de la cita (o el último emitido, si se reembolsó). */
export const ticketOf = (a: Appointment) => (ticketedPayment(a) ?? a.payments.find((p) => p.ticket))?.ticket ?? null;

/** Todos los tickets de la cita (indicando los de cobros ya reembolsados) y sus rectificativos. */
export const ticketsOf = (a: Appointment): (TicketRef & { refunded: boolean; rectification?: boolean })[] =>
  a.payments.filter((p) => p.ticket).flatMap((p) => [
    { ...p.ticket!, refunded: p.status === 'REFUNDED' },
    ...p.refunds.flatMap((r) => (r.rectification ? [{ ...r.rectification, refunded: false, rectification: true }] : [])),
  ]);

/** Pago online que el administrador puede corregir sin cancelar: solo si la cita no ha terminado. */
export const canCorrectCharge = (a: Appointment) => a.status === 'CONFIRMED' && new Date(a.endAt) > new Date() && !!onlinePayment(a);

/** Pago cobrado (sin devoluciones) que aún no tiene ticket. */
export const canIssueTicket = (a: Appointment) => a.payments.some((p) => p.status === 'COMPLETED' && !p.ticket);
