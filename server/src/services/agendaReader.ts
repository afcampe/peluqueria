import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';

/**
 * Lectura de una foto de la agenda en papel con Claude (visión).
 * Devuelve los días que aparecen en la foto y, por cada uno, las citas
 * apuntadas a mano (hora y nombre). Nada se guarda sin que el
 * administrador lo revise después.
 */

export const MODEL = 'claude-opus-5-5';

export interface ReadEntry { time: string | null; name: string; service: string | null; crossedOut: boolean; uncertain: boolean; note: string | null }
export interface ReadDay { day: number | null; month: number | null; year: number | null; weekday: number | null; entries: ReadEntry[] }
export interface ReadResult { days: ReadDay[] }

export type AgendaReader = (image: { data: Buffer; mime: string }, ctx: { services: string[]; today: string }) => Promise<ReadResult>;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['days'],
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'month', 'year', 'weekday', 'entries'],
        properties: {
          day: nullable({ type: 'integer' }),
          month: nullable({ type: 'integer' }),
          year: nullable({ type: 'integer' }),
          weekday: nullable({ type: 'integer' }),
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['time', 'name', 'service', 'crossed_out', 'uncertain', 'note'],
              properties: {
                time: nullable({ type: 'string' }),
                name: { type: 'string' },
                service: nullable({ type: 'string' }),
                crossed_out: { type: 'boolean' },
                uncertain: { type: 'boolean' },
                note: nullable({ type: 'string' }),
              },
            },
          },
        },
      },
    },
  },
} as const;

// Validación de lo que devuelve el modelo antes de usarlo.
const parsedSchema = z.object({
  days: z.array(z.object({
    day: z.number().int().nullable(),
    month: z.number().int().nullable(),
    year: z.number().int().nullable(),
    weekday: z.number().int().nullable(),
    entries: z.array(z.object({
      time: z.string().nullable(),
      name: z.string(),
      service: z.string().nullable(),
      crossed_out: z.boolean(),
      uncertain: z.boolean(),
      note: z.string().nullable(),
    })),
  })),
});

const SYSTEM = `Lees fotos de la agenda en papel de una peluquería de Ponferrada (España), escrita a mano, para pasar las citas a una aplicación de reservas.

Cada foto suele mostrar una o dos páginas; cada página corresponde a un día y lleva la fecha impresa (día, mes y a menudo el día de la semana). En cada página hay horas y, junto a ellas, el nombre del cliente apuntado a mano. Normalmente solo se apunta el nombre y la hora.

Para cada día visible en la foto devuelve:
- day, month y year de la fecha impresa (year en null si no aparece), y weekday (1 = lunes ... 7 = domingo) si está impreso o escrito; null si no se ve.
- entries: una por cada cita apuntada, en el orden de la página.
  - time: la hora de la cita en formato HH:MM de 24 horas. Si la hora se deduce por la fila de la página en la que está escrito el nombre, úsala. Las horas de tarde pueden estar escritas como "4" o "4:30"; conviértelas a 16:00 o 16:30 cuando por el contexto sea claramente por la tarde. null si no se puede saber.
  - name: el nombre tal como está escrito (corrige solo mayúsculas). No inventes apellidos.
  - service: solo si hay alguna anotación del servicio; elige el nombre exacto de la lista de servicios que te paso. null si no hay anotación.
  - crossed_out: true si la cita está tachada o anulada.
  - uncertain: true si no estás seguro de haber leído bien el nombre, la hora o la fecha.
  - note: cualquier otra anotación junto a la cita (por ejemplo un teléfono o "llamar"), o null.

No incluyas filas vacías, garabatos ni anotaciones que no sean citas. Si la foto no es una página de agenda, devuelve days vacío.`;

let client: Anthropic | null = null;

/** Lector real con la API de Claude. */
export const claudeReader: AgendaReader = async (image, ctx) => {
  if (!config.anthropicConfigured) {
    throw new HttpError(503, 'La lectura automática no está configurada: falta ANTHROPIC_API_KEY en server/.env', 'READER_NOT_CONFIGURED');
  }
  client ??= new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Si un filtro de seguridad rechazara la petición, se reintenta con el modelo alternativo.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: outputSchema } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mime as 'image/jpeg', data: image.data.toString('base64') } },
        { type: 'text', text: `Hoy es ${ctx.today}. Servicios de la peluquería: ${ctx.services.join(', ')}.\nExtrae las citas de esta foto.` },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('El modelo no ha podido leer esta foto');
  if (response.stop_reason === 'max_tokens') throw new Error('La foto tiene demasiadas citas para leerla de una vez; prueba con una foto por página');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error('La respuesta de la lectura no es válida'); }
  const r = parsedSchema.parse(json);
  return {
    days: r.days.map((d) => ({
      ...d,
      entries: d.entries.map((e) => ({ time: e.time, name: e.name, service: e.service, crossedOut: e.crossed_out, uncertain: e.uncertain, note: e.note })),
    })),
  };
};

let reader: AgendaReader = claudeReader;
export const getAgendaReader = () => reader;
/** Para los tests: sustituye la lectura real por una simulada. */
export const setAgendaReader = (r: AgendaReader) => { reader = r; };
