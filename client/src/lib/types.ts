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
}
export interface Slot { start: string; end: string; available: boolean; reason?: string }
export interface TimeRange { start: string; end: string }
export interface PaymentMethod { id: string; label: string; online: boolean; config: Record<string, string> }
export interface PublicConfig {
  shop: { name: string; phone: string; email: string; address: string };
  timezone: string; currency: string; slotMinutes: number; bookingHorizonDays: number;
  clientCancelMinNoticeMinutes: number; weeklySchedule: Record<string, TimeRange[]>;
  services: Service[]; paymentMethods: PaymentMethod[];
}
export interface Settings {
  shopName: string; shopPhone: string; shopEmail: string; shopAddress: string; timezone: string; currency: string;
  slotMinutes: number; capacity: number; bookingHorizonDays: number; clientCancelMinNoticeMinutes: number;
  paymentHoldMinutes: number; weeklySchedule: Record<string, TimeRange[]>; paymentMethods: Record<string, { enabled: boolean }>;
}
