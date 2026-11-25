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

/** Recordatorios automáticos antes de cada cita. */
export const remindersSchema = z.object({
  enabled: z.boolean().default(false),
  email: z.boolean().default(true),
  whatsapp: z.boolean().default(false),
  /** Antelaciones en minutos (p. ej. 1440 = 1 día). Como mucho 3. */
  offsetsMinutes: z.array(z.number().int().min(15, 'La antelación mínima es de 15 minutos').max(30 * 1440, 'La antelación máxima es de 30 días'))
    .min(1, 'Indica al menos una antelación').max(3, 'Como mucho 3 avisos por cita').default([1440]),
  emailSubject: z.string().trim().min(1).max(150).default('Recordatorio de tu cita en {peluqueria}'),
  emailBody: z.string().trim().min(1).max(2000).default(
    'Hola {nombre},\n\nTe recordamos tu cita en {peluqueria} el {fecha} a las {hora} ({servicio}).\n\nTe esperamos en {direccion}. Si no puedes venir, cancélala desde la app o llámanos al {telefono}.',
  ),
  whatsappBody: z.string().trim().min(1).max(1000).default(
    'Hola {nombre}, te recordamos tu cita en {peluqueria} el {fecha} a las {hora} ({servicio}). Si no puedes venir, avísanos al {telefono}.',
  ),
  /** Plantilla aprobada en Meta (obligatoria para escribir a quien no ha escrito en las últimas 24 h). */
  whatsappTemplate: z.string().trim().max(100).default(''),
  whatsappTemplateLang: z.string().trim().max(10).default('es'),
  /** Pide al cliente que confirme su asistencia (enlace en el email, botones Sí / No en WhatsApp). */
  askConfirmation: z.boolean().default(true),
  confirmQuestion: z.string().trim().min(1).max(200).default('Confirme su asistencia contestando a la pregunta: ¿vendrá a su cita?'),
});
export type ReminderSettings = z.infer<typeof remindersSchema>;

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
  /** Permite a los clientes reservar varias citas periódicas a la vez. */
  recurringEnabled: z.boolean().default(true),
  /** Máximo de citas en una misma serie periódica. */
  recurringMaxAppointments: z.number().int().min(2).max(200).default(60),
  /** Horario semanal. Claves 1 (lunes) .. 7 (domingo), formato ISO. */
  weeklySchedule: z.record(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.array(rangeSchema)),
  /** Datos fiscales que aparecen en los tickets. */
  ticketLegalName: z.string().default(''),
  ticketTaxId: z.string().default(''),
  /** IVA incluido en los precios (%). 0 = no se desglosa. */
  ticketVatPercent: z.number().min(0).max(100).default(21),
  ticketFooter: z.string().max(300).default('Gracias por su visita'),
  reminders: remindersSchema.default({}),
  /** Avisar por email a quien está en lista de espera cuando se libera una hora. */
  waitlistEmail: z.boolean().default(true),
  /** Métodos de pago activos. La clave es el id del proveedor. */
  paymentMethods: z.record(z.string(), z.object({ enabled: z.boolean() })),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = {
  shopName: 'Peluquería Armando',
  shopPhone: '627978973',
  shopEmail: '',
  shopAddress: 'Calle Matilde Conesa 10, 24400, Ponferrada',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
  slotMinutes: 30,
  capacity: 1,
  bookingHorizonDays: 365,
  clientCancelMinNoticeMinutes: 60,
  paymentHoldMinutes: 15,
  recurringEnabled: true,
  recurringMaxAppointments: 60,
  ticketLegalName: '',
  ticketTaxId: '',
  ticketVatPercent: 21,
  ticketFooter: 'Gracias por su visita',
  weeklySchedule: {
    '1': twoShifts,
    '2': twoShifts,
    '3': twoShifts,
    '4': twoShifts,
    '5': twoShifts,
    '6': [], // sábado cerrado
    '7': [],
  },
  reminders: remindersSchema.parse({}),
  waitlistEmail: true,
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
