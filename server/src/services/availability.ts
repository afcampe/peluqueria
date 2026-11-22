import { DateTime } from 'luxon';
import type { Settings } from './settings.js';

export interface Interval {
  startAt: Date;
  endAt: Date;
}

export interface Slot {
  start: string; // ISO UTC
  end: string;
  available: boolean;
  reason?: 'PAST' | 'BOOKED' | 'CLOSED' | 'OUT_OF_RANGE';
}

const overlaps = (aStart: number, aEnd: number, b: Interval) =>
  aStart < b.endAt.getTime() && b.startAt.getTime() < aEnd;

type AvailabilitySettings = Pick<Settings, 'timezone' | 'slotMinutes' | 'capacity' | 'bookingHorizonDays' | 'weeklySchedule'>;

/**
 * Genera los huecos de un día (fecha local de la peluquería, "YYYY-MM-DD")
 * a partir del horario semanal, descontando citas ocupadas y cierres.
 * Función pura: no accede a la base de datos para poder testearla.
 */
export function computeSlots(params: {
  date: string;
  settings: AvailabilitySettings;
  appointments: Interval[];
  closures: Interval[];
  now?: Date;
}): Slot[] {
  const { date, settings, appointments, closures } = params;
  const now = params.now ?? new Date();
  const day = DateTime.fromISO(date, { zone: settings.timezone });
  if (!day.isValid) return [];

  const ranges = settings.weeklySchedule[String(day.weekday) as keyof Settings['weeklySchedule']] ?? [];
  const horizonEnd = DateTime.fromJSDate(now).setZone(settings.timezone).endOf('day').plus({ days: settings.bookingHorizonDays });
  const slots: Slot[] = [];

  for (const range of ranges) {
    const [sh, sm] = range.start.split(':').map(Number);
    const [eh, em] = range.end.split(':').map(Number);
    let cursor = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
    const rangeEnd = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

    while (cursor.plus({ minutes: settings.slotMinutes }) <= rangeEnd) {
      const end = cursor.plus({ minutes: settings.slotMinutes });
      const s = cursor.toMillis();
      const e = end.toMillis();
      let reason: Slot['reason'];
      if (s <= now.getTime()) reason = 'PAST';
      else if (cursor > horizonEnd) reason = 'OUT_OF_RANGE';
      else if (closures.some((c) => overlaps(s, e, c))) reason = 'CLOSED';
      else if (appointments.filter((a) => overlaps(s, e, a)).length >= settings.capacity) reason = 'BOOKED';

      slots.push({ start: cursor.toUTC().toISO()!, end: end.toUTC().toISO()!, available: !reason, ...(reason && { reason }) });
      cursor = end;
    }
  }
  return slots;
}

/** Fecha local (YYYY-MM-DD) de un instante, en la zona horaria de la peluquería. */
export const localDate = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz).toISODate()!;
