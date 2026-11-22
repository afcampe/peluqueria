export interface User {
  id: string; email: string; name: string; phone: string | null;
  role: 'CLIENT' | 'ADMIN'; status: 'ACTIVE' | 'BLOCKED' | 'DELETED';
  blockedUntil: string | null; blockReason: string | null; acceptsEmail: boolean; createdAt: string;
  whatsappLink?: string | null;
  avatarUrl: string | null;
}
export interface Service { id: string; name: string; priceCents: number; active: boolean; sortOrder: number }
export interface Refund { id: string; amountCents: number; reason: string | null; requestedBy: string; createdAt: string }
export interface Payment {
  id: string; provider: string; amountCents: number; currency: string; refundedCents: number;
  status: 'CREATED' | 'COMPLETED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'FAILED'; refunds: Refund[];
}
export type AppointmentStatus = 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';
export interface Appointment {
  id: string; startAt: string; endAt: string; status: AppointmentStatus; paymentMethod: string; priceCents: number;
  notes: string | null; cancelledBy: string | null; cancelReason: string | null; holdExpiresAt: string | null;
  client: { id: string; name: string; email: string; phone: string | null };
  service: Service; payments: Payment[];
  series: { id: string; intervalDays: number } | null;
}
/** Cliente que ocupa una hora (solo lo recibe el administrador). */
export interface Owner { appointmentId: string; clientId: string; clientName: string }
export interface Slot { start: string; end: string; available: boolean; reason?: string; bookedBy?: Owner[] }
export interface TimeRange { start: string; end: string }
export interface PaymentMethod { id: string; label: string; online: boolean; config: Record<string, string> }
export interface PublicConfig {
  shop: { name: string; phone: string; email: string; address: string };
  timezone: string; currency: string; slotMinutes: number; bookingHorizonDays: number;
  clientCancelMinNoticeMinutes: number; weeklySchedule: Record<string, TimeRange[]>;
  recurring: { enabled: boolean; maxAppointments: number };
  services: Service[]; paymentMethods: PaymentMethod[];
}
export interface Settings {
  shopName: string; shopPhone: string; shopEmail: string; shopAddress: string; timezone: string; currency: string;
  slotMinutes: number; capacity: number; bookingHorizonDays: number; clientCancelMinNoticeMinutes: number;
  paymentHoldMinutes: number; recurringEnabled: boolean; recurringMaxAppointments: number; weeklySchedule: Record<string, TimeRange[]>; paymentMethods: Record<string, { enabled: boolean }>;
}

export interface Occurrence { requested: string; start: string | null; status: 'OK' | 'MOVED' | 'UNAVAILABLE'; reason?: string; bookedBy?: Owner[] }
export interface SeriesResult {
  series: { id: string; intervalDays: number };
  appointments: Appointment[]; totalCents: number; pendingPayment: boolean;
}
