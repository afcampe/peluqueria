import { z } from 'zod';
import { prisma } from '../lib/db.js';

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
const rangeSchema = z
  .object({ start: z.string().regex(timeRe), end: z.string().regex(timeRe) })
  .refine((r) => r.start < r.end, { message: 'La hora de inicio debe ser anterior a la de fin' });

const twoShifts = [
  { start: '09:00', end: '13:00' },
  { start: '16:00', end: '20:00' },
];

export const settingsSchema = z.object({
  shopName: z.string().min(1),
  shopPhone: z.string().default(''),
  shopEmail: z.string().default(''),
  shopAddress: z.string().default(''),
  timezone: z.string().default('Europe/Madrid'),
  currency: z.string().length(3).default('EUR'),
  /** Duración de cada hueco de cita en minutos. */
  slotMinutes: z.number().int().min(5).max(240),
  /** Citas simultáneas por hueco (nº de peluqueros/sillones). */
  capacity: z.number().int().min(1).max(50),
  /** Cuántos días hacia adelante se puede reservar. */
  bookingHorizonDays: z.number().int().min(1).max(730),
  /** Antelación mínima (minutos) para que un cliente cancele o modifique. */
  clientCancelMinNoticeMinutes: z.number().int().min(0),
  /** Minutos que se guarda el hueco mientras el cliente paga online. */
  paymentHoldMinutes: z.number().int().min(5).max(120),
  /** Horario semanal. Claves 1 (lunes) .. 7 (domingo), formato ISO. */
  weeklySchedule: z.record(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.array(rangeSchema)),
  /** Métodos de pago activos. La clave es el id del proveedor. */
  paymentMethods: z.record(z.string(), z.object({ enabled: z.boolean() })),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  shopName: 'Peluquería Armando',
  shopPhone: '',
  shopEmail: '',
  shopAddress: '',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
  slotMinutes: 30,
  capacity: 1,
  bookingHorizonDays: 365,
  clientCancelMinNoticeMinutes: 60,
  paymentHoldMinutes: 15,
  weeklySchedule: {
    '1': twoShifts,
    '2': twoShifts,
    '3': twoShifts,
    '4': twoShifts,
    '5': twoShifts,
    '6': twoShifts,
    '7': [],
  },
  paymentMethods: { cash: { enabled: true }, paypal: { enabled: true } },
};

const KEY = 'business';

export async function getSettings(): Promise<Settings> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  if (!row) return defaultSettings;
  // Se mezcla con los valores por defecto para que nuevas opciones tengan valor.
  return settingsSchema.parse({ ...defaultSettings, ...JSON.parse(row.value) });
}

export async function saveSettings(input: unknown): Promise<Settings> {
  const current = await getSettings();
  const next = settingsSchema.parse({ ...current, ...(input as object) });
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}
