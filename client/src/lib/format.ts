import type { Appointment, AppointmentStatus } from './types';

const TZ = 'Europe/Madrid';
let tz = TZ;
let currency = 'EUR';
/** Teléfono y email de un cliente; las fichas sin cuenta no tienen email. */
export const contactLine = (u: { phone: string | null; email: string | null }) =>
  [u.phone, u.email].filter(Boolean).join(' · ') || 'sin teléfono ni email';

export const setLocaleConfig = (t: string, c: string) => { tz = t; currency = c; };

export const money = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
export const time = (iso: string) => new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const dateLong = (iso: string) =>
  capitalize(new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso)));
export const dateShort = (iso: string) =>
  capitalize(new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso)));
export const dateTime = (iso: string) => `${dateLong(iso)}, ${time(iso)}`;

/** Fecha de hoy (o +n días) en la zona de la peluquería, formato YYYY-MM-DD. */
export const localISODate = (d = new Date(), plusDays = 0) => {
  const x = new Date(d.getTime() + plusDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
};
export const isoToLocalDate = (iso: string) => localISODate(new Date(iso));

export const statusLabel: Record<string, string> = {
  PENDING_PAYMENT: 'Pendiente de pago',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Cancelada',
  COMPLETED: 'Realizada',
  NO_SHOW: 'No se presentó',
};
/** Estado que se muestra: una cita confirmada cuya hora ya ha pasado se ve como realizada. */
export const shownStatus = (a: Pick<Appointment, 'status' | 'endAt'>): AppointmentStatus =>
  a.status === 'CONFIRMED' && new Date(a.endAt).getTime() <= Date.now() ? 'COMPLETED' : a.status;
export const methodLabel = (id: string) => ({ cash: 'Efectivo', paypal: 'PayPal' })[id] ?? id;
export const weekdayNames: Record<string, string> = { '1': 'Lunes', '2': 'Martes', '3': 'Miércoles', '4': 'Jueves', '5': 'Viernes', '6': 'Sábado', '7': 'Domingo' };

export const canClientChange = (startAt: string, minNotice: number) => new Date(startAt).getTime() - Date.now() >= minNotice * 60_000;
export const noticeText = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);

// ---- Fechas de calendario "YYYY-MM-DD" (aritmética sin zona horaria)
const fromYMD = (d: string) => new Date(`${d}T12:00:00Z`);
const toYMD = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => { const x = fromYMD(d); x.setUTCDate(x.getUTCDate() + n); return toYMD(x); };
export const addMonths = (d: string, n: number) => { const x = fromYMD(`${d.slice(0, 7)}-01`); x.setUTCMonth(x.getUTCMonth() + n); return toYMD(x); };
/** 1 = lunes … 7 = domingo */
export const isoWeekday = (d: string) => fromYMD(d).getUTCDay() || 7;
export const startOfWeek = (d: string) => addDays(d, 1 - isoWeekday(d));
export const startOfMonth = (d: string) => `${d.slice(0, 7)}-01`;
export const monthLabel = (d: string) =>
  capitalize(new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(fromYMD(d)));
export const weekLabel = (start: string) => {
  const end = addDays(start, 6);
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', ...o }).format(fromYMD(d));
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${f(start, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${f(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

export const waitPartLabel = { ANY: 'todo el día', MORNING: 'por la mañana', AFTERNOON: 'por la tarde' };
