import { methodLabel, money } from './format';
import type { Appointment } from './types';

export type PaymentKind = 'paid' | 'partial' | 'refunded' | 'unpaid' | 'none';

/** Resume si una cita está pagada, cómo y si se ha devuelto algo. */
export function paymentInfo(a: Appointment): { kind: PaymentKind; label: string; method: string } {
  const method = methodLabel(a.paymentMethod);
  const p = a.payments.find((x) => ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(x.status));
  if (p?.status === 'REFUNDED') return { kind: 'refunded', label: `Reembolsada (${money(p.refundedCents)})`, method };
  if (p?.status === 'PARTIALLY_REFUNDED') return { kind: 'partial', label: `Pagada ${money(p.amountCents)}, devueltos ${money(p.refundedCents)}`, method };
  if (p) return { kind: 'paid', label: p.provider === 'cash' ? `Cobrada en el local (${money(p.amountCents)})` : `Pagada (${money(p.amountCents)})`, method };
  if (a.status === 'CANCELLED') return { kind: 'none', label: 'Sin pago', method };
  if (a.status === 'PENDING_PAYMENT') return { kind: 'unpaid', label: 'Pago online sin completar', method };
  return { kind: 'unpaid', label: a.paymentMethod === 'cash' ? 'Pendiente de cobro en el local' : 'No pagada', method };
}

/** Pago online reembolsable por la plataforma (el efectivo se devuelve a mano). */
export const onlinePayment = (a: Appointment) =>
  a.payments.find((p) => p.provider !== 'cash' && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(p.status));

export const cashPayment = (a: Appointment) => a.payments.find((p) => p.provider === 'cash' && p.status === 'COMPLETED');
