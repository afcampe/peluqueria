const TZ = 'Europe/Madrid';
let tz = TZ;
let currency = 'EUR';
export const setLocaleConfig = (t: string, c: string) => { tz = t; currency = c; };

export const money = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
export const time = (iso: string) => new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const dateLong = (iso: string) =>
  new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
export const dateShort = (iso: string) =>
  new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
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
export const methodLabel = (id: string) => ({ cash: 'Efectivo', paypal: 'PayPal' })[id] ?? id;
export const weekdayNames: Record<string, string> = { '1': 'Lunes', '2': 'Martes', '3': 'Miércoles', '4': 'Jueves', '5': 'Viernes', '6': 'Sábado', '7': 'Domingo' };

export const canClientChange = (startAt: string, minNotice: number) => new Date(startAt).getTime() - Date.now() >= minNotice * 60_000;
export const noticeText = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);
