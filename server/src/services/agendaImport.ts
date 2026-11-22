import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { prisma } from '../lib/db.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { getAgendaReader, type ReadDay, type ReadResult } from './agendaReader.js';
import { createAppointment, type Actor } from './appointments.js';
import { getSettings } from './settings.js';

/**
 * Importación de la agenda en papel:
 * foto → lectura automática (cola en segundo plano) → revisión del
 * administrador → creación de las citas. Solo se importan citas futuras.
 */

export interface ImportRow {
  key: string;
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM
  name: string;
  serviceId: string | null;
  /** Cliente existente al que se asigna; null = crear una ficha nueva sin cuenta con `name`. */
  clientId: string | null;
  include: boolean;
  uncertain: boolean;
  crossedOut: boolean;
  note: string | null;
  result?: { status: 'imported' | 'error'; message?: string; appointmentId?: string };
}

const MIME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_BYTES = 8 * 1024 * 1024;

export const normalizeName = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

export const parseRows = (json: string): ImportRow[] => { try { return JSON.parse(json) as ImportRow[]; } catch { return []; } };

// ---------------------------------------------------------------- Subida

export async function createImport(input: { image: string; fileName?: string }, adminId: string) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(input.image);
  if (!m) throw badRequest('La foto debe ser JPG, PNG o WebP');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_BYTES) throw badRequest('La foto es demasiado grande (máx. 8 MB)');
  const rel = `${randomUUID()}.${MIME_EXT[m[1]]}`;
  await fs.mkdir(config.importDir, { recursive: true });
  await fs.writeFile(path.join(config.importDir, rel), data);
  const item = await prisma.agendaImport.create({
    data: { fileName: input.fileName?.slice(0, 200), imagePath: rel, imageMime: m[1], createdBy: adminId },
  });
  kickImportQueue();
  return item;
}

export async function readImportImage(id: string) {
  const item = await prisma.agendaImport.findUniqueOrThrow({ where: { id } });
  if (!item.imagePath) throw new HttpError(410, 'La foto ya se ha borrado porque la página está importada');
  return { data: await fs.readFile(path.join(config.importDir, item.imagePath)), mime: item.imageMime ?? 'image/jpeg' };
}

async function deleteImage(imagePath: string | null) {
  if (imagePath) await fs.rm(path.join(config.importDir, imagePath), { force: true });
}

export async function discardImport(id: string) {
  const item = await prisma.agendaImport.findUniqueOrThrow({ where: { id } });
  await deleteImage(item.imagePath);
  await prisma.agendaImport.delete({ where: { id } });
}

// ---------------------------------------------------------------- Lectura (cola)

let running: Promise<void> | null = null;

/** Procesa en segundo plano las fotos pendientes, de una en una. */
export function kickImportQueue(): Promise<void> {
  running ??= (async () => {
    try {
      for (;;) {
        const next = await prisma.agendaImport.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
        if (!next) break;
        await processImport(next.id);
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Al arrancar: las lecturas que quedaron a medias vuelven a la cola. */
export async function resumeImportQueue() {
  await prisma.agendaImport.updateMany({ where: { status: 'READING' }, data: { status: 'PENDING' } });
  kickImportQueue().catch((e) => console.error('[importación]', e));
}

function readerError(e: unknown) {
  if (e instanceof HttpError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return 'La clave de la API de Claude no es válida (ANTHROPIC_API_KEY)';
  if (e instanceof Anthropic.RateLimitError) return 'Demasiadas lecturas seguidas. Vuelve a intentarlo en unos minutos.';
  if (e instanceof Anthropic.APIConnectionError) return 'No hay conexión con el servicio de lectura. Vuelve a intentarlo.';
  if (e instanceof Anthropic.APIError) return `El servicio de lectura ha fallado (${e.status ?? 'sin código'}). Vuelve a intentarlo.`;
  return e instanceof Error ? e.message : 'No se ha podido leer la foto';
}

async function processImport(id: string) {
  const item = await prisma.agendaImport.update({ where: { id }, data: { status: 'READING', error: null } });
  try {
    const [services, settings] = await Promise.all([
      prisma.service.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      getSettings(),
    ]);
    const today = DateTime.now().setZone(settings.timezone).startOf('day');
    const image = await readImportImage(id);
    const result = await getAgendaReader()(image, { services: services.map((s) => s.name), today: today.toISODate()! });
    const rows = await rowsFromReading(result, services, today);
    await prisma.agendaImport.update({ where: { id: item.id }, data: { status: 'READY', rows: JSON.stringify(rows) } });
  } catch (e) {
    await prisma.agendaImport.update({ where: { id: item.id }, data: { status: 'ERROR', error: readerError(e) } });
  }
}

/** Año de una fecha sin año: el más cercano que no quede atrás (y que cuadre con el día de la semana si se ve). */
export function inferDate(d: Pick<ReadDay, 'day' | 'month' | 'year' | 'weekday'>, today: DateTime): string | null {
  if (!d.day || !d.month) return null;
  const build = (y: number) => DateTime.fromObject({ year: y, month: d.month!, day: d.day! }, { zone: today.zone });
  if (d.year) { const x = build(d.year < 100 ? 2000 + d.year : d.year); return x.isValid ? x.toISODate() : null; }
  const candidates = [today.year - 1, today.year, today.year + 1].map(build).filter((x) => x.isValid);
  const matching = d.weekday ? candidates.filter((x) => x.weekday === d.weekday) : candidates;
  const pool = matching.length ? matching : candidates;
  // Se acepta hasta un mes atrás (páginas de días recién pasados); si no, la próxima.
  const pick = pool.find((x) => x >= today.minus({ days: 31 })) ?? pool.at(-1);
  return pick?.toISODate() ?? null;
}

const TIME = /^(\d{1,2})[:.h]?(\d{2})?$/;
export function normalizeTime(t: string | null): string | null {
  const m = t ? TIME.exec(t.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

async function rowsFromReading(r: ReadResult, services: { id: string; name: string }[], today: DateTime): Promise<ImportRow[]> {
  const defaultService = services[0]?.id ?? null;
  const byName = new Map(services.map((s) => [normalizeName(s.name), s.id]));
  const candidates = await clientCandidates(r.days.flatMap((d) => d.entries.map((e) => e.name)));
  const todayIso = today.toISODate()!;
  return r.days.flatMap((d) => {
    const date = inferDate(d, today);
    return d.entries.filter((e) => e.name.trim()).map((e): ImportRow => {
      const time = normalizeTime(e.time);
      const matches = candidates.get(normalizeName(e.name)) ?? [];
      return {
        key: randomUUID(),
        date,
        time,
        name: e.name.trim().slice(0, 80),
        serviceId: (e.service && byName.get(normalizeName(e.service))) ?? defaultService,
        // Solo se asigna solo si hay un único cliente con ese nombre completo; "Luis" no se asigna a "Luis Ortega".
        clientId: (() => { const exact = matches.filter((c) => normalizeName(c.name) === normalizeName(e.name)); return exact.length === 1 ? exact[0].id : null; })(),
        // Las pasadas y las tachadas no se importan (el histórico no hace falta).
        include: Boolean(date && time && date >= todayIso && !e.crossedOut),
        uncertain: e.uncertain || !date || !time,
        crossedOut: e.crossedOut,
        note: e.note?.slice(0, 200) ?? null,
      };
    });
  });
}

// ---------------------------------------------------------------- Clientes

export interface Candidate { id: string; name: string; phone: string | null; email: string | null }

/** Clientes cuyo nombre coincide (sin tildes ni mayúsculas) con cada nombre leído. */
export async function clientCandidates(names: string[]): Promise<Map<string, Candidate[]>> {
  const wanted = new Set(names.map(normalizeName).filter(Boolean));
  const out = new Map<string, Candidate[]>();
  if (!wanted.size) return out;
  const clients = await prisma.user.findMany({
    where: { role: 'CLIENT', status: { not: 'DELETED' } },
    select: { id: true, name: true, phone: true, email: true },
  });
  for (const c of clients) {
    const n = normalizeName(c.name);
    // Coincide el nombre completo o el nombre apuntado es el principio del de la ficha ("Juan" → "Juan Pérez").
    for (const w of wanted) {
      if (n === w || n.startsWith(`${w} `)) {
        const list = out.get(w) ?? [];
        list.push(c);
        out.set(w, list);
      }
    }
  }
  // Primero las coincidencias exactas.
  for (const [w, list] of out) list.sort((a, b) => Number(normalizeName(b.name) === w) - Number(normalizeName(a.name) === w) || a.name.localeCompare(b.name));
  return out;
}

export async function importDetail(id: string) {
  const item = await prisma.agendaImport.findUniqueOrThrow({ where: { id } });
  const rows = parseRows(item.rows);
  const candidates = await clientCandidates(rows.map((r) => r.name));
  // Clientes ya elegidos que no salen como candidatos (elegidos a mano con el buscador).
  const chosen = rows.map((r) => r.clientId).filter((x): x is string => !!x);
  const chosenClients = chosen.length
    ? await prisma.user.findMany({ where: { id: { in: chosen } }, select: { id: true, name: true, phone: true, email: true } })
    : [];
  const { imagePath: _p, ...rest } = item;
  return { ...summary(item), ...rest, hasImage: !!item.imagePath, rows, candidates: Object.fromEntries(candidates), chosenClients };
}

export function summary(item: { id: string; rows: string; status: string }) {
  const rows = parseRows(item.rows);
  return {
    total: rows.length,
    included: rows.filter((r) => r.include).length,
    imported: rows.filter((r) => r.result?.status === 'imported').length,
    failed: rows.filter((r) => r.include && r.result?.status === 'error').length,
    uncertain: rows.filter((r) => r.include && r.uncertain && r.result?.status !== 'imported').length,
    dates: [...new Set(rows.map((r) => r.date).filter(Boolean))].sort() as string[],
  };
}

// ---------------------------------------------------------------- Revisión e importación

/** Guarda las correcciones del administrador sin tocar las filas ya importadas. */
export async function saveRows(id: string, edited: ImportRow[]) {
  const item = await prisma.agendaImport.findUniqueOrThrow({ where: { id } });
  if (item.status === 'PENDING' || item.status === 'READING') throw badRequest('Espera a que termine la lectura de la foto');
  const before = new Map(parseRows(item.rows).map((r) => [r.key, r]));
  const rows = edited.map((r) => {
    const prev = before.get(r.key);
    if (prev?.result?.status === 'imported') return prev; // no se edita lo ya importado
    return { ...r, time: normalizeTime(r.time), name: r.name.trim().slice(0, 80), result: prev?.result?.status === 'error' ? prev.result : undefined };
  });
  // Si antes había filas importadas que ahora no vienen, se conservan.
  for (const prev of before.values()) if (prev.result?.status === 'imported' && !rows.some((r) => r.key === prev.key)) rows.push(prev);
  return prisma.agendaImport.update({ where: { id }, data: { rows: JSON.stringify(rows), status: item.status === 'ERROR' ? 'READY' : item.status } });
}

export async function commitImport(id: string, actor: Actor, edited?: ImportRow[]) {
  if (edited) await saveRows(id, edited);
  const item = await prisma.agendaImport.findUniqueOrThrow({ where: { id } });
  if (item.status === 'IMPORTED') throw badRequest('Esta página ya está importada');
  const settings = await getSettings();
  const rows = parseRows(item.rows);
  const newClients = new Map<string, string>(); // nombre normalizado → id de la ficha creada ahora

  for (const row of rows) {
    if (!row.include || row.result?.status === 'imported') continue;
    let createdNow: string | null = null;
    try {
      if (!row.date || !row.time) throw badRequest('Falta la fecha o la hora');
      if (!row.name.trim()) throw badRequest('Falta el nombre');
      if (!row.serviceId) throw badRequest('Elige el servicio');
      const start = DateTime.fromISO(`${row.date}T${row.time}`, { zone: settings.timezone });
      if (!start.isValid) throw badRequest('Fecha u hora no válidas');
      if (start < DateTime.now()) throw badRequest('Esa hora ya ha pasado (solo se importan citas futuras)');

      // Página fotografiada dos veces: si la cita ya está en la agenda, no se duplica.
      const existing = await prisma.appointment.findFirst({
        where: { startAt: start.toJSDate(), status: { not: 'CANCELLED' } },
        include: { client: { select: { id: true, name: true } } },
      });
      if (existing && (existing.clientId === row.clientId || normalizeName(existing.client.name) === normalizeName(row.name))) {
        row.clientId = existing.clientId;
        row.result = { status: 'imported', appointmentId: existing.id, message: 'Ya estaba en la agenda' };
        continue;
      }

      let clientId = row.clientId;
      if (!clientId) {
        const key = normalizeName(row.name);
        clientId = newClients.get(key) ?? null;
        if (!clientId) {
          // Ficha sin cuenta. Si dos filas de esta página tienen el mismo nombre, se usa la misma ficha.
          const created = await prisma.user.create({ data: { name: row.name.trim(), acceptsEmail: false } });
          clientId = createdNow = created.id;
          newClients.set(key, clientId);
        }
      }
      const a = await createAppointment(actor, {
        clientId, serviceId: row.serviceId, startAt: start.toUTC().toISO()!, paymentMethod: 'cash',
        notes: row.note ? `Agenda en papel: ${row.note}` : 'Importada de la agenda en papel',
      }, { ignoreHorizon: true, notify: false });
      row.clientId = clientId;
      row.result = { status: 'imported', appointmentId: a.id };
    } catch (err) {
      let e = err;
      if (err instanceof HttpError && err.code === 'INVALID_SLOT' && row.time) {
        // Hora fuera de la rejilla de citas (p. ej. 17:10 con citas cada 30 min): se proponen las cercanas.
        const [h, m] = row.time.split(':').map(Number);
        const step = settings.slotMinutes;
        const down = Math.floor((h * 60 + m) / step) * step;
        const hhmm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
        e = new Error((h * 60 + m) % step
          ? `Las citas van cada ${step} min: usa ${hhmm(down)} o ${hhmm(down + step)}`
          : 'Esa hora está fuera del horario de la peluquería');
      }
      // No se deja una ficha vacía si su primera cita no se ha podido crear.
      if (createdNow) {
        await prisma.user.delete({ where: { id: createdNow } }).catch(() => {});
        newClients.delete(normalizeName(row.name));
      }
      row.result = { status: 'error', message: e instanceof Error ? e.message : 'Error al importar' };
    }
  }

  const pending = rows.filter((r) => r.include && r.result?.status !== 'imported').length;
  const imported = rows.filter((r) => r.result?.status === 'imported').length;
  const done = pending === 0;
  // Con todo importado la foto ya no hace falta: se borra (contiene datos personales).
  if (done) await deleteImage(item.imagePath);
  await prisma.agendaImport.update({
    where: { id },
    data: {
      rows: JSON.stringify(rows), importedCount: imported,
      ...(done && { status: 'IMPORTED', importedAt: new Date(), imagePath: null }),
    },
  });
  return { imported, failed: pending, done };
}

/** Une una ficha sin cuenta con un cliente registrado: le pasa sus citas y borra la ficha. */
export async function mergeClient(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw badRequest('Elige otro cliente');
  const [source, target] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: sourceId } }),
    prisma.user.findUniqueOrThrow({ where: { id: targetId } }),
  ]);
  if (source.email) throw badRequest('Solo se pueden unir fichas sin cuenta (sin email)');
  if (target.role !== 'CLIENT' || target.status === 'DELETED') throw badRequest('El cliente de destino no es válido');
  const moved = await prisma.$transaction(async (tx) => {
    const r = await tx.appointment.updateMany({ where: { clientId: sourceId }, data: { clientId: targetId } });
    await tx.appointmentSeries.updateMany({ where: { clientId: sourceId }, data: { clientId: targetId } });
    await tx.ticket.updateMany({ where: { clientId: sourceId }, data: { clientId: targetId } });
    await tx.user.update({
      where: { id: targetId },
      data: { ...(!target.phone && source.phone && { phone: source.phone }) },
    });
    await tx.user.delete({ where: { id: sourceId } });
    return r.count;
  });
  return { moved };
}
